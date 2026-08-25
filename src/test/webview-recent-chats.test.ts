import { deepEqual, equal } from "node:assert/strict"
import { createRecentChats, recentChatItems } from "../webview-recent-chats"
import type { HistorySession } from "../protocol"

type FakeEvent = { type: "click" }

class FakeDocument {
  activeElement?: FakeElement

  createElement(tag: string) {
    return new FakeElement(tag, this)
  }
}

class FakeElement {
  ariaLabel = ""
  className = ""
  dir = ""
  disabled = false
  hidden = false
  id = ""
  textContent = ""
  type = ""
  readonly children: FakeElement[] = []
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>()

  constructor(readonly tagName: string, private readonly owner: FakeDocument) {}

  append(...children: FakeElement[]) {
    this.children.push(...children)
  }

  replaceChildren(...children: FakeElement[]) {
    this.children.splice(0, this.children.length, ...children)
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  getAttribute(name: string) {
    return this.attributes.get(name)
  }

  toggleAttribute(name: string, force: boolean) {
    if (force) this.attributes.set(name, "")
    else this.attributes.delete(name)
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatch(event: FakeEvent) {
    this.listeners.get(event.type)?.forEach((listener) => listener(event))
  }

  contains(target: unknown): boolean {
    return target === this || this.children.some((child) => child.contains(target))
  }

  querySelectorAll<T>(selector: string) {
    const matches: FakeElement[] = []
    for (const child of this.children) {
      if (selector === "button" && child.tagName === "button") matches.push(child)
      matches.push(...child.querySelectorAll<FakeElement>(selector))
    }
    return matches as T[]
  }

  focus() {
    this.owner.activeElement = this
  }
}

describe("recent chat presentation", () => {
  it("keeps the authoritative order and exposes at most three items", () => {
    const sessions: HistorySession[] = Array.from({ length: 5 }, (_, index) => ({
      key: `opaque_recent_session_${index}`,
      title: `Chat ${index}`,
      updated: 500 - index,
      current: false,
    }))
    const recent = recentChatItems(sessions)
    deepEqual(recent.map((session) => session.title), ["Chat 0", "Chat 1", "Chat 2"])
    equal(recent.length, 3)
    equal(sessions.length, 5)
  })

  it("renders mixed-direction titles as text and opens each opaque selection once", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
    const fakeDocument = new FakeDocument()
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument })
    try {
      const root = fakeDocument.createElement("section")
      const fallback = fakeDocument.createElement("textarea")
      const selections: string[] = []
      let viewAll = 0
      let restored = 0
      const recent = createRecentChats(root as unknown as HTMLElement, {
        select: (key) => selections.push(key),
        viewAll: () => { viewAll++ },
        restoreFocus: () => {
          restored++
          fallback.focus()
        },
      })
      const sessions: HistorySession[] = [{
        key: "opaque_recent_session_1",
        title: "راجع <img src=x> OpenCode",
        updated: Date.now() - 60_000,
        current: false,
      }, {
        key: "opaque_recent_session_2",
        title: "Second chat",
        updated: Date.now() - 120_000,
        current: false,
      }, {
        key: "opaque_recent_session_3",
        title: "Third chat",
        updated: Date.now() - 180_000,
        current: false,
      }]

      equal(recent.apply({ type: "recentChats", status: "ready", sessions }), true)
      recent.update(true, false)
      const [, list, status, all] = root.children
      const first = list?.children[0]?.children[0]
      equal(root.hidden, false)
      equal(list?.children.length, 3)
      equal(first?.children[0]?.textContent, "راجع <img src=x> OpenCode")
      equal(first?.children[0]?.dir, "auto")
      equal(first?.children[1]?.dir, "ltr")
      equal(status?.textContent, "")

      first?.focus()
      first?.dispatch({ type: "click" })
      first?.dispatch({ type: "click" })
      deepEqual(selections, ["opaque_recent_session_1"])
      equal(root.getAttribute("aria-busy"), "true")
      equal(list?.children[0]?.children[0]?.disabled, true)
      equal(status?.textContent, "Opening chat…")
      equal(restored, 1)

      recent.apply({ type: "recentChats", status: "loading", sessions })
      equal(list?.children[0]?.children[0]?.disabled, true)
      recent.apply({ type: "recentChats", status: "ready", sessions })
      equal(list?.children[0]?.children[0]?.disabled, false)
      equal(root.getAttribute("aria-busy"), "false")
      all?.dispatch({ type: "click" })
      all?.dispatch({ type: "click" })
      equal(viewAll, 1)
      equal(all?.disabled, true)
      recent.apply({ type: "recentChats", status: "ready", sessions })
      equal(all?.disabled, true)
      recent.apply({ type: "recentChats", status: "loading", sessions })
      recent.apply({ type: "recentChats", status: "ready", sessions })
      equal(all?.disabled, false)
      list?.children[0]?.children[0]?.focus()
      recent.update(false, false)
      equal(root.hidden, true)
      equal(restored, 2)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })
})
