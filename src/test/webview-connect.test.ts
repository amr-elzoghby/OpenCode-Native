import { equal } from "node:assert/strict"
import { createProviderConnect } from "../webview-connect"

type FakeKeyboardEvent = {
  type: "keydown"
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing: boolean
  preventDefault(): void
}

class FakeDocument {
  activeElement?: FakeElement

  createElement(tag: string) {
    return new FakeElement(tag, this)
  }
}

class FakeElement {
  ariaHidden = ""
  ariaLabel = ""
  className = ""
  dataset: Record<string, string> = {}
  dir = ""
  disabled = false
  hidden = false
  id = ""
  inert = false
  placeholder = ""
  textContent = ""
  title = ""
  type = ""
  value = ""
  readonly children: FakeElement[] = []
  readonly classList = { add() {}, remove() {} }
  private parent?: FakeElement
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Array<(event: FakeKeyboardEvent) => void>>()

  constructor(readonly tagName: string, private readonly owner: FakeDocument) {}

  append(...children: FakeElement[]) {
    children.forEach((child) => {
      child.parent = this
      this.children.push(child)
    })
  }

  replaceChildren(...children: FakeElement[]) {
    this.children.splice(0, this.children.length)
    this.append(...children)
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
  }

  addEventListener(type: string, listener: (event: FakeKeyboardEvent) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatch(event: FakeKeyboardEvent) {
    this.listeners.get(event.type)?.forEach((listener) => listener(event))
  }

  focus() {
    this.owner.activeElement = this
  }

  closest(selector: string) {
    if (selector !== "[hidden]") return undefined
    if (this.hidden) return this
    let item = this.parent
    while (item) {
      if (item.hidden) return item
      item = item.parent
    }
  }

  querySelector<T>(selector: string) {
    return this.querySelectorAll<T>(selector)[0]
  }

  querySelectorAll<T>(selector: string) {
    const descendants: FakeElement[] = []
    const visit = (item: FakeElement) => {
      item.children.forEach((child) => {
        descendants.push(child)
        visit(child)
      })
    }
    visit(this)
    return descendants.filter((item) => matches(item, selector)) as T[]
  }
}

function matches(item: FakeElement, selector: string) {
  const tag = item.tagName.toLowerCase()
  if (selector === "button") return tag === "button"
  if (selector === "button:not(:disabled)") return tag === "button" && !item.disabled
  if (!selector.includes(",")) return tag === selector
  if (item.hidden || item.disabled) return false
  return tag === "button" || tag === "input"
}

function keyEvent(key: string, modifiers: Partial<Pick<FakeKeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">> = {}) {
  let prevented = false
  return {
    event: {
      type: "keydown" as const,
      key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      ...modifiers,
      preventDefault() { prevented = true },
    },
    prevented: () => prevented,
  }
}

describe("provider connection keyboard navigation", () => {
  it("preserves search editing keys and navigates provider options explicitly", () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
    const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement")
    const fakeDocument = new FakeDocument()
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument })
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement })
    try {
      let closed = 0
      const root = fakeDocument.createElement("section")
      const background = fakeDocument.createElement("main")
      const previous = fakeDocument.createElement("button")
      previous.focus()
      const connect = createProviderConnect(
        root as unknown as HTMLElement,
        { activate() {}, close() { closed++ }, provider() {}, method() {} },
        [background as unknown as HTMLElement],
      )
      equal(connect.apply({
        type: "providerConnect",
        status: "providers",
        providers: [
          { key: "opaque_provider_0001", name: "OpenCode", connected: true, category: "Popular" },
          { key: "opaque_provider_0002", name: "OpenAI", connected: false, category: "Popular" },
        ],
      }), true)

      const search = root.querySelector<FakeElement>("input")!
      const list = root.children.at(-1)!
      const options = list.querySelectorAll<FakeElement>("button:not(:disabled)")
      equal(fakeDocument.activeElement, search)

      for (const candidate of [
        keyEvent("Home"),
        keyEvent("End"),
        keyEvent("End", { shiftKey: true }),
        keyEvent("Home", { ctrlKey: true }),
        keyEvent("ArrowDown", { metaKey: true }),
        keyEvent("ArrowUp", { altKey: true }),
        keyEvent("ArrowDown", { isComposing: true }),
      ]) {
        root.dispatch(candidate.event)
        equal(candidate.prevented(), false)
        equal(fakeDocument.activeElement, search)
      }

      const composingEscape = keyEvent("Escape", { isComposing: true })
      root.dispatch(composingEscape.event)
      equal(composingEscape.prevented(), false)
      equal(connect.isOpen(), true)
      equal(closed, 0)

      const down = keyEvent("ArrowDown")
      root.dispatch(down.event)
      equal(down.prevented(), true)
      equal(fakeDocument.activeElement, options[0])

      const end = keyEvent("End")
      root.dispatch(end.event)
      equal(end.prevented(), true)
      equal(fakeDocument.activeElement, options[1])

      const home = keyEvent("Home")
      root.dispatch(home.event)
      equal(home.prevented(), true)
      equal(fakeDocument.activeElement, options[0])
    } finally {
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor)
      else Reflect.deleteProperty(globalThis, "document")
      if (elementDescriptor) Object.defineProperty(globalThis, "HTMLElement", elementDescriptor)
      else Reflect.deleteProperty(globalThis, "HTMLElement")
    }
  })
})
