import type { ViewState } from "./protocol"

type Message = ViewState["messages"][number]

export function createTimeline(
  root: HTMLElement,
  select: (turnID: string) => boolean,
  background: HTMLElement[],
) {
  root.setAttribute("role", "dialog")
  root.setAttribute("aria-modal", "true")
  const title = document.createElement("h2")
  title.id = "opencode-timeline-title"
  title.textContent = "Timeline"
  root.setAttribute("aria-labelledby", title.id)
  const close = document.createElement("button")
  close.type = "button"
  close.className = "history-icon"
  close.ariaLabel = "Close timeline"
  close.title = "Close timeline"
  close.textContent = "×"
  const header = document.createElement("header")
  header.append(title, close)
  const search = document.createElement("input")
  search.type = "search"
  search.className = "history-search"
  search.placeholder = "Search turns…"
  search.ariaLabel = "Search turns"
  const searchShell = document.createElement("label")
  searchShell.className = "history-search-shell"
  searchShell.append("⌕", search)
  const heading = document.createElement("div")
  heading.className = "history-list-heading"
  heading.textContent = "User turns"
  const status = document.createElement("div")
  status.className = "history-status"
  status.setAttribute("role", "status")
  const list = document.createElement("div")
  list.className = "history-list"
  root.classList.add("history", "timeline")
  root.replaceChildren(header, searchShell, heading, status, list)
  root.hidden = true
  let messages: Message[] = []
  let previousFocus: HTMLElement | undefined

  close.addEventListener("click", hide)
  search.addEventListener("input", render)
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault()
      hide()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>("button"))
      if (!buttons.length) return
      event.preventDefault()
      const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
      buttons[(current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      return
    }
    if (event.key !== "Tab") return
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled):not([hidden]), [tabindex]:not([tabindex="-1"])',
    )).filter((item) => !item.hidden)
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  return {
    open(value: Message[]) {
      messages = value.filter((message) => message.role === "user")
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      background.forEach((item) => {
        item.inert = true
        item.setAttribute("aria-hidden", "true")
      })
      root.hidden = false
      search.value = ""
      render()
      search.focus()
    },
    close: hide,
    isOpen() {
      return !root.hidden
    },
  }

  function render() {
    const query = search.value.trim().toLocaleLowerCase()
    const visible = messages.filter((message) => !query || message.text.toLocaleLowerCase().includes(query))
    list.replaceChildren(...visible.map((message, index) => {
      const row = document.createElement("div")
      row.className = "history-session timeline-turn"
      const button = document.createElement("button")
      button.type = "button"
      button.className = "history-open"
      const name = document.createElement("span")
      name.className = "history-title"
      name.dir = "auto"
      name.textContent = preview(message.text) || `Turn ${index + 1}`
      const detail = document.createElement("span")
      detail.className = "history-detail"
      detail.textContent = message.createdAt === undefined ? `#${index + 1}` : safeTime(message.createdAt)
      button.append(name, detail)
      button.addEventListener("click", () => {
        if (select(message.turnID)) hide()
      })
      row.append(button)
      return row
    }))
    status.textContent = visible.length ? "" : query ? "No matching turns." : "No user turns yet."
  }

  function hide() {
    if (root.hidden) return
    root.hidden = true
    background.forEach((item) => {
      item.inert = false
      item.removeAttribute("aria-hidden")
    })
    previousFocus?.focus()
    previousFocus = undefined
  }
}

function preview(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 120)
}

function safeTime(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value)
}
