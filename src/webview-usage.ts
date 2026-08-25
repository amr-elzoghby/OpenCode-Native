import type { UsageTotals } from "./usage"

export function formatCost(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—"
  if (value === 0) return "$0.00"
  if (value < 1e-12) return `$${value.toExponential(2)}`
  const leadingZeros = Math.max(0, Math.ceil(-Math.log10(value)))
  const digits = Math.min(12, Math.max(2, leadingZeros + 2))
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  })}`
}

export function formatTokens(value: number | undefined) {
  return value === undefined ? "—" : value.toLocaleString()
}

export function chatUsageRows(session: UsageTotals): Array<[string, string]> {
  return [
    ["Cost", formatCost(session.cost)],
    ["Input", formatTokens(session.tokens?.input)],
    ["Output", formatTokens(session.tokens?.output)],
    ["Reasoning", formatTokens(session.tokens?.reasoning)],
    ["Cache read", formatTokens(session.tokens?.cacheRead)],
    ["Cache write", formatTokens(session.tokens?.cacheWrite)],
    ["Tokens", formatTokens(session.tokens?.total)],
  ]
}

export function createUsage(root: HTMLElement, restoreFocus: () => void) {
  const panel = document.createElement("section")
  panel.id = "usage-details"
  panel.className = "usage-details"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-label", "OpenCode chat token details")
  panel.tabIndex = -1
  panel.hidden = true
  const header = document.createElement("header")
  header.className = "usage-header"
  const title = document.createElement("h2")
  title.textContent = "Chat tokens"
  const close = document.createElement("button")
  close.type = "button"
  close.className = "usage-close"
  close.title = "Close"
  close.setAttribute("aria-label", "Close chat token details")
  close.textContent = "×"
  header.append(title, close)
  root.append(panel)

  close.addEventListener("click", () => setOpen(false, true))
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return
    event.stopPropagation()
    setOpen(false, true)
  })
  document.addEventListener("click", (event) => {
    if (panel.hidden || (event.target instanceof Node && root.contains(event.target))) return
    setOpen(false)
  })

  let available = false
  return {
    open() {
      if (!available) return false
      setOpen(true)
      return true
    },
    update(session: UsageTotals) {
      available = session.tokens?.total !== undefined
      const restore = !available && root.contains(document.activeElement)
      root.hidden = !available
      if (!available) {
        setOpen(false, restore)
        return
      }
      const breakdown = document.createElement("div")
      breakdown.className = "usage-breakdown"
      breakdown.append(descriptionList(chatUsageRows(session)))
      const note = document.createElement("p")
      note.className = "usage-note"
      note.textContent = "Calculated from OpenCode's input, output, reasoning, cache-read, and cache-write counters for this chat."
      panel.replaceChildren(header, breakdown, note)
    },
  }

  function setOpen(open: boolean, focus = false) {
    panel.hidden = !open
    if (open) panel.focus()
    if (!open && focus) restoreFocus()
  }
}

function descriptionList(rows: Array<[string, string]>) {
  const list = document.createElement("dl")
  rows.forEach(([label, value]) => {
    const term = document.createElement("dt")
    term.textContent = label
    const detail = document.createElement("dd")
    const isolated = document.createElement("bdi")
    isolated.dir = "ltr"
    isolated.textContent = value
    detail.append(isolated)
    list.append(term, detail)
  })
  return list
}
