import { deepEqual, equal } from "node:assert/strict"
import { MAX_REVIEW_FILES, ReviewStore, reviewDocument } from "../review"

describe("native diff review boundary", () => {
  it("projects bounded opaque metadata without patch contents", () => {
    const keys = keyFactory()
    const store = new ReviewStore(keys)
    store.upsert(message([diff("src/session.ts", 20, 8, patch("old\n", "new\n"))]))
    const review = store.snapshot()[0]!
    equal(review.files[0]?.path, "src/session.ts")
    equal(review.files[0]?.additions, 20)
    equal(JSON.stringify(review).includes("old"), false)
    equal(JSON.stringify(review).includes("patch"), false)
    deepEqual(store.resolve(review.key, review.files[0]!.key), {
      messageID: "message-review",
      kind: "diff",
      path: "src/session.ts",
    })
  })

  it("combines official diffs with bounded paths from completed edit tools", () => {
    const store = new ReviewStore(keyFactory())
    store.upsert(message([
      diff("src/a.ts", 2, 1, patch("old\n", "new\n")),
      diff("src/generated.ts", 1, 0, patch("", "generated\n")),
    ]), ["src/a.ts", "src/unreviewable.ts", "../outside"])
    const review = store.snapshot()[0]!
    equal(review.attribution, "mixed")
    equal(review.files[0]!.provenance, "direct")
    equal(review.files[1]!.provenance, "snapshot")
    equal(review.files[2]!.path, "src/unreviewable.ts")
    equal(review.files[2]!.reviewable, false)
    deepEqual(store.resolve(review.key, review.files[0]!.key), {
      messageID: "message-review",
      kind: "diff",
      path: "src/a.ts",
    })
    equal(store.resolve(review.key, review.files[2]!.key), undefined)
  })

  it("does not erase an existing official review on a message update without summary data", () => {
    const store = new ReviewStore(keyFactory())
    store.upsert(message([diff("src/a.ts", 1, 0, patch("", "new\n"))]))
    store.upsert({ id: "message-review", role: "user" })
    equal(store.snapshot()[0]?.files[0]?.path, "src/a.ts")
  })

  it("disables full-file review for an authoritative binary or omitted patch", () => {
    const store = new ReviewStore(keyFactory())
    store.upsert(message([
      diff("assets/icon.bin", 1, 1, ""),
      { file: "src/partial.ts", additions: 1, deletions: 1, status: "modified", patch: "@@ -2,1 +2,1 @@\n-old\n+new\n" },
    ]), [], true)
    const review = store.snapshot()[0]!
    equal(review.files.every((file) => !file.reviewable), true)
    equal(review.files[0]!.additions, 1)
    equal(store.resolve(review.key, review.files[0]!.key), undefined)
  })

  it("rejects unsafe paths, duplicate files, counts, and excess rows", () => {
    const store = new ReviewStore(keyFactory())
    store.upsert(message([
      diff("../outside", 1, 0, patch("", "x\n")),
      diff("/absolute", 1, 0, patch("", "x\n")),
      diff("src/safe.ts", -1, 0, patch("", "x\n")),
      ...Array.from({ length: MAX_REVIEW_FILES + 10 }, (_, index) =>
        diff(`src/${index}.ts`, 1, 0, patch("", "x\n"))),
    ]))
    const files = store.snapshot()[0]!.files
    equal(files.length, MAX_REVIEW_FILES - 3)
    equal(files.every((file) => file.path.startsWith("src/")), true)
  })

  it("reconstructs exact full snapshot revisions and rejects partial or oversized patches", () => {
    deepEqual(reviewDocument(diff("src/a.ts", 1, 1, patch("one\ntwo\n", "one\nthree\n")), "src/a.ts"), {
      path: "src/a.ts",
      before: "one\ntwo\n",
      after: "one\nthree\n",
    })
    equal(reviewDocument(diff("src/a.ts", 1, 1, "@@ -2,1 +2,1 @@\n-old\n+new\n"), "src/a.ts"), undefined)
    equal(reviewDocument(diff("src/a.ts", 1, 1, "x".repeat(2_000_001)), "src/a.ts"), undefined)
    equal(reviewDocument(diff("src/a.ts", 1, 1, patch("old", "new")), "src/other.ts"), undefined)
    deepEqual(reviewDocument(diff(
      "src/no-newline.ts",
      1,
      1,
      "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    ), "src/no-newline.ts"), { path: "src/no-newline.ts", before: "old", after: "new" })
  })

  it("invalidates stale keys when the transcript is cleared", () => {
    const store = new ReviewStore(keyFactory())
    store.upsert(message([diff("src/a.ts", 1, 0, patch("", "x\n"))]))
    const review = store.snapshot()[0]!
    store.clear()
    equal(store.resolve(review.key, review.files[0]!.key), undefined)
  })
})

function message(diffs: ReturnType<typeof diff>[]) {
  return { id: "message-review", role: "user" as const, summary: { diffs } }
}

function diff(file: string, additions: number, deletions: number, value: string) {
  return { file, additions, deletions, status: "modified" as const, patch: value }
}

function patch(before: string, after: string) {
  const oldLines = before ? before.trimEnd().split("\n") : []
  const newLines = after ? after.trimEnd().split("\n") : []
  const shared = !!oldLines[0] && oldLines[0] === newLines[0]
  const common = shared ? [oldLines.shift()!] : []
  if (shared) newLines.shift()
  const body = [
    ...common.map((line) => ` ${line}`),
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n")
  return `Index: file\n===\n--- file\t\n+++ file\t\n@@ -${before ? 1 : 0},${common.length + oldLines.length} +${after ? 1 : 0},${common.length + newLines.length} @@\n${body}\n`
}

function keyFactory() {
  let value = 0
  return () => `opaque_review_key_${++value}`
}
