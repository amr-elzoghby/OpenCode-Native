import { deepEqual, equal } from "node:assert/strict"
import {
  createCommandMenu,
  dynamicCommandFromSlash,
  commandDisplayLabel,
  matchingCommandOptions,
  nativeActionFromSlash,
  unavailableCommandFromSlash,
} from "../webview-command-menu"

class FakeElement {
  hidden = false
  id = ""
  children: FakeElement[] = []
  selectionStart = 0
  textContent = ""
  private input = ""
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()

  get value() {
    return this.input
  }

  set value(value: string) {
    this.input = value
    this.selectionStart = value.length
  }

  setAttribute() {}
  removeAttribute() {}
  focus() {}
  scrollIntoView() {}

  replaceChildren(...children: FakeElement[]) {
    this.children = children
  }

  append(...children: FakeElement[]) {
    this.children.push(...children)
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatchEvent(event: Event) {
    this.listeners.get(event.type)?.forEach((listener) => listener(event))
    return true
  }
}

describe("native action entry points", () => {
  it("routes only exact fixed slash commands", () => {
    equal(nativeActionFromSlash("/new"), "new")
    equal(nativeActionFromSlash("  /models  "), "models")
    equal(nativeActionFromSlash("/agents"), "agents")
    equal(nativeActionFromSlash("/variants"), "variants")
    equal(nativeActionFromSlash("/refresh"), "refresh")
    equal(nativeActionFromSlash("/sessions"), "sessions")
    equal(nativeActionFromSlash("/resume"), "sessions")
    equal(nativeActionFromSlash("/continue"), "sessions")
    equal(nativeActionFromSlash("/clear"), "new")
    equal(nativeActionFromSlash("/mo"), "models")
    equal(nativeActionFromSlash("/connect"), "connect")
    equal(nativeActionFromSlash("/mcps"), "mcps")
    equal(nativeActionFromSlash("/status"), "status")
    equal(nativeActionFromSlash("/summarize"), "compact")
    equal(nativeActionFromSlash("/copy"), "copy")
    equal(nativeActionFromSlash("/themes"), "themes")
    equal(nativeActionFromSlash("/timeline"), "timeline")
    equal(nativeActionFromSlash("/toggle-timestamps"), "timestamps")
    equal(nativeActionFromSlash("/toggle-thinking"), "thinking")
    equal(nativeActionFromSlash("/quit"), "exit")
    equal(nativeActionFromSlash("/unknown"), undefined)
    equal(nativeActionFromSlash("/new now"), undefined)
  })

  it("filters canonical names, aliases, and dynamic commands by prefix only", () => {
    const dynamic = [
      { key: "opaque_skill_key_123", name: "security", source: "skill" as const },
      { key: "opaque_command_key_456", name: "inspect", source: "command" as const },
      { key: "opaque_command_key_789", name: "xstatus", source: "command" as const },
    ]
    const matches = matchingCommandOptions("s", dynamic)
    deepEqual(matches.flatMap((item) => item.kind === "native" ? [item.command.id] : [item.command.name]), [
      "sessions",
      "org",
      "status",
      "compact",
      "share",
      "skills",
      "security",
    ])
    equal(matches.some((item) => item.kind === "dynamic" && item.command.name === "xstatus"), false)
    equal(matches.every((item) => commandDisplayLabel(item).startsWith("/s")), true)
    deepEqual(matchingCommandOptions("q", dynamic).map((item) =>
      item.kind === "native" ? item.command.id : item.command.name
    ), ["exit"])
    equal(commandDisplayLabel(matchingCommandOptions("q", dynamic)[0]!), "/q")
  })

  it("can scope command completion to host-projected skills", () => {
    const matches = matchingCommandOptions("", [
      { key: "opaque_skill_key_123", name: "security", source: "skill" },
      { key: "opaque_mcp_key_45678", name: "search-docs", source: "mcp" },
      { key: "opaque_command_key_789", name: "setup", source: "command" },
    ], "skill")
    deepEqual(matches.map((item) => item.kind === "native" ? item.command.id : item.command.name), ["security"])
  })

  it("keeps the skills source filter while the user narrows the opened menu", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => new FakeElement() },
    })
    try {
      const root = new FakeElement()
      root.id = "commands"
      const prompt = new FakeElement()
      const executed: string[] = []
      const menu = createCommandMenu(
        root as unknown as HTMLElement,
        prompt as unknown as HTMLTextAreaElement,
        (command) => executed.push(command),
        () => {},
      )
      prompt.addEventListener("input", () => menu.sync())
      menu.update([
        { key: "opaque_skill_security", name: "security", source: "skill" },
        { key: "opaque_mcp_search", name: "search-docs", source: "mcp" },
        { key: "opaque_skill_synthesize", name: "synthesize", source: "skill" },
      ])

      menu.openSource("skill")
      prompt.value = "/s"
      prompt.dispatchEvent(new Event("input"))
      deepEqual(root.children.map((option) => option.children[0]?.textContent), ["/security", "/synthesize"])

      prompt.value = ""
      prompt.dispatchEvent(new Event("input"))
      prompt.value = "/s"
      prompt.dispatchEvent(new Event("input"))
      equal(root.children.some((option) => option.children[0]?.textContent === "/sessions"), true)
      equal(root.children.some((option) => option.children[0]?.textContent === "/search-docs"), true)

      prompt.value = "/q"
      prompt.dispatchEvent(new Event("input"))
      let prevented = false
      equal(menu.handleKeydown({ key: "Enter", preventDefault: () => { prevented = true } } as KeyboardEvent), true)
      equal(prevented, true)
      prompt.value = "/themes"
      prompt.dispatchEvent(new Event("input"))
      root.children[0]?.dispatchEvent(new Event("click"))
      deepEqual(executed, ["exit", "themes"])
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })

  it("surfaces TUI-only commands explicitly instead of sending them as prompts", () => {
    equal(unavailableCommandFromSlash("/editor")?.status, "tui-only")
    equal(nativeActionFromSlash("/orgs"), "org")
    equal(unavailableCommandFromSlash("/unknown"), undefined)
    equal(matchingCommandOptions("w", []).some((item) =>
      item.kind === "unavailable" && (item.command.name === "workspaces" || item.command.name === "warp")
    ), true)
  })

  it("resolves only a current opaque dynamic command", () => {
    const commands = [{
      key: "opaque_command_key_123",
      name: "review",
      description: "Review changes",
      source: "command" as const,
    }]
    deepEqual(dynamicCommandFromSlash("/review branch main", commands), {
      key: "opaque_command_key_123",
      name: "review",
      arguments: "branch main",
    })
    equal(dynamicCommandFromSlash("/missing", commands), undefined)
    equal(dynamicCommandFromSlash("review", commands), undefined)
    equal(dynamicCommandFromSlash("/connect surprise", [{ ...commands[0]!, name: "connect" }]), undefined)
    equal(dynamicCommandFromSlash("/RESUME", [{ ...commands[0]!, name: "RESUME" }]), undefined)
  })

})
