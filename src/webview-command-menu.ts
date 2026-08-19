import { NATIVE_ACTIONS, NATIVE_ACTION_ALIASES, isReservedNativeSlashName, type NativeAction } from "./protocol"
import { UNAVAILABLE_TUI_SLASH_COMMANDS, type TuiSlashParity } from "./slash-parity"

export type LocalCommand = {
  id: NativeAction
  label: string
  aliases?: readonly string[]
  description: string
}

export type DynamicCommand = {
  key: string
  name: string
  description?: string
  source: "command" | "mcp" | "skill"
}

export type CommandOption =
  | { kind: "native"; command: LocalCommand; matchedName: string }
  | { kind: "dynamic"; command: DynamicCommand }
  | { kind: "unavailable"; command: TuiSlashParity; matchedName: string }

export const NATIVE_COMMANDS: readonly LocalCommand[] = [
  { id: "new", label: "/new", aliases: ["clear"], description: "Start a new conversation" },
  { id: "refresh", label: "/refresh", description: "Reload the current OpenCode chat" },
  { id: "sessions", label: "/sessions", aliases: ["resume", "continue"], description: "Open chat history" },
  { id: "models", label: "/models", aliases: ["mo"], description: "Choose a model" },
  { id: "agents", label: "/agents", description: "Choose Build or Plan" },
  { id: "variants", label: "/variants", description: "Choose a reasoning variant" },
  { id: "connect", label: "/connect", description: "Connect an AI provider" },
  { id: "org", label: "/org", aliases: ["orgs", "switch-org"], description: "Switch OpenCode Console organization" },
  { id: "mcps", label: "/mcps", description: "View and toggle MCP servers" },
  { id: "status", label: "/status", description: "View OpenCode system status" },
  { id: "compact", label: "/compact", aliases: ["summarize"], description: "Compact the current chat" },
  { id: "rename", label: "/rename", description: "Rename the current chat" },
  { id: "copy", label: "/copy", description: "Copy the visible chat transcript" },
  { id: "export", label: "/export", description: "Save the visible chat transcript" },
  { id: "share", label: "/share", description: "Create and copy a public chat link" },
  { id: "unshare", label: "/unshare", description: "Remove the public chat link" },
  { id: "fork", label: "/fork", description: "Fork this chat from a message" },
  { id: "timeline", label: "/timeline", description: "Jump to a turn in this chat" },
  { id: "undo", label: "/undo", description: "Undo the previous user turn and its file changes" },
  { id: "redo", label: "/redo", description: "Restore the last undone turn and its file changes" },
  { id: "diff", label: "/diff", description: "Review the latest changed file" },
  { id: "thinking", label: "/thinking", aliases: ["toggle-thinking"], description: "Expand or collapse activity details" },
  { id: "timestamps", label: "/timestamps", aliases: ["toggle-timestamps"], description: "Show or hide message timestamps" },
  { id: "skills", label: "/skills", description: "Browse available skills" },
  { id: "themes", label: "/themes", description: "Choose the VS Code color theme" },
  { id: "debug", label: "/debug", description: "View safe OpenCode Native diagnostics" },
  { id: "help", label: "/help", description: "Show Native commands" },
  { id: "exit", label: "/exit", aliases: ["quit", "q"], description: "Close the secondary sidebar" },
]

export function createCommandMenu(
  root: HTMLElement,
  prompt: HTMLTextAreaElement,
  execute: (command: LocalCommand["id"]) => void,
  executeDynamic: (key: string, name: string, argumentsValue: string) => void,
  unavailable: (name: string, note: string) => void = () => {},
) {
  const native = NATIVE_COMMANDS
  let dynamic: DynamicCommand[] = []
  let visible: CommandOption[] = []
  let active = 0
  let sourceFilter: DynamicCommand["source"] | undefined
  let matchSignature = ""

  root.setAttribute("role", "listbox")
  root.setAttribute("aria-label", "OpenCode commands")
  if (root.id) prompt.setAttribute("aria-controls", root.id)
  prompt.setAttribute("aria-haspopup", "listbox")
  prompt.setAttribute("aria-expanded", "false")
  root.hidden = true

  return {
    sync() {
      sync()
    },
    update(commands: DynamicCommand[]) {
      dynamic = commands
      sync()
    },
    openSource(source: DynamicCommand["source"]) {
      sourceFilter = source
      prompt.value = "/"
      prompt.dispatchEvent(new Event("input"))
      prompt.focus()
    },
    handleKeydown(event: KeyboardEvent) {
      if (root.hidden) return false
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return true
      }
      if (event.key === "ArrowDown") return move(1, event)
      if (event.key === "ArrowUp") return move(-1, event)
      if (event.key === "Home") return activate(0, event)
      if (event.key === "End") return activate(visible.length - 1, event)
      if (event.key !== "Enter" && event.key !== "Tab") return false
      const option = visible[active]
      if (!option) return false
      event.preventDefault()
      select(option)
      return true
    },
    executeExact(value: string) {
      const command = native.find((item) => item.id === nativeActionFromSlash(value))
      if (command) {
        run(command)
        return true
      }
      const unavailableCommand = unavailableCommandFromSlash(value)
      if (unavailableCommand) {
        close()
        prompt.value = ""
        prompt.dispatchEvent(new Event("input"))
        unavailable(unavailableCommand.name, unavailableCommand.note)
        return true
      }
      const resolved = dynamicCommandFromSlash(value, dynamic)
      if (!resolved) return false
      close()
      prompt.value = ""
      prompt.dispatchEvent(new Event("input"))
      executeDynamic(resolved.key, resolved.name, resolved.arguments)
      return true
    },
    isOpen() {
      return !root.hidden
    },
  }

  function sync() {
      const value = prompt.value.slice(0, prompt.selectionStart ?? 0)
      const match = /^\/([^\s/]*)$/.exec(value)
      if (!match) {
        close()
        return
      }
      const query = match[1].toLocaleLowerCase()
      visible = matchingCommandOptions(query, dynamic, sourceFilter)
      const signature = `${sourceFilter ?? "all"}\0${query}\0${visible.map(commandIdentity).join("\0")}`
      if (signature !== matchSignature) active = 0
      else active = Math.min(active, Math.max(0, visible.length - 1))
      matchSignature = signature
      render()
  }

  function render() {
    root.hidden = visible.length === 0
    prompt.setAttribute("aria-expanded", String(!root.hidden))
    if (root.hidden) {
      prompt.removeAttribute("aria-activedescendant")
      return
    }
    root.replaceChildren(...visible.map((item, index) => {
      const option = document.createElement("button")
      option.type = "button"
      option.className = "command-option"
      option.id = `opencode-command-${commandIdentity(item)}`
      option.tabIndex = -1
      option.setAttribute("role", "option")
      option.setAttribute("aria-selected", String(index === active))
      const label = document.createElement("bdi")
      label.dir = "ltr"
      label.textContent = commandDisplayLabel(item)
      const description = document.createElement("span")
      description.dir = "auto"
      description.textContent = item.kind === "unavailable"
        ? `Unavailable in Native · ${item.command.note}`
        : item.command.description ?? (item.kind === "dynamic" ? item.command.source : "")
      option.append(label, description)
      option.addEventListener("pointerenter", () => {
        if (active === index) return
        active = index
        render()
      })
      option.addEventListener("click", () => select(item))
      return option
    }))
    const selected = visible[active]
    if (selected) prompt.setAttribute("aria-activedescendant", `opencode-command-${commandIdentity(selected)}`)
  }

  function select(option: CommandOption) {
    if (option.kind === "native") return run(option.command)
    if (option.kind === "unavailable") {
      close()
      prompt.value = ""
      prompt.dispatchEvent(new Event("input"))
      unavailable(option.command.name, option.command.note)
      return
    }
    close()
    prompt.value = `/${option.command.name} `
    prompt.dispatchEvent(new Event("input"))
    prompt.focus()
  }

  function run(command: LocalCommand) {
    close()
    prompt.value = ""
    prompt.dispatchEvent(new Event("input"))
    execute(command.id)
  }

  function close() {
    sourceFilter = undefined
    root.hidden = true
    prompt.setAttribute("aria-expanded", "false")
    prompt.removeAttribute("aria-activedescendant")
  }

  function move(offset: number, event: KeyboardEvent) {
    if (!visible.length) return false
    return activate((active + offset + visible.length) % visible.length, event)
  }

  function activate(index: number, event: KeyboardEvent) {
    if (!visible[index]) return false
    event.preventDefault()
    active = index
    render()
    root.children[index]?.scrollIntoView({ block: "nearest" })
    return true
  }
}

export function matchingCommandOptions(
  query: string,
  dynamic: DynamicCommand[],
  source?: DynamicCommand["source"],
): CommandOption[] {
  const normalized = query.toLocaleLowerCase()
  const fixedNames = new Set(NATIVE_COMMANDS.flatMap((command) => [command.id, ...(command.aliases ?? [])])
    .concat(UNAVAILABLE_TUI_SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]))
    .map((name) => name.toLocaleLowerCase()))
  return [
    ...(source ? [] : NATIVE_COMMANDS)
      .flatMap((command): CommandOption[] => {
        const names = [command.id, ...(command.aliases ?? [])]
        const matchedName = names.find((name) => name.toLocaleLowerCase() === normalized) ??
          names.find((name) => name.toLocaleLowerCase().startsWith(normalized))
        return matchedName ? [{ kind: "native", command, matchedName }] : []
      }),
    ...(source ? [] : UNAVAILABLE_TUI_SLASH_COMMANDS)
      .flatMap((command): CommandOption[] => {
        const names = [command.name, ...(command.aliases ?? [])]
        const matchedName = names.find((name) => name.toLocaleLowerCase() === normalized) ??
          names.find((name) => name.toLocaleLowerCase().startsWith(normalized))
        return matchedName ? [{ kind: "unavailable", command, matchedName }] : []
      }),
    ...dynamic
      .filter((command) =>
        (!source || command.source === source) &&
        !fixedNames.has(command.name.toLocaleLowerCase()) &&
        command.name.toLocaleLowerCase().startsWith(normalized)
      )
      .map((command): CommandOption => ({ kind: "dynamic", command })),
  ]
}

export function commandDisplayLabel(option: CommandOption) {
  return `/${option.kind === "dynamic" ? option.command.name : option.matchedName}`
}

export function nativeActionFromSlash(value: string): NativeAction | undefined {
  const name = /^\/([^\s]+)$/.exec(value.trim())?.[1]
  if (!name) return
  return NATIVE_ACTIONS.find((action) => name === action || NATIVE_ACTION_ALIASES[action]?.includes(name))
}

export function unavailableCommandFromSlash(value: string) {
  const name = /^\/([^\s]+)$/.exec(value.trim())?.[1]
  if (!name) return
  return UNAVAILABLE_TUI_SLASH_COMMANDS.find((command) =>
    name === command.name || command.aliases?.includes(name)
  )
}

export function dynamicCommandFromSlash(value: string, commands: DynamicCommand[]) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(value.trim())
  if (!match || isReservedNativeSlashName(match[1])) return
  const command = commands.find((item) => item.name === match[1])
  if (!command) return
  return { key: command.key, name: command.name, arguments: match[2]?.trim() ?? "" }
}

function commandIdentity(option: CommandOption) {
  if (option.kind === "native") return option.command.id
  if (option.kind === "dynamic") return option.command.key
  return `unavailable-${option.command.name}`
}
