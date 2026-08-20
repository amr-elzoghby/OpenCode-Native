import { Uri, ViewColumn, commands, window, type ExtensionContext } from "vscode"
import { SessionController } from "./session"
import { SidebarProvider } from "./sidebar"
import { resolveOpencode } from "./server"

const TERMINAL_NAME = "opencode"
let activeSession: SessionController | undefined

export async function deactivate() {
  await activeSession?.dispose()
  activeSession = undefined
}

export function activate(context: ExtensionContext) {
  void commands.executeCommand("setContext", "opencode.native.sidebarFocused", false)
  void commands.executeCommand("setContext", "opencode.native.composerFocused", false)
  void commands.executeCommand("setContext", "opencode.native.generating", false)
  const output = window.createOutputChannel("OpenCode Native")
  const timing = (message: string) => output.appendLine(`[timing] ${message}`)
  const session = new SessionController(timing)
  activeSession = session
  const sidebar = new SidebarProvider(context, session, timing)
  const sidebarDisposable = window.registerWebviewViewProvider(SidebarProvider.viewID, sidebar)
  const nativeCommands = [
    commands.registerCommand("opencode.native.newChat", () => sidebar.invokeAction("new")),
    commands.registerCommand("opencode.native.refresh", () => sidebar.invokeAction("refresh")),
    commands.registerCommand("opencode.native.history", () => sidebar.invokeAction("sessions")),
    commands.registerCommand("opencode.native.usage", () => sidebar.openUsage()),
    commands.registerCommand("opencode.native.models", () => sidebar.invokeAction("models")),
    commands.registerCommand("opencode.native.agents", () => sidebar.invokeAction("agents")),
    commands.registerCommand("opencode.native.variants", () => sidebar.invokeAction("variants")),
    commands.registerCommand("opencode.native.stop", () => session.stop()),
    commands.registerCommand("opencode.native.addExplorerFiles", (resource: unknown, selected: unknown) => {
      const candidates = Array.isArray(selected) && selected.length ? selected : [resource]
      if (!candidates.every((item) => item instanceof Uri)) return sidebar.addExplorerFiles([])
      return sidebar.addExplorerFiles(candidates)
    }),
  ]
  const focusDisposable = commands.registerCommand("opencode.native.focus", () =>
    commands.executeCommand(`${SidebarProvider.viewID}.focus`),
  )
  const openNewTerminalDisposable = commands.registerCommand("opencode.native.openNewTerminal", async () => {
    await openTerminal()
  })

  const openTerminalDisposable = commands.registerCommand("opencode.native.openTerminal", async () => {
    const existingTerminal = window.terminals.find((terminal) => terminal.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    await openTerminal()
  })

  context.subscriptions.push(
    session,
    sidebar,
    output,
    sidebarDisposable,
    ...nativeCommands,
    focusDisposable,
    openNewTerminalDisposable,
    openTerminalDisposable,
  )

  async function openTerminal() {
    const executable = await resolveOpencode().catch(() => undefined)
    if (!executable) {
      await window.showErrorMessage("OpenCode executable was not found. Configure OpenCode Native: Executable Path and try again.")
      return
    }
    const terminal = window.createTerminal({
      name: TERMINAL_NAME,
      shellPath: executable,
      shellArgs: [],
      iconPath: {
        light: Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        OPENCODE_CALLER: "vscode",
      },
    })

    terminal.show()
  }
}
