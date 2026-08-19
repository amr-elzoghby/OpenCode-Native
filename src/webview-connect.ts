import {
  parseProviderConnectMessage,
  type ProviderConnectMessage,
} from "./protocol"

type ProviderOption = Extract<ProviderConnectMessage, { status: "providers" }>["providers"][number]
type MethodOption = Extract<ProviderConnectMessage, { status: "methods" }>["methods"][number]

export function createProviderConnect(root: HTMLElement, actions: {
  activate(): void
  close(): void
  provider(key: string): void
  method(key: string): void
}, background: HTMLElement[]) {
  root.setAttribute("role", "dialog")
  root.setAttribute("aria-modal", "true")
  const title = document.createElement("h2")
  title.id = "opencode-provider-connect-title"
  title.textContent = "Connect a provider"
  root.setAttribute("aria-labelledby", title.id)
  const back = iconButton("‹", "Back to providers")
  back.classList.add("provider-connect-back")
  back.hidden = true
  const heading = document.createElement("div")
  heading.className = "provider-connect-heading"
  heading.append(back, title)
  const close = iconButton("×", "Close provider connection")
  const header = document.createElement("header")
  header.append(heading, close)

  const search = document.createElement("input")
  search.type = "search"
  search.className = "provider-connect-search"
  search.placeholder = "Search providers…"
  search.ariaLabel = "Search providers"
  const searchShell = document.createElement("label")
  searchShell.className = "provider-connect-search-shell"
  searchShell.append(search)
  const status = document.createElement("div")
  status.className = "provider-connect-status"
  status.setAttribute("role", "status")
  const list = document.createElement("div")
  list.className = "provider-connect-list"
  root.append(header, searchShell, status, list)
  root.hidden = true

  let providers: ProviderOption[] = []
  let methods: MethodOption[] = []
  let mode: "providers" | "methods" = "providers"
  let previousFocus: HTMLElement | undefined
  let busy = false

  close.addEventListener("click", dismiss)
  back.addEventListener("click", () => {
    if (!busy) showProviders()
  })
  search.addEventListener("input", () => renderProviders())
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (event.isComposing) return
      event.preventDefault()
      if (!busy && mode === "methods" && providers.length) showProviders()
      else dismiss()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return
      const options = Array.from(list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
      if (!options.length) return
      const active = document.activeElement
      const current = options.indexOf(active as HTMLButtonElement)
      if (current < 0 && active !== search) return
      // Keep Home/End available for normal caret movement in the editable search.
      if (active === search && (event.key === "Home" || event.key === "End")) return
      event.preventDefault()
      const target = event.key === "Home" || (current < 0 && event.key === "ArrowDown")
        ? 0
        : event.key === "End" || (current < 0 && event.key === "ArrowUp")
          ? options.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
      options[target]?.focus()
      return
    }
    if (event.key !== "Tab") return
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])',
    )).filter((item) => !item.closest("[hidden]"))
    if (!focusable.length) return
    const first = focusable[0]!
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  return {
    apply(value: unknown) {
      const message = parseProviderConnectMessage(value)
      if (!message) return false
      if (message.status === "closed") {
        hide()
        return true
      }
      show()
      if (message.status === "loading") {
        providers = []
        methods = []
        setBusy(message.message)
        return true
      }
      if (message.status === "busy") {
        setBusy(message.message)
        return true
      }
      if (message.status === "error") {
        busy = false
        root.setAttribute("aria-busy", "false")
        if (providers.length) showProviders()
        status.textContent = message.message
        status.classList.add("error")
        enableControls()
        if (!providers.length) close.focus()
        return true
      }
      if (message.status === "providers") {
        busy = false
        root.setAttribute("aria-busy", "false")
        providers = message.providers
        showProviders()
        return true
      }
      methods = message.methods
      busy = false
      root.setAttribute("aria-busy", "false")
      mode = "methods"
      title.textContent = message.provider
      searchShell.hidden = true
      back.hidden = false
      back.disabled = false
      status.textContent = "Choose how to connect"
      status.classList.remove("error")
      list.replaceChildren(...methods.map(methodButton))
      list.querySelector<HTMLButtonElement>("button")?.focus()
      return true
    },
    isOpen() {
      return !root.hidden
    },
    close() {
      if (root.hidden) return
      dismiss()
    },
  }

  function showProviders() {
    busy = false
    mode = "providers"
    methods = []
    title.textContent = "Connect a provider"
    searchShell.hidden = false
    search.disabled = false
    back.hidden = true
    back.disabled = false
    status.textContent = providers.length ? "" : "No providers are available."
    status.classList.remove("error")
    renderProviders()
    search.focus()
  }

  function renderProviders() {
    const query = search.value.trim().toLocaleLowerCase()
    const visible = providers.filter((provider) => !query ||
      `${provider.name} ${provider.description ?? ""}`.toLocaleLowerCase().includes(query))
    list.replaceChildren(...(["Popular", "Providers"] as const).flatMap((category) => {
      const items = visible.filter((provider) => provider.category === category)
      if (!items.length) return []
      const heading = document.createElement("div")
      heading.className = "provider-connect-category"
      heading.textContent = category
      heading.setAttribute("role", "heading")
      heading.setAttribute("aria-level", "3")
      return [heading, ...items.map(providerButton)]
    }))
    if (!visible.length) status.textContent = query ? "No matching providers." : "No providers are available."
    if (visible.length) status.textContent = ""
  }

  function providerButton(provider: ProviderOption) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "provider-connect-option"
    button.dataset.providerKey = provider.key
    button.ariaLabel = `${provider.name}${provider.connected ? ", connected" : ""}${provider.description ? ` ${provider.description}` : ""}`
    const name = document.createElement("span")
    name.className = "provider-connect-name"
    name.dir = "auto"
    name.textContent = provider.name
    const description = document.createElement("span")
    description.className = "provider-connect-description"
    description.dir = "auto"
    description.textContent = provider.description ?? ""
    const check = document.createElement("span")
    check.className = "provider-connect-check"
    check.ariaHidden = "true"
    check.textContent = provider.connected ? "✓" : ""
    button.append(check, name, description)
    button.addEventListener("click", () => {
      setBusy(`Loading ${provider.name} sign-in methods…`)
      actions.provider(provider.key)
    })
    return button
  }

  function methodButton(method: MethodOption) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "provider-connect-method"
    const label = document.createElement("span")
    label.dir = "auto"
    label.textContent = method.label
    const detail = document.createElement("span")
    detail.textContent = method.type === "oauth" ? "Subscription / OAuth" : "API key"
    button.append(label, detail)
    button.addEventListener("click", () => {
      setBusy(`Starting ${method.label}…`)
      actions.method(method.key)
    })
    return button
  }

  function setBusy(message: string) {
    busy = true
    root.setAttribute("aria-busy", "true")
    title.textContent = "Connect a provider"
    searchShell.hidden = true
    back.hidden = true
    status.classList.remove("error")
    status.textContent = message
    list.replaceChildren()
    close.focus()
  }

  function enableControls() {
    root.setAttribute("aria-busy", "false")
    list.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = false })
    back.disabled = false
    search.disabled = false
  }

  function show() {
    if (root.hidden) {
      actions.activate()
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      background.forEach((item) => {
        item.inert = true
        item.setAttribute("aria-hidden", "true")
      })
    }
    root.hidden = false
  }

  function dismiss() {
    actions.close()
    hide()
  }

  function hide() {
    root.hidden = true
    providers = []
    methods = []
    busy = false
    root.setAttribute("aria-busy", "false")
    search.value = ""
    background.forEach((item) => {
      item.inert = false
      item.removeAttribute("aria-hidden")
    })
    previousFocus?.focus()
    previousFocus = undefined
  }
}

function iconButton(text: string, label: string) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "provider-connect-icon"
  button.textContent = text
  button.ariaLabel = label
  button.title = label
  return button
}
