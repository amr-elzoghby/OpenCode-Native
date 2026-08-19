import type { ViewState } from "./protocol"
import type { UsageTokens, UsageTotals } from "./usage"

type Message = ViewState["messages"][number]
type Model = ViewState["models"][number]

export type ContextUsage = {
  message: Message
  tokens?: UsageTokens
  model?: Model
  limit?: number
  percent?: number
}

export function deriveContextUsage(messages: Message[], models: Model[]): ContextUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== "assistant" || message.response?.completedAt === undefined) continue
    const tokens = message.response.contextTokens
    const model = models.find((item) =>
      item.providerID === message.response?.providerID && item.id === message.response?.modelID
    )
    const limit = model?.contextLimit
    return {
      message,
      ...(tokens ? { tokens } : {}),
      model,
      limit,
      ...(tokens && limit ? { percent: (tokens.total / limit) * 100 } : {}),
    }
  }
}

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

export function formatPercent(value: number | undefined) {
  return value === undefined ? "—" : `${Math.round(value)}%`
}

export function createUsage(root: HTMLElement) {
  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "usage-trigger"
  trigger.setAttribute("aria-haspopup", "dialog")
  trigger.setAttribute("aria-expanded", "false")
  trigger.setAttribute("aria-controls", "usage-details")
  trigger.setAttribute("aria-describedby", "usage-tooltip")
  const ring = document.createElement("span")
  ring.className = "usage-ring"
  ring.setAttribute("aria-hidden", "true")
  trigger.append(ring)

  const tooltip = document.createElement("div")
  tooltip.id = "usage-tooltip"
  tooltip.className = "usage-tooltip"
  tooltip.setAttribute("role", "tooltip")

  const panel = document.createElement("section")
  panel.id = "usage-details"
  panel.className = "usage-details"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-label", "OpenCode usage details")
  panel.tabIndex = -1
  panel.hidden = true
  root.append(trigger, tooltip, panel)

  trigger.addEventListener("click", () => setOpen(panel.hidden))
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return
    event.stopPropagation()
    setOpen(false)
    trigger.focus()
  })
  document.addEventListener("click", (event) => {
    if (panel.hidden || (event.target instanceof Node && root.contains(event.target))) return
    setOpen(false)
  })

  return {
    update(messages: Message[], models: Model[], providers: ViewState["providers"], session: UsageTotals) {
      const context = deriveContextUsage(messages, models)
      const visible = !!context || session.cost !== undefined || !!session.tokens
      root.hidden = !visible
      if (!visible) {
        setOpen(false)
        return
      }
      const cost = formatCost(session.cost)
      const percent = formatPercent(context?.percent)
      const tokens = formatTokens(context?.tokens?.total)
      const progress = Math.min(100, Math.max(0, context?.percent ?? 0))
      ring.style.setProperty("--usage-progress", `${progress * 3.6}deg`)
      ring.dataset.overLimit = String((context?.percent ?? 0) > 100)
      trigger.title = `Cost ${cost} · Usage ${percent} · Tokens ${tokens}`
      trigger.setAttribute("aria-label", `View usage details. Cost ${cost}. Usage ${percent}. Tokens ${tokens}.`)
      tooltip.replaceChildren(
        compactRows([
          ["Cost", cost],
          ["Usage", percent],
          ["Tokens", tokens],
        ]),
      )

      const contextTitle = document.createElement("h3")
      contextTitle.textContent = "Current context"
      const contextModel = context?.model?.name ?? context?.message.response?.modelID
      const contextProvider = providers.find((provider) =>
        provider.id === context?.message.response?.providerID
      )?.name ?? context?.message.response?.providerID
      const contextDetails = descriptionList([
        ["Provider", contextProvider ?? "—", "auto"],
        ["Model", contextModel ?? "—", "auto"],
        ["Limit", formatTokens(context?.limit)],
        ["Tokens", tokens],
        ["Usage", percent],
      ])
      const sessionTitle = document.createElement("h3")
      sessionTitle.textContent = "Session total"
      const sessionDetails = descriptionList([
        ["Cost", cost],
        ["Input", formatTokens(session.tokens?.input)],
        ["Output", formatTokens(session.tokens?.output)],
        ["Reasoning", formatTokens(session.tokens?.reasoning)],
        ["Cache read", formatTokens(session.tokens?.cacheRead)],
        ["Cache write", formatTokens(session.tokens?.cacheWrite)],
        ["Tokens", formatTokens(session.tokens?.total)],
      ])
      panel.replaceChildren(contextTitle, contextDetails, sessionTitle, sessionDetails)
    },
  }

  function setOpen(open: boolean) {
    panel.hidden = !open
    trigger.setAttribute("aria-expanded", String(open))
    if (open) panel.focus()
  }
}

function compactRows(rows: Array<[string, string]>) {
  const wrapper = document.createElement("div")
  rows.forEach(([label, value]) => {
    const row = document.createElement("div")
    const name = document.createElement("span")
    name.textContent = label
    const number = document.createElement("bdi")
    number.dir = "ltr"
    number.textContent = value
    row.append(name, number)
    wrapper.append(row)
  })
  return wrapper
}

function descriptionList(rows: Array<[string, string, ("auto" | "ltr")?]>) {
  const list = document.createElement("dl")
  rows.forEach(([label, value, direction]) => {
    const term = document.createElement("dt")
    term.textContent = label
    const detail = document.createElement("dd")
    const isolated = document.createElement("bdi")
    isolated.dir = direction ?? "ltr"
    isolated.textContent = value
    detail.append(isolated)
    list.append(term, detail)
  })
  return list
}
