const MAX_STATUS_ITEMS = 200
const MAX_STATUS_NAME = 160
const MAX_STATUS_DETAIL = 500

export type McpSummary = {
  name: string
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"
}

export type SystemStatusItem = {
  kind: "mcp" | "lsp" | "formatter"
  name: string
  status: string
  detail?: string
}

export function mcpSummaries(value: unknown): McpSummary[] {
  const statuses = record(value)
  if (!statuses) return []
  return Object.entries(statuses)
    .slice(0, MAX_STATUS_ITEMS)
    .flatMap(([name, value]): McpSummary[] => {
      const item = record(value)
      if (!display(name, MAX_STATUS_NAME) || !mcpStatus(item?.status)) return []
      return [{ name, status: item.status }]
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function systemStatusItems(mcpValue: unknown, lspValue: unknown, formatterValue: unknown): SystemStatusItem[] {
  const mcp = mcpSummaries(mcpValue).map((item): SystemStatusItem => ({
    kind: "mcp",
    name: item.name,
    status: item.status,
  }))
  const lsp = array(lspValue).slice(0, MAX_STATUS_ITEMS).flatMap((value): SystemStatusItem[] => {
    const item = record(value)
    if (!item || !display(item.name, MAX_STATUS_NAME) || (item.status !== "connected" && item.status !== "error")) return []
    const detail = display(item.root, MAX_STATUS_DETAIL) ? item.root : undefined
    return [{ kind: "lsp", name: item.name, status: item.status, ...(detail ? { detail } : {}) }]
  })
  const formatter = array(formatterValue).slice(0, MAX_STATUS_ITEMS).flatMap((value): SystemStatusItem[] => {
    const item = record(value)
    if (!item || !display(item.name, MAX_STATUS_NAME) || typeof item.enabled !== "boolean") return []
    return [{ kind: "formatter", name: item.name, status: item.enabled ? "enabled" : "disabled" }]
  })
  return [...mcp, ...lsp, ...formatter].slice(0, MAX_STATUS_ITEMS * 3)
}

function mcpStatus(value: unknown): value is McpSummary["status"] {
  return value === "connected" || value === "disabled" || value === "failed" ||
    value === "needs_auth" || value === "needs_client_registration"
}

function display(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}
