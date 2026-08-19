import { deepEqual, equal, notEqual } from "node:assert/strict"
import { CommandStore } from "../commands"

const command = {
  name: "review",
  description: "Review changes",
  source: "command",
  template: "Review $ARGUMENTS",
  hints: ["$ARGUMENTS"],
}

describe("dynamic OpenCode command authority", () => {
  it("projects bounded display metadata without exposing templates", () => {
    const store = new CommandStore()
    store.replace([
      { ...command, name: "init", description: "guided setup", template: "private init body" },
      command,
      { ...command, name: "search-docs", source: "mcp", template: "private MCP body" },
      { ...command, name: "skill-name", source: "skill", template: "private skill body" },
    ])
    deepEqual(store.snapshot().map((item) => ({ name: item.name, source: item.source })), [
      { name: "init", source: "command" },
      { name: "review", source: "command" },
      { name: "search-docs", source: "mcp" },
      { name: "skill-name", source: "skill" },
    ])
    equal(JSON.stringify(store.snapshot()).includes("private init body"), false)
    equal(JSON.stringify(store.snapshot()).includes("private MCP body"), false)
    equal(JSON.stringify(store.snapshot()).includes("private skill body"), false)
    equal(JSON.stringify(store.snapshot()).includes("Review $ARGUMENTS"), false)
  })

  it("keeps opaque identities stable only while command semantics are unchanged", () => {
    const store = new CommandStore()
    store.replace([command])
    const first = store.snapshot()[0]!.key
    store.replace([{ ...command }])
    equal(store.snapshot()[0]!.key, first)
    equal(store.matches(first, [{ ...command }]), true)

    store.replace([{ ...command, template: "Changed privately" }])
    notEqual(store.snapshot()[0]!.key, first)
    equal(store.matches(first, [{ ...command, template: "Changed privately" }]), false)
  })

  it("rejects unsafe slash names and malformed records", () => {
    const store = new CommandStore()
    store.replace([
      command,
      { ...command, name: "bad command" },
      { ...command, name: "\u202ereview" },
      { ...command, name: "missing-template", template: undefined },
      { ...command, name: "bad-hints", hints: "arguments" },
      { ...command, name: "extra-field", executable: "rm -rf /" },
      { ...command, name: "oversized", template: "x".repeat(256_001) },
      { ...command, name: "connect", template: "spoof native" },
      { ...command, name: "RESUME", template: "spoof alias" },
    ])
    deepEqual(store.snapshot().map((item) => item.name), ["review"])
  })

  it("caps projected command count and scanned input", () => {
    const store = new CommandStore()
    store.replace(Array.from({ length: 1_100 }, (_, index) => ({ ...command, name: `command-${index}` })))
    equal(store.snapshot().length, 200)
    equal(store.snapshot().some((item) => item.name === "command-1000"), false)
  })
})
