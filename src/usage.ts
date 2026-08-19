export type UsageTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type UsageTotals = {
  cost?: number
  tokens?: UsageTokens
}

export type ResponseMetadata = {
  completedAt?: number
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
  cost?: number
  contextTokens?: UsageTokens
}

export type TurnUsage = UsageTotals & {
  turnID: string
}

const MAX_COST = 1_000_000_000

export function projectUsage(cost: unknown, tokens: unknown): UsageTotals {
  const safeCost = projectCost(cost)
  const safeTokens = projectTokens(tokens)
  return {
    ...(safeCost === undefined ? {} : { cost: safeCost }),
    ...(safeTokens ? { tokens: safeTokens } : {}),
  }
}

export function projectCost(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COST
    ? value
    : undefined
}

export function projectTokens(value: unknown): UsageTokens | undefined {
  const tokens = record(value)
  const cache = record(tokens?.cache)
  if (!tokens || !cache) return
  const input = token(tokens.input)
  const output = token(tokens.output)
  const reasoning = token(tokens.reasoning)
  const cacheRead = token(cache.read)
  const cacheWrite = token(cache.write)
  if (
    input === undefined || output === undefined || reasoning === undefined ||
    cacheRead === undefined || cacheWrite === undefined
  ) return
  const total = safeSum([input, output, reasoning, cacheRead, cacheWrite])
  if (total === undefined) return
  return { input, output, reasoning, cacheRead, cacheWrite, total }
}

export function addUsageTokens(values: UsageTokens[]): UsageTokens | undefined {
  if (!values.length) return
  const input = safeSum(values.map((value) => value.input))
  const output = safeSum(values.map((value) => value.output))
  const reasoning = safeSum(values.map((value) => value.reasoning))
  const cacheRead = safeSum(values.map((value) => value.cacheRead))
  const cacheWrite = safeSum(values.map((value) => value.cacheWrite))
  if (
    input === undefined || output === undefined || reasoning === undefined ||
    cacheRead === undefined || cacheWrite === undefined
  ) return
  const total = safeSum([input, output, reasoning, cacheRead, cacheWrite])
  if (total === undefined) return
  return { input, output, reasoning, cacheRead, cacheWrite, total }
}

export function addCosts(values: number[]) {
  if (!values.length) return
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isFinite(total) && total >= 0 && total <= MAX_COST ? total : undefined
}

function token(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function safeSum(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
