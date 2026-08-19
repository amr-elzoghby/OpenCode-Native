import { randomBytes } from "node:crypto"

export const MAX_REVIEW_TURNS = 40
export const MAX_REVIEW_FILES = 100
export const MAX_REVIEW_TOTAL_FILES = 500
export const MAX_REVIEW_PATCH_CHARS = 2_000_000
export const MAX_REVIEW_DOCUMENT_CHARS = 2_000_000

export type ReviewSummary = {
  key: string
  turnID: string
  attribution: "direct" | "observed" | "mixed"
  files: Array<{
    key: string
    path: string
    previousPath?: string
    additions?: number
    deletions?: number
    provenance: "direct" | "snapshot"
    reviewable: boolean
    conflicted: boolean
    overlapsDirect: boolean
  }>
}

export type FileChangeInfo = {
  id: string
  sessionID: string
  messageID: string
  file: string
  previousFile?: string
  provenance: "direct" | "snapshot"
  additions?: number
  deletions?: number
  reviewable: boolean
  conflicted: boolean
  overlapsDirect: boolean
}

export type FileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
}

type Message = {
  id: string
  role: "user" | "assistant"
  summary?: boolean | { diffs: FileDiff[] }
}

type ReviewRecord = ReviewSummary & {
  messageID: string
  targets: Map<string, { kind: "change"; changeID: string; path: string } | { kind: "diff"; path: string }>
  identities: Map<string, string>
}

export class ReviewStore {
  private records = new Map<string, ReviewRecord>()

  constructor(private createKey: () => string = () => randomBytes(18).toString("base64url")) {}

  clear() {
    this.records.clear()
  }

  remove(messageID: string) {
    this.records.delete(messageID)
  }

  upsert(message: Message) {
    if (message.role !== "user" || !safeID(message.id)) return
    const existing = this.records.get(message.id)
    const previous = new Map(existing?.files.map((file) => [file.path, file]))
    const paths = new Set<string>()
    const files = (typeof message.summary === "object" ? message.summary.diffs : []).slice(0, MAX_REVIEW_FILES).flatMap((diff) => {
      const path = safePath(diff.file)
      if (!path || paths.has(path) || !safeCount(diff.additions) || !safeCount(diff.deletions)) return []
      paths.add(path)
      return [{
        key: previous.get(path)?.key ?? this.createKey(),
        path,
        additions: diff.additions,
        deletions: diff.deletions,
        provenance: "snapshot" as const,
        reviewable: true,
        conflicted: false,
        overlapsDirect: false,
      } satisfies ReviewSummary["files"][number]]
    })
    if (!files.length) {
      this.records.delete(message.id)
      return
    }
    this.records.set(message.id, {
      key: existing?.key ?? this.createKey(),
      turnID: message.id,
      messageID: message.id,
      attribution: "observed",
      files,
      targets: new Map(files.map((file) => [file.key, { kind: "diff" as const, path: file.path }])),
      identities: new Map(),
    })
    while (this.records.size > MAX_REVIEW_TURNS) this.records.delete(this.records.keys().next().value!)
    while ([...this.records.values()].reduce((total, review) => total + review.files.length, 0) > MAX_REVIEW_TOTAL_FILES) {
      this.records.delete(this.records.keys().next().value!)
    }
  }

  snapshot(): ReviewSummary[] {
    return [...this.records.values()].map((review) => ({
      key: review.key,
      turnID: review.turnID,
      attribution: review.attribution,
      files: review.files.map((file) => ({ ...file })),
    }))
  }

  resolve(reviewKey: string, fileKey: string) {
    const review = [...this.records.values()].find((item) => item.key === reviewKey)
    const file = review?.files.find((item) => item.key === fileKey)
    if (!review || !file) return
    const target = review.targets.get(file.key)
    return target ? { messageID: review.messageID, ...target } : undefined
  }

  upsertChanges(messageID: string, changes: FileChangeInfo[], sessionID: string) {
    if (!safeID(messageID) || new Set(changes.map((change) => change.id)).size !== changes.length ||
      changes.some((change) => change.sessionID !== sessionID || change.messageID !== messageID)) return false
    const bounded = changes.slice(0, MAX_REVIEW_FILES)
    const existing = this.records.get(messageID)
    const previous = new Map([...(existing?.identities ?? [])].map(([key, id]) => [id, key]))
    const targets = new Map<string, { kind: "change"; changeID: string; path: string }>()
    const identities = new Map<string, string>()
    const files = bounded.flatMap((change) => {
      const path = safePath(change.file)
      const previousPath = change.previousFile === undefined ? undefined : safePath(change.previousFile)
      if (!path || (change.previousFile !== undefined && !previousPath) || !safeChangeID(change.id) ||
        !optionalCount(change.additions) || !optionalCount(change.deletions) ||
        (change.additions === undefined) !== (change.deletions === undefined) || typeof change.reviewable !== "boolean" ||
        typeof change.conflicted !== "boolean" || typeof change.overlapsDirect !== "boolean" ||
        !["direct", "snapshot"].includes(change.provenance)) return []
      const key = previous.get(change.id) ?? this.createKey()
      identities.set(key, change.id)
      if (change.reviewable) targets.set(key, { kind: "change", changeID: change.id, path })
      return [{
        key,
        path,
        ...(previousPath ? { previousPath } : {}),
        ...(change.additions === undefined ? {} : { additions: change.additions }),
        ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
        provenance: change.provenance,
        reviewable: change.reviewable,
        conflicted: change.conflicted,
        overlapsDirect: change.overlapsDirect,
      } satisfies ReviewSummary["files"][number]]
    })
    if (!files.length) {
      this.records.delete(messageID)
      return true
    }
    const kinds = new Set(files.map((file) => file.provenance))
    this.records.set(messageID, {
      key: existing?.key ?? this.createKey(),
      turnID: messageID,
      messageID,
      attribution: kinds.size > 1 ? "mixed" : kinds.has("direct") ? "direct" : "observed",
      files,
      targets,
      identities,
    })
    while (this.records.size > MAX_REVIEW_TURNS) this.records.delete(this.records.keys().next().value!)
    while ([...this.records.values()].reduce((total, review) => total + review.files.length, 0) > MAX_REVIEW_TOTAL_FILES) {
      this.records.delete(this.records.keys().next().value!)
    }
    return true
  }
}

export function reviewDocument(diff: FileDiff, expectedPath: string) {
  if (safePath(diff.file) !== expectedPath || typeof diff.patch !== "string") return
  const contents = fullPatchContents(diff.patch)
  if (!contents || contents.before.length > MAX_REVIEW_DOCUMENT_CHARS || contents.after.length > MAX_REVIEW_DOCUMENT_CHARS) return
  return { path: expectedPath, ...contents }
}

function fullPatchContents(patch: string) {
  if (!patch || patch.length > MAX_REVIEW_PATCH_CHARS || patch.includes("\0")) return
  const lines = patch.replaceAll("\r\n", "\n").split("\n")
  const hunks = lines.flatMap((line, index) => line.startsWith("@@ ") ? [index] : [])
  if (hunks.length !== 1) return
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[hunks[0]!]!)
  if (!header || Number(header[1]) > 1 || Number(header[3]) > 1) return
  const expectedBefore = header[2] === undefined ? 1 : Number(header[2])
  const expectedAfter = header[4] === undefined ? 1 : Number(header[4])
  if (!Number.isSafeInteger(expectedBefore) || !Number.isSafeInteger(expectedAfter)) return

  const before: Array<{ text: string; newline: boolean }> = []
  const after: Array<{ text: string; newline: boolean }> = []
  let previous: "-" | "+" | " " | undefined
  for (const [offset, line] of lines.slice(hunks[0]! + 1).entries()) {
    if (offset === lines.length - hunks[0]! - 2 && line === "") continue
    if (line === "\\ No newline at end of file") {
      if (!previous) return
      if ((previous === "-" || previous === " ") && before.at(-1)) before.at(-1)!.newline = false
      if ((previous === "+" || previous === " ") && after.at(-1)) after.at(-1)!.newline = false
      continue
    }
    const prefix = line[0]
    if (prefix !== "-" && prefix !== "+" && prefix !== " ") return
    if (prefix === "-" || prefix === " ") before.push({ text: line.slice(1), newline: true })
    if (prefix === "+" || prefix === " ") after.push({ text: line.slice(1), newline: true })
    previous = prefix
  }
  if (before.length !== expectedBefore || after.length !== expectedAfter) return
  const text = (value: Array<{ text: string; newline: boolean }>) =>
    value.map((line) => line.text + (line.newline ? "\n" : "")).join("")
  return { before: text(before), after: text(after) }
}

function safePath(value: string | undefined) {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return
  const path = value.replaceAll("\\", "/").trim()
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return
  const parts = path.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) return
  return path
}

function safeCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000
}

function optionalCount(value: number | undefined) {
  return value === undefined || safeCount(value)
}

function safeID(value: string) {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function safeChangeID(value: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}
