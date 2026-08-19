import type { ViewState } from "./protocol"

type RolledBack = ViewState["rolledBack"]

export function createRollbackDock(
  root: HTMLElement,
  restore: (key: string) => void,
  announce?: (message: string) => void,
  focusFallback?: () => void,
) {
  const summary = document.createElement("button")
  summary.type = "button"
  summary.className = "rollback-summary"
  summary.setAttribute("aria-expanded", "false")
  const label = document.createElement("span")
  label.className = "rollback-label"
  const hint = document.createElement("span")
  hint.id = "opencode-rollback-hint"
  hint.className = "rollback-hint"
  hint.textContent = "Select a message to restore this point in the conversation."
  const chevron = document.createElement("span")
  chevron.className = "rollback-chevron"
  chevron.setAttribute("aria-hidden", "true")
  summary.append(label, chevron)
  summary.setAttribute("aria-describedby", hint.id)

  const list = document.createElement("div")
  list.id = "opencode-rollback-list"
  list.className = "rollback-list"
  list.setAttribute("role", "list")
  list.hidden = true
  summary.setAttribute("aria-controls", list.id)
  root.append(summary, hint, list)
  root.setAttribute("aria-busy", "false")
  root.hidden = true

  let expanded = false
  let signature = ""
  let pendingKey: string | undefined
  let disabled = false
  let value: RolledBack = { count: 0, truncated: false, messages: [] }

  summary.addEventListener("click", () => setExpanded(!expanded))
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !expanded) return
    event.preventDefault()
    event.stopPropagation()
    setExpanded(false)
    summary.focus()
  })

  return {
    update(next: RolledBack, nextDisabled: boolean) {
      const nextSignature = next.messages.map((message) => message.key).join("\u0000")
      const changed = nextSignature !== signature
      if (changed) {
        signature = nextSignature
        expanded = false
      }
      disabled = nextDisabled
      value = next
      render(changed)
    },
    resolve(key: string, status: "restored" | "rejected") {
      if (pendingKey !== key) return false
      pendingKey = undefined
      announce?.(status === "restored"
        ? "Rolled-back message restored."
        : "Rolled-back message was not restored.")
      render(false)
      if (root.hidden) focusFallback?.()
      else summary.focus()
      return true
    },
  }

  function setExpanded(next: boolean) {
    if (!value.count) return
    expanded = next
    summary.setAttribute("aria-expanded", String(expanded))
    list.hidden = !expanded
  }

  function render(rebuild = true) {
    root.hidden = value.count === 0
    root.setAttribute("aria-busy", String(pendingKey !== undefined))
    if (!value.count) {
      expanded = false
      summary.setAttribute("aria-expanded", "false")
      list.hidden = true
      if (rebuild) list.replaceChildren()
      return
    }
    label.textContent = `${value.count} rolled back ${value.count === 1 ? "message" : "messages"}`
    summary.title = expanded ? "Collapse rolled-back messages" : "Show rolled-back messages"
    summary.setAttribute("aria-expanded", String(expanded))
    list.hidden = !expanded
    if (rebuild) {
      list.replaceChildren(...value.messages.map((message, index) => row(message, index)))
      if (value.truncated) {
        const omitted = document.createElement("p")
        omitted.className = "rollback-omitted"
        omitted.setAttribute("role", "listitem")
        omitted.textContent = `${value.count - value.messages.length} newer rolled-back messages are not shown.`
        list.append(omitted)
      }
    } else {
      list.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
        button.disabled = disabled || pendingKey !== undefined
      })
    }
  }

  function row(message: RolledBack["messages"][number], index: number) {
    const item = document.createElement("div")
    item.className = "rollback-item"
    item.setAttribute("role", "listitem")
    const content = document.createElement("div")
    content.className = "rollback-content"
    const preview = document.createElement("span")
    preview.className = "rollback-preview"
    preview.dir = "auto"
    preview.textContent = message.preview
    content.append(preview)
    if (message.createdAt !== undefined) {
      const time = document.createElement("time")
      time.className = "rollback-time"
      time.dateTime = new Date(message.createdAt).toISOString()
      time.textContent = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(message.createdAt)
      content.append(time)
    }
    const button = document.createElement("button")
    button.type = "button"
    button.className = "rollback-restore"
    button.textContent = "Restore message"
    button.ariaLabel = `Restore rolled-back message ${index + 1}`
    button.title = "Restore this message, its response, and earlier rolled-back messages"
    button.disabled = disabled || pendingKey !== undefined
    button.addEventListener("click", () => {
      if (disabled || pendingKey !== undefined) return
      pendingKey = message.key
      root.setAttribute("aria-busy", "true")
      list.querySelectorAll<HTMLButtonElement>("button").forEach((candidate) => { candidate.disabled = true })
      announce?.("Restoring rolled-back message…")
      restore(message.key)
    })
    item.append(content, button)
    return item
  }
}
