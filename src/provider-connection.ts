import { randomBytes } from "node:crypto"

const MAX_PROVIDERS = 200
const MAX_PROVIDER_SCAN = 2_000
const MAX_CONNECTED_SCAN = 2_000
const MAX_METHODS = 10
const MAX_PROMPTS = 20
const MAX_OPTIONS = 100
const MAX_TOTAL_METHODS = 500
const MAX_TOTAL_PROMPTS = 1_000
const MAX_TOTAL_OPTIONS = 5_000

const PROVIDER_PRIORITY = new Map<string, number>([
  ["opencode", 0],
  ["opencode-go", 1],
  ["openai", 2],
  ["github-copilot", 3],
  ["anthropic", 4],
  ["google", 5],
] as const)

const PROVIDER_DESCRIPTIONS = new Map<string, string>([
  ["opencode", "(Recommended)"],
  ["anthropic", "(API key)"],
  ["openai", "(ChatGPT Plus/Pro or API key)"],
  ["opencode-go", "Low cost subscription for everyone"],
] as const)

export type ProviderPrompt = {
  type: "text" | "select"
  key: string
  message: string
  placeholder?: string
  options?: Array<{ label: string; value: string; hint?: string }>
  when?: { key: string; op: "eq" | "neq"; value: string }
}

export type ProviderMethod = {
  index: number
  type: "api" | "oauth"
  label: string
  prompts: ProviderPrompt[]
}

export type ProviderConnection = {
  id: string
  name: string
  connected: boolean
  category: "Popular" | "Providers"
  description?: string
  methods: ProviderMethod[]
}

export type ProviderConnectionOption = {
  key: string
  name: string
  connected: boolean
  category: "Popular" | "Providers"
  description?: string
}

export type ProviderMethodOption = {
  key: string
  label: string
  type: "api" | "oauth"
}

export type ProviderAuthorization = {
  url: string
  origin: string
  method: "auto" | "code"
  instructions: string
}

export function providerConnections(providerValue: unknown, authValue: unknown): ProviderConnection[] {
  const providers = record(providerValue)
  const auth = record(authValue)
  const connected = new Set(array(providers?.connected).slice(0, MAX_CONNECTED_SCAN).filter(isString))
  const seen = new Set<string>()
  const candidates = array(providers?.all)
    .slice(0, MAX_PROVIDER_SCAN)
    .flatMap((value): Omit<ProviderConnection, "methods">[] => {
      const provider = record(value)
      if (!provider || !safeID(provider.id) || seen.has(provider.id)) return []
      const name = safeDisplay(provider.name, 120)
      if (!name) return []
      seen.add(provider.id)
      return [{
        id: provider.id,
        name,
        connected: connected.has(provider.id),
        category: PROVIDER_PRIORITY.has(provider.id) ? "Popular" : "Providers",
        description: PROVIDER_DESCRIPTIONS.get(provider.id),
      }]
    })
    .sort((a, b) =>
      (PROVIDER_PRIORITY.get(a.id) ?? 99) - (PROVIDER_PRIORITY.get(b.id) ?? 99) ||
      a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()) ||
      a.id.localeCompare(b.id)
    )
  const budget = { methods: MAX_TOTAL_METHODS, prompts: MAX_TOTAL_PROMPTS, options: MAX_TOTAL_OPTIONS }
  const result: ProviderConnection[] = []
  for (const provider of candidates) {
    if (result.length >= MAX_PROVIDERS) break
    const declared = !!auth && Object.prototype.hasOwnProperty.call(auth, provider.id)
    const rawMethods = declared ? auth[provider.id] : undefined
    if (declared && !Array.isArray(rawMethods)) continue
    const configured = array(rawMethods).slice(0, MAX_METHODS).flatMap((method, index) =>
      providerMethod(method, index, budget),
    )
    if (declared && !configured.length) continue
    result.push({
      ...provider,
      methods: configured.length ? configured : [{ index: 0, type: "api", label: "API key", prompts: [] }],
    })
  }
  return result
}

type ProviderRecord = ProviderConnectionOption & { id: string; fingerprint: string }
type MethodRecord = {
  key: string
  providerID: string
  index: number
  providerFingerprint: string
  methodFingerprint: string
}

export class ProviderConnectionGate {
  private active?: symbol

  begin() {
    if (this.active) return
    const token = Symbol("provider-connection")
    this.active = token
    return token
  }

  finish(token: symbol) {
    if (this.active === token) this.active = undefined
  }

  cancel() {
    this.active = undefined
  }
}

export class ProviderConnectionStore {
  private providers = new Map<string, ProviderRecord>()
  private methods = new Map<string, MethodRecord>()

  constructor(private createKey: () => string = () => randomBytes(18).toString("base64url")) {}

  clear() {
    this.providers.clear()
    this.methods.clear()
  }

  replace(providers: ProviderConnection[]) {
    this.clear()
    providers.forEach((provider) => {
      const key = this.uniqueKey()
      this.providers.set(key, {
        key,
        id: provider.id,
        name: provider.name,
        connected: provider.connected,
        category: provider.category,
        description: provider.description,
        fingerprint: providerFingerprint(provider),
      })
    })
    return this.snapshot()
  }

  snapshot(): ProviderConnectionOption[] {
    return [...this.providers.values()].map(({ key, name, connected, category, description }) => ({
      key,
      name,
      connected,
      category,
      description,
    }))
  }

  selectProvider(key: string, fresh: ProviderConnection[]) {
    const record = this.providers.get(key)
    const provider = fresh.find((item) => item.id === record?.id)
    if (!record || !provider || record.fingerprint !== providerFingerprint(provider)) return
    this.methods.clear()
    const methods = provider.methods.map((method) => {
      const methodKey = this.uniqueKey()
      this.methods.set(methodKey, {
        key: methodKey,
        providerID: provider.id,
        index: method.index,
        providerFingerprint: record.fingerprint,
        methodFingerprint: methodFingerprint(provider.id, method),
      })
      return { key: methodKey, label: method.label, type: method.type }
    })
    return { name: provider.name, methods }
  }

  resolveMethod(key: string, fresh: ProviderConnection[]) {
    const record = this.methods.get(key)
    if (!record) return
    this.methods.clear()
    const provider = fresh.find((item) => item.id === record?.providerID)
    const method = provider?.methods.find((item) => item.index === record?.index)
    if (!record || !provider || !method || record.providerFingerprint !== providerFingerprint(provider) ||
      record.methodFingerprint !== methodFingerprint(provider.id, method)) return
    return { provider, method }
  }

  private uniqueKey() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const key = this.createKey()
      if (/^[A-Za-z0-9_-]{16,128}$/.test(key) && !this.providers.has(key) && !this.methods.has(key)) return key
    }
    throw new Error("OpenCode could not create a safe provider selection key.")
  }
}

function providerFingerprint(provider: ProviderConnection) {
  return JSON.stringify([
    provider.id,
    provider.name,
    provider.connected,
    provider.category,
    provider.description,
    provider.methods.map((method) => methodFingerprint(provider.id, method)),
  ])
}

function methodFingerprint(providerID: string, method: ProviderMethod) {
  return JSON.stringify([providerID, method.index, method.type, method.label, method.prompts])
}

export function providerInputs(method: ProviderMethod, value: unknown) {
  const input = record(value)
  if (!input) return
  const active = method.prompts.filter((prompt) => providerPromptApplies(prompt, input))
  if (!Object.keys(input).every((key) => active.some((prompt) => prompt.key === key))) return
  if (!active.every((prompt) => {
    const answer = input[prompt.key]
    if (!bounded(answer, 2_000) || answer.length === 0) return false
    return prompt.type !== "select" || !!prompt.options?.some((option) => option.value === answer)
  })) return
  return Object.fromEntries(active.map((prompt) => [prompt.key, input[prompt.key] as string]))
}

export function providerPromptApplies(prompt: ProviderPrompt, values: Readonly<Record<string, unknown>>) {
  if (!prompt.when) return true
  const dependency = values[prompt.when.key]
  if (dependency === undefined) return false
  const matches = dependency === prompt.when.value
  return prompt.when.op === "eq" ? matches : !matches
}

export function providerAuthorization(value: unknown): ProviderAuthorization | undefined {
  const authorization = record(value)
  if (!authorization || (authorization.method !== "auto" && authorization.method !== "code") ||
    !bounded(authorization.url, 4_096)) return
  const instructions = safeDisplay(authorization.instructions, 2_000)
  if (!instructions) return
  const url = safeUrl(authorization.url)
  if (!url) return
  return { url: url.href, origin: url.origin, method: authorization.method, instructions }
}

function providerMethod(
  value: unknown,
  index: number,
  budget: { methods: number; prompts: number; options: number },
): ProviderMethod[] {
  if (budget.methods <= 0) return []
  budget.methods--
  const method = record(value)
  if (!method || (method.type !== "api" && method.type !== "oauth")) return []
  const label = safeDisplay(method.label, 120)
  if (!label) return []
  const rawPrompts = array(method.prompts)
  if (method.prompts !== undefined && (!Array.isArray(method.prompts) || rawPrompts.length > MAX_PROMPTS ||
    rawPrompts.length > budget.prompts)) return []
  budget.prompts -= rawPrompts.length
  const prompts = rawPrompts.flatMap((prompt) => providerPrompt(prompt, budget))
  if (prompts.length !== rawPrompts.length || new Set(prompts.map((prompt) => prompt.key)).size !== prompts.length) return []
  return [{ index, type: method.type, label, prompts }]
}

function providerPrompt(value: unknown, budget: { options: number }): ProviderPrompt[] {
  const prompt = record(value)
  if (!prompt || (prompt.type !== "text" && prompt.type !== "select") || !safeID(prompt.key, 128)) return []
  const message = safeDisplay(prompt.message, 500)
  const placeholder = prompt.placeholder === undefined ? undefined : safeDisplay(prompt.placeholder, 240)
  if (!message || (prompt.placeholder !== undefined && !placeholder)) return []
  const when = prompt.when === undefined ? undefined : providerWhen(prompt.when)
  if (prompt.when !== undefined && !when) return []
  if (prompt.type === "text") {
    return [{ type: "text", key: prompt.key, message, placeholder, when }]
  }
  const rawOptions = array(prompt.options)
  if (!Array.isArray(prompt.options) || !rawOptions.length || rawOptions.length > MAX_OPTIONS ||
    rawOptions.length > budget.options) return []
  budget.options -= rawOptions.length
  const options = rawOptions.flatMap(providerOption)
  if (options.length !== rawOptions.length) return []
  return [{ type: "select", key: prompt.key, message, placeholder, options, when }]
}

function providerWhen(value: unknown): ProviderPrompt["when"] {
  const when = record(value)
  if (!when || !safeID(when.key, 128) || (when.op !== "eq" && when.op !== "neq") || !bounded(when.value, 2_000)) return
  return { key: when.key, op: when.op, value: when.value }
}

function providerOption(value: unknown) {
  const option = record(value)
  if (!option || !bounded(option.value, 2_000)) return []
  const label = safeDisplay(option.label, 240)
  const hint = option.hint === undefined ? undefined : safeDisplay(option.hint, 240)
  if (!label || (option.hint !== undefined && !hint)) return []
  return [{ label, value: option.value, hint }]
}

function safeUrl(value: string) {
  try {
    const url = new URL(value)
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return
    if (url.username || url.password) return
    return url
  } catch {
    return
  }
}

function safeID(value: unknown, maximum = 256): value is string {
  return bounded(value, maximum) && value.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function safeDisplay(value: unknown, maximum: number) {
  if (!safeID(value, maximum)) return
  return value.replace(/\s+/g, " ").trim() || undefined
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}
