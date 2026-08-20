import { deepEqual, equal } from "node:assert/strict"
import { RequestGeneration, SessionHistory, parseSession, proposedSessionTitle, sameSessionVersion } from "../session-history"

const directory = "/workspace/project"
const sessions = [
  session("gui", directory, "GUI chat", 400),
  session("tui", `${directory}/.`, "TUI chat", 300),
  session("other", "/workspace/other", "Other chat", 500),
  { ...session("child", directory, "Child", 200), parentID: "gui" },
  { ...session("archived", directory, "Archived", 100), time: { created: 1, updated: 100, archived: 99 } },
]

describe("workspace session history", () => {
  it("shows root TUI and GUI sessions from only the exact normalized directory", () => {
    const history = new SessionHistory(directory, keys())
    const projected = history.replace(sessions, { gui: { type: "idle" }, tui: { type: "busy" } }, "gui")
    deepEqual(projected.map((item) => ({ title: item.title, current: item.current, status: item.status })), [
      { title: "GUI chat", current: true, status: "idle" },
      { title: "TUI chat", current: false, status: "busy" },
    ])
    equal(JSON.stringify(projected).includes(directory), false)
    equal(JSON.stringify(projected).includes('"id"'), false)
    equal(history.resolve(projected[0]!.key)?.id, "gui")
  })

  it("rejects forged and stale opaque selection keys", () => {
    const history = new SessionHistory(directory, keys())
    const first = history.replace(sessions, {}, undefined)[0]!
    equal(history.resolve("forged_opaque_session_key"), undefined)
    history.replace([sessions[1]], {}, undefined)
    equal(history.resolve(first.key), undefined)
  })

  it("sanitizes titles and redacts the workspace directory", () => {
    const history = new SessionHistory(directory, keys())
    const projected = history.replace([
      session("unsafe", directory, "\u202e  Deploy\n production \u0000", 100),
      session("other", directory, "Review docs", 90),
      session("path", directory, `Inspect ${directory}/secret.ts`, 80),
    ], {}, undefined)
    equal(projected[0]?.title, "Deploy production")
    equal(projected[2]?.title, "Inspect <workspace>/secret.ts")
  })

  it("keeps History within the protocol limit and retains only visible keys", () => {
    const history = new SessionHistory(directory, keys())
    const projected = history.replace(Array.from({ length: 250 }, (_, index) =>
      session(`session-${index}`, directory, `Chat ${index}`, index)), {}, undefined)
    equal(projected.length, 200)
    equal(projected[0]?.title, "Chat 249")
    equal(projected.at(-1)?.title, "Chat 50")
    equal(history.resolve("opaque_session_key_201"), undefined)
  })

  it("detects a session version race", () => {
    const first = session("same", directory, "Chat", 100)
    equal(sameSessionVersion(first, { ...first, time: { ...first.time, updated: 101 } }), false)
    equal(sameSessionVersion(first, { ...first }), true)
  })

  it("rejects malformed authoritative revert markers", () => {
    equal(parseSession({ ...session("same", directory, "Chat", 100), revert: { messageID: "x".repeat(513) } }), undefined)
    equal(parseSession({ ...session("same", directory, "Chat", 100), revert: { messageID: "user-safe" } })?.revert?.messageID, "user-safe")
    equal(parseSession({ ...session("same", directory, "Chat", 100), parentID: 123 }), undefined)
    equal(parseSession({ ...session("same", directory, "Chat", Number.NaN) }), undefined)
    equal(parseSession({ ...session("same", directory, "Chat", -1) }), undefined)
    equal(parseSession({ ...session("same", directory, "Chat", 1.5) }), undefined)
    equal(parseSession({ ...session("same", directory, "Chat", 100), directory: `${directory}\nother` }), undefined)
  })

  it("projects only authoritative bounded session totals", () => {
    const parsed = parseSession({
      ...session("usage", directory, "Usage", 100),
      cost: 0.0000004,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 1 } },
      privateMetadata: { secret: "must-not-cross" },
    })
    deepEqual(parsed?.usage, {
      cost: 0.0000004,
      tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 7, cacheWrite: 1, total: 25 },
    })
    equal(JSON.stringify(parsed).includes("must-not-cross"), false)
    equal(parseSession({
      ...session("bad", directory, "Bad", 100),
      cost: -1,
      tokens: { input: Number.NaN, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })?.usage, undefined)
  })

  it("accepts safe canonical titles and rejects control or BiDi overrides", () => {
    equal(proposedSessionTitle("  Fix   deployment  "), "Fix deployment")
    equal(proposedSessionTitle("bad\nname"), undefined)
    equal(proposedSessionTitle("bad\u202ename"), undefined)
    equal(proposedSessionTitle("x".repeat(121)), undefined)
  })
})

describe("History request ordering", () => {
  it("accepts only the newest in-flight History result", () => {
    const requests = new RequestGeneration()
    const first = requests.begin()
    const second = requests.begin()
    equal(requests.accepts(first), false)
    equal(requests.accepts(second), true)
    requests.invalidate()
    equal(requests.accepts(second), false)
  })
})

function session(id: string, path: string, title: string, updated: number) {
  return { id, directory: path, title, time: { created: 1, updated } }
}

function keys() {
  let value = 0
  return () => `opaque_session_key_${++value}`
}
