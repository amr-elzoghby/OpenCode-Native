import { deepEqual, equal } from "node:assert/strict"
import { NATIVE_ACTIONS } from "../protocol"
import { TUI_SLASH_PARITY } from "../slash-parity"
import { NATIVE_COMMANDS } from "../webview-command-menu"

describe("TUI slash-command inventory", () => {
  it("accounts for every current fixed slash name and alias", () => {
    deepEqual(TUI_SLASH_PARITY.flatMap((command) => [command.name, ...(command.aliases ?? [])]).sort(), [
      "agents", "clear", "compact", "connect", "continue", "copy", "debug", "diff", "editor", "exit", "export",
      "fork", "help", "mcps", "mo", "models", "move", "new", "org", "orgs", "q", "quit", "redo", "rename",
      "resume", "sessions", "share", "skills", "status", "summarize", "switch-org", "themes", "thinking", "timeline",
      "timestamps", "toggle-thinking", "toggle-timestamps", "undo", "unshare", "variants", "warp", "workspaces",
    ].sort())
  })

  it("gives every supported mapping a fixed host action and menu entry", () => {
    const actions = new Set<string>(NATIVE_ACTIONS)
    const menu = new Set<string>(NATIVE_COMMANDS.map((command) => command.id))
    TUI_SLASH_PARITY.filter((command) => command.native).forEach((command) => {
      equal(actions.has(command.native!), true, command.name)
      equal(menu.has(command.native!), true, command.name)
    })
  })
})
