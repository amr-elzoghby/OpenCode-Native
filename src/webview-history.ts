import { parseHistoryMessage, type HistoryMessage, type HistorySession } from "./protocol"

export function createHistory(root: HTMLElement, actions: {
  select(key: string): void
  rename(key: string, title: string): void
  delete(key: string): void
}, background: HTMLElement[]) {
  root.setAttribute("role", "dialog")
  root.setAttribute("aria-modal", "true")
  const title = document.createElement("h2")
  title.id = "opencode-history-title"
  title.textContent = "Chats"
  root.setAttribute("aria-labelledby", title.id)
  const close = document.createElement("button")
  close.type = "button"
  close.className = "history-icon"
  close.ariaLabel = "Close history"
  close.title = "Close history"
  close.textContent = "×"
  const headerActions = document.createElement("div")
  headerActions.className = "history-actions"
  headerActions.append(close)
  const header = document.createElement("header")
  header.append(title, headerActions)
  const search = document.createElement("input")
  search.type = "search"
  search.className = "history-search"
  search.id = "opencode-history-search"
  search.placeholder = "Search chats…"
  search.ariaLabel = "Search chats"
  const searchShell = document.createElement("label")
  searchShell.className = "history-search-shell"
  searchShell.append(icon("search"), search)
  const listHeading = document.createElement("div")
  listHeading.className = "history-list-heading"
  const listTitle = document.createElement("span")
  listTitle.textContent = "All chats"
  listHeading.append(listTitle, icon("archive"))
  const status = document.createElement("div")
  status.className = "history-status"
  status.setAttribute("role", "status")
  const list = document.createElement("div")
  list.className = "history-list"
  root.append(header, searchShell, listHeading, status, list)
  root.hidden = true
  let sessions: HistorySession[] = []
  let previousFocus: HTMLElement | undefined
  let accepting = false

  close.addEventListener("click", () => hide())
  search.addEventListener("input", () => render())
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault()
      hide()
      return
    }
    if (event.key !== "Tab") return
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled):not([hidden]), [tabindex]:not([tabindex="-1"])',
    )).filter((item) => !item.hidden)
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
    open() {
      accepting = true
      show()
      sessions = []
      status.textContent = "Loading chats…"
      list.replaceChildren()
      search.focus()
    },
    apply(value: unknown) {
      const message = parseHistoryMessage(value)
      if (!message) return false
      if (!accepting && message.status !== "closed") return true
      apply(message)
      return true
    },
    isOpen() {
      return !root.hidden
    },
    close() {
      hide()
    },
  }

  function apply(message: HistoryMessage) {
    if (message.status === "closed") {
      hide()
      return
    }
    show()
    sessions = message.sessions
    status.textContent = message.status === "loading"
      ? "Loading chats…"
      : message.status === "error"
        ? message.error
        : ""
    render()
  }

  function render() {
    const query = search.value.trim().toLocaleLowerCase()
    const visible = query ? sessions.filter((session) => session.title.toLocaleLowerCase().includes(query)) : sessions
    list.replaceChildren(...visible.map(sessionButton))
    if (!visible.length && !status.textContent) status.textContent = query ? "No matching chats." : "No chats yet."
    if (visible.length && status.textContent === "No matching chats.") status.textContent = ""
  }

  function sessionButton(session: HistorySession) {
    const row = document.createElement("div")
    row.className = "history-session"
    row.dataset.sessionKey = session.key
    row.classList.toggle("current", session.current)
    const button = document.createElement("button")
    button.type = "button"
    button.className = "history-open"
    const updated = formatRelativeTime(session.updated)
    button.ariaLabel = `Open ${session.title}, updated ${updated === "now" ? "now" : `${updated} ago`}`
    const name = document.createElement("span")
    name.className = "history-title"
    name.dir = "auto"
    name.textContent = session.title
    const detail = document.createElement("span")
    detail.className = "history-detail"
    detail.textContent = updated
    if (session.status === "busy" || session.status === "retry") detail.textContent += ` · ${session.status}`
    button.append(name, detail)
    button.addEventListener("click", () => {
      status.textContent = "Opening chat…"
      actions.select(session.key)
    })
    const edit = iconButton("edit", `Rename ${session.title}`)
    const remove = iconButton("trash", `Delete ${session.title}`)
    edit.addEventListener("click", () => rename(row, session))
    remove.addEventListener("click", () => actions.delete(session.key))
    const itemActions = document.createElement("div")
    itemActions.className = "history-item-actions"
    itemActions.append(edit, remove)
    row.append(button, itemActions)
    return row
  }

  function rename(row: HTMLElement, session: HistorySession) {
    const input = document.createElement("input")
    input.type = "text"
    input.className = "history-rename"
    input.value = session.title
    input.maxLength = 120
    input.ariaLabel = `Rename ${session.title}`
    const save = iconButton("check", "Save chat title")
    const cancel = iconButton("close", "Cancel rename")
    const finish = (submit: boolean) => {
      if (submit) actions.rename(session.key, input.value)
      render()
      list.querySelector<HTMLElement>(`[data-session-key="${session.key}"] .history-open`)?.focus()
    }
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== "Escape") return
      event.preventDefault()
      finish(event.key === "Enter")
    })
    save.addEventListener("click", () => finish(true))
    cancel.addEventListener("click", () => finish(false))
    row.replaceChildren(input, save, cancel)
    input.select()
  }

  function hide() {
    accepting = false
    root.hidden = true
    search.value = ""
    background.forEach((item) => {
      item.inert = false
      item.removeAttribute("aria-hidden")
    })
    previousFocus?.focus()
    previousFocus = undefined
  }

  function show() {
    if (root.hidden) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      background.forEach((item) => {
        item.inert = true
        item.setAttribute("aria-hidden", "true")
      })
    }
    root.hidden = false
  }
}

function iconButton(name: "edit" | "trash" | "check" | "close", label: string) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "history-row-action"
  button.append(icon(name))
  button.ariaLabel = label
  button.title = label
  return button
}

export function formatRelativeTime(value: number, now = Date.now()) {
  const elapsed = Math.max(0, now - value)
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.floor(elapsed / 86_400_000)}d`
}

function icon(name: "search" | "archive" | "edit" | "trash" | "check" | "close") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("aria-hidden", "true")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("fill", "none")
  path.setAttribute("stroke", "currentColor")
  path.setAttribute("stroke-linecap", "round")
  path.setAttribute("stroke-linejoin", "round")
  path.setAttribute("d", {
    search: "M11.5 11.5 15 15m-2-8A6 6 0 1 1 1 7a6 6 0 0 1 12 0Z",
    archive: "M2 5.5h12v8H2zM1 2.5h14v3H1zm5 6h4",
    edit: "m3 13 2.5-.5 7.7-7.7-2-2-7.7 7.7L3 13Z",
    trash: "M3 4h10m-8 0 .5 10h5L11 4M6 4l.5-2h3l.5 2M7 7v4m2-4v4",
    check: "m3 8 3 3 7-7",
    close: "m4 4 8 8m0-8-8 8",
  }[name])
  svg.append(path)
  return svg
}
