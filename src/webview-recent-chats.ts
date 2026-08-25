import {
  MAX_RECENT_CHATS,
  parseRecentChatsMessage,
  type HistorySession,
  type RecentChatsMessage,
} from "./protocol"
import { formatRelativeTime } from "./webview-history"

export function recentChatItems(sessions: HistorySession[]) {
  return sessions.slice(0, MAX_RECENT_CHATS)
}

export function createRecentChats(root: HTMLElement, actions: {
  select(key: string): void
  viewAll(): void
  restoreFocus(): void
}) {
  root.setAttribute("aria-labelledby", "opencode-recent-chats-title")
  const title = document.createElement("h2")
  title.id = "opencode-recent-chats-title"
  title.textContent = "Chats"
  const list = document.createElement("ul")
  list.className = "recent-chat-list"
  const status = document.createElement("div")
  status.className = "recent-chat-status"
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const viewAll = document.createElement("button")
  viewAll.type = "button"
  viewAll.className = "recent-chat-view-all"
  viewAll.textContent = "View all"
  viewAll.addEventListener("click", () => {
    if (interactionDisabled()) return
    opening = true
    sync()
    actions.viewAll()
  })
  root.append(title, list, status, viewAll)
  root.hidden = true

  let message: RecentChatsMessage = { type: "recentChats", status: "closed", sessions: [] }
  let empty = false
  let disabled = true
  let opening = false
  let openingRefresh = false

  return {
    apply(value: unknown) {
      const parsed = parseRecentChatsMessage(value)
      if (!parsed) return false
      message = parsed
      if (opening && parsed.status === "loading") openingRefresh = true
      if (parsed.status === "closed" || parsed.status === "error" || (parsed.status === "ready" && openingRefresh)) {
        opening = false
        openingRefresh = false
      }
      if (parsed.status !== "loading" || list.children.length === 0) renderList()
      sync()
      return true
    },
    update(show: boolean, controlsDisabled: boolean) {
      empty = show
      disabled = controlsDisabled
      if (!show) {
        opening = false
        openingRefresh = false
      }
      sync()
    },
  }

  function renderList() {
    const sessions = recentChatItems(message.sessions)
    list.replaceChildren(...sessions.map(sessionItem))
  }

  function sync() {
    const sessions = recentChatItems(message.sessions)
    const visible = empty && message.status !== "closed"
    const inaccessible = interactionDisabled()
    if ((inaccessible || !visible) && root.contains(document.activeElement)) actions.restoreFocus()
    root.hidden = !visible
    root.setAttribute("aria-busy", String(message.status === "loading" || opening))
    Array.from(list.querySelectorAll<HTMLButtonElement>("button")).forEach((button) => {
      button.disabled = inaccessible
    })
    status.textContent = opening
      ? "Opening chat…"
      : message.status === "loading"
      ? sessions.length ? "Refreshing chats…" : "Loading chats…"
      : message.status === "error"
        ? sessions.length ? "Could not refresh chats. Showing the previous list." : "Could not load recent chats."
        : sessions.length ? "" : "No chats yet."
    viewAll.hidden = sessions.length === 0
    viewAll.disabled = interactionDisabled()
  }

  function sessionItem(session: HistorySession) {
    const item = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.className = "recent-chat-open"
    button.disabled = interactionDisabled()
    if (session.current) button.setAttribute("aria-current", "page")
    const updated = formatRelativeTime(session.updated)
    button.ariaLabel = `Open ${session.title}, updated ${updated === "now" ? "now" : `${updated} ago`}`
    const name = document.createElement("span")
    name.className = "recent-chat-title"
    name.dir = "auto"
    name.textContent = session.title
    const detail = document.createElement("bdi")
    detail.className = "recent-chat-detail"
    detail.dir = "ltr"
    detail.textContent = updated
    if (session.status === "busy" || session.status === "retry") detail.textContent += ` · ${session.status}`
    button.append(name, detail)
    button.addEventListener("click", () => {
      if (interactionDisabled()) return
      opening = true
      openingRefresh = false
      sync()
      actions.select(session.key)
    })
    item.append(button)
    return item
  }

  function interactionDisabled() {
    return disabled || opening || message.status === "loading"
  }
}
