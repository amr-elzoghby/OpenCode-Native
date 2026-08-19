import type { NativeAction } from "./protocol"

export type TuiSlashParity = {
  name: string
  aliases?: readonly string[]
  native?: NativeAction
  status: "native" | "tui-only" | "conditional"
  note: string
}

// Source inventory: packages/tui/src/app.tsx, component/prompt/index.tsx,
// routes/session/index.tsx, and feature-plugins/system/diff-viewer.tsx.
export const TUI_SLASH_PARITY: readonly TuiSlashParity[] = [
  { name: "sessions", aliases: ["resume", "continue"], native: "sessions", status: "native", note: "Native chat history" },
  { name: "new", aliases: ["clear"], native: "new", status: "native", note: "Native new chat" },
  { name: "workspaces", status: "conditional", note: "Experimental worktree routing changes project scope; deferred until Native can transition the active VS Code workspace atomically" },
  { name: "models", aliases: ["mo"], native: "models", status: "native", note: "Native model picker" },
  { name: "agents", native: "agents", status: "native", note: "Native agent picker" },
  { name: "mcps", native: "mcps", status: "native", note: "Native MCP manager" },
  { name: "variants", native: "variants", status: "native", note: "Native model-variant picker" },
  { name: "connect", native: "connect", status: "native", note: "Native provider connection flow" },
  { name: "org", aliases: ["orgs", "switch-org"], native: "org", status: "native", note: "Host-only picker shown when multiple Console organizations are available" },
  { name: "status", native: "status", status: "native", note: "Native MCP/LSP/formatter status" },
  { name: "debug", native: "debug", status: "native", note: "Safe Native diagnostics without raw process data" },
  { name: "themes", native: "themes", status: "native", note: "VS Code color-theme picker; Webview follows host theme variables" },
  { name: "help", native: "help", status: "native", note: "Native slash-command help" },
  { name: "exit", aliases: ["quit", "q"], native: "exit", status: "native", note: "Closes VS Code's secondary sidebar" },
  { name: "editor", status: "tui-only", note: "TUI synchronously round-trips through $EDITOR; VS Code has no equivalent safe composer contract yet" },
  { name: "skills", native: "skills", status: "native", note: "Filters current opaque Core commands to skills" },
  { name: "warp", status: "conditional", note: "Experimental workspace routing changes project scope; deferred until Native can transition the active VS Code workspace atomically" },
  { name: "move", status: "tui-only", note: "Experimental move endpoint also changes project/change scope; deferred until Native can transition VS Code workspace state atomically" },
  { name: "share", native: "share", status: "native", note: "Confirmed public share link, kept in Extension Host" },
  { name: "rename", native: "rename", status: "native", note: "Native session rename" },
  { name: "timeline", native: "timeline", status: "native", note: "In-sidebar user-turn navigator" },
  { name: "fork", native: "fork", status: "native", note: "Host-validated fork point" },
  { name: "compact", aliases: ["summarize"], native: "compact", status: "native", note: "Core session compaction" },
  { name: "unshare", native: "unshare", status: "native", note: "Removes the Core share link" },
  { name: "undo", native: "undo", status: "native", note: "Core stepwise session revert" },
  { name: "redo", native: "redo", status: "native", note: "Core stepwise session restore" },
  { name: "timestamps", aliases: ["toggle-timestamps"], native: "timestamps", status: "native", note: "Native message timestamps" },
  { name: "thinking", aliases: ["toggle-thinking"], native: "thinking", status: "native", note: "Native activity disclosure state" },
  { name: "copy", native: "copy", status: "native", note: "Copies the visible Native transcript" },
  { name: "export", native: "export", status: "native", note: "Exports the visible Native transcript" },
  { name: "diff", native: "diff", status: "native", note: "Opens the latest visible reviewable change in VS Code diff" },
]

export const UNAVAILABLE_TUI_SLASH_COMMANDS = TUI_SLASH_PARITY.filter((command) => !command.native)
