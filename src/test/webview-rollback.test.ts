import { deepEqual, equal } from "node:assert/strict"
import { createRollbackDock } from "../webview-rollback"

type FakeEvent = {
  type: string
  key?: string
  preventDefault(): void
  stopPropagation(): void
}

class FakeDocument {
  activeElement?: FakeElement

  createElement(tag: string) {
    return new FakeElement(tag, this)
  }
}

class FakeElement {
  ariaLabel = ""
  className = ""
  dateTime = ""
  dir = ""
  disabled = false
  hidden = false
  id = ""
  textContent = ""
  title = ""
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

  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatch(event: FakeEvent) {
    this.listeners.get(event.type)?.forEach((listener) => listener(event))
  }

  querySelectorAll<T>(selector: string) {
    const descendants: FakeElement[] = []
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        descendants.push(child)
        visit(child)
      }
    }
    visit(this)
    return descendants.filter((element) => selector === "button" && element.tagName === "button") as T[]
  }

  focus() {
    this.owner.activeElement = this
  }
}

function event(type: string, key?: string) {
  let prevented = false
  let stopped = false
  return {
    value: {
      type,
      key,
      preventDefault() { prevented = true },
      stopPropagation() { stopped = true },
    },
    prevented: () => prevented,
    stopped: () => stopped,
  }
}

describe("rolled-back message dock", () => {
  it("is collapsed by default, renders mixed-direction previews as text, and restores once", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
    const fakeDocument = new FakeDocument()
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument })
    try {
      const root = fakeDocument.createElement("section")
      const fallback = fakeDocument.createElement("textarea")
      const restored: string[] = []
      const announcements: string[] = []
      const dock = createRollbackDock(
        root as unknown as HTMLElement,
        (key) => restored.push(key),
        (message) => announcements.push(message),
        () => fallback.focus(),
      )
      const projection = {
        count: 2,
        truncated: false,
        messages: [
          { key: "opaque_rollback_key_1234", preview: "راجع <img src=x> README مع English" },
          { key: "opaque_rollback_key_5678", preview: "Second prompt" },
        ],
      }
      dock.update(projection, false)

      const [summary, , list] = root.children
      equal(root.hidden, false)
      equal(summary?.getAttribute("aria-expanded"), "false")
      equal(list?.hidden, true)
      const opening = event("click")
      summary?.dispatch(opening.value)
      equal(summary?.getAttribute("aria-expanded"), "true")
      equal(list?.hidden, false)
      const firstRow = list?.children[0]
      const preview = firstRow?.children[0]?.children[0]
      const restore = firstRow?.children[1]
      equal(preview?.dir, "auto")
      equal(preview?.textContent, "راجع <img src=x> README مع English")
      restore?.focus()
      restore?.dispatch(event("click").value)
      restore?.dispatch(event("click").value)
      deepEqual(restored, ["opaque_rollback_key_1234"])
      deepEqual(announcements, ["Restoring rolled-back message…"])
      equal(list?.querySelectorAll<FakeElement>("button").every((button) => button.disabled), true)
      dock.update(projection, false)
      const refreshedButtons = list?.querySelectorAll<FakeElement>("button") ?? []
      equal(list?.children[0], firstRow)
      equal(fakeDocument.activeElement, restore)
      equal(refreshedButtons.every((button) => button.disabled), true)
      equal(dock.resolve("opaque_rollback_key_other", "rejected"), false)
      equal(dock.resolve("opaque_rollback_key_1234", "rejected"), true)
      equal(fakeDocument.activeElement, summary)
      const unlockedButtons = list?.querySelectorAll<FakeElement>("button") ?? []
      equal(unlockedButtons.every((button) => !button.disabled), true)
      unlockedButtons[1]?.dispatch(event("click").value)
      dock.update({ count: 0, truncated: false, messages: [] }, false)
      equal(root.getAttribute("aria-busy"), "true")
      equal(dock.resolve("opaque_rollback_key_5678", "restored"), true)
      equal(root.getAttribute("aria-busy"), "false")
      equal(fakeDocument.activeElement, fallback)
      deepEqual(restored, ["opaque_rollback_key_1234", "opaque_rollback_key_5678"])
      deepEqual(announcements, [
        "Restoring rolled-back message…",
        "Rolled-back message was not restored.",
        "Restoring rolled-back message…",
        "Rolled-back message restored.",
      ])

      dock.update(projection, false)
      summary?.dispatch(event("click").value)
      const escape = event("keydown", "Escape")
      root.dispatch(escape.value)
      equal(escape.prevented(), true)
      equal(escape.stopped(), true)
      equal(list?.hidden, true)
      equal(fakeDocument.activeElement, summary)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })

  it("collapses a fresh projection, reports omissions, and honors disabled state", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
    const fakeDocument = new FakeDocument()
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument })
    try {
      const root = fakeDocument.createElement("section")
      const dock = createRollbackDock(root as unknown as HTMLElement, () => {})
      dock.update({
        count: 3,
        truncated: true,
        messages: [{ key: "opaque_rollback_key_1234", preview: "Visible preview" }],
      }, false)
      const [summary, , list] = root.children
      summary?.dispatch(event("click").value)
      equal(list?.hidden, false)
      equal(list?.children.at(-1)?.textContent, "2 newer rolled-back messages are not shown.")

      dock.update({
        count: 1,
        truncated: false,
        messages: [{ key: "opaque_rollback_key_5678", preview: "Fresh projection" }],
      }, true)
      equal(summary?.getAttribute("aria-expanded"), "false")
      equal(list?.hidden, true)
      equal(list?.querySelectorAll<FakeElement>("button")[0]?.disabled, true)
      dock.update({ count: 0, truncated: false, messages: [] }, false)
      equal(root.hidden, true)
      equal(list?.children.length, 0)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })
})
