import { deepEqual } from "node:assert/strict"
import { mcpSummaries, systemStatusItems } from "../system-status"

describe("Native system status projection", () => {
  it("projects bounded MCP identities without raw failures", () => {
    deepEqual(mcpSummaries({
      github: { status: "connected", token: "secret" },
      broken: { status: "failed", error: "Authorization: secret" },
      "bad\u202ename": { status: "connected" },
      unknown: { status: "private" },
    }), [
      { name: "broken", status: "failed" },
      { name: "github", status: "connected" },
    ])
  })

  it("combines only safe MCP, LSP, and formatter display metadata", () => {
    deepEqual(systemStatusItems(
      { docs: { status: "needs_auth", error: "private" } },
      [{ id: "ts", name: "TypeScript", root: "/workspace", status: "connected", private: "secret" }],
      [{ name: "Prettier", extensions: [".ts"], enabled: true }],
    ), [
      { kind: "mcp", name: "docs", status: "needs_auth" },
      { kind: "lsp", name: "TypeScript", status: "connected", detail: "/workspace" },
      { kind: "formatter", name: "Prettier", status: "enabled" },
    ])
  })
})
