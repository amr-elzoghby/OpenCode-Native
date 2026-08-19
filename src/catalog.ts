export type AgentOption = {
  id: string
  name: string
  model?: ModelSelection
  variant?: string
}

export type ProviderOption = {
  id: string
  name: string
}

export type ModelOption = {
  providerID: string
  id: string
  name: string
  variants: string[]
  audio?: boolean
  image: boolean
  video?: boolean
  pdf?: boolean
}

export type ModelSelection = {
  providerID: string
  modelID: string
}

export type Catalog = {
  agents: AgentOption[]
  providers: ProviderOption[]
  models: ModelOption[]
  defaults: Record<string, string>
}

export type Selection = {
  agent?: string
  model?: ModelSelection
  variant?: string
}

const MAX_PROVIDER_SCAN = 2_000
const MAX_CONNECTED_SCAN = 2_000
const MAX_PROVIDERS = 200
const MAX_MODEL_SCAN = 10_000
const MAX_MODELS_PER_PROVIDER = 2_000
const MAX_MODELS = 2_000
const MAX_VARIANT_SCAN = 1_000
const MAX_AGENT_SCAN = 1_000

export function projectCatalog(providerValue: unknown, agentValue: unknown): Catalog {
  const providerResponse = record(providerValue)
  const connected = new Set(array(providerResponse?.connected).slice(0, MAX_CONNECTED_SCAN).filter(isString))
  const providerValues = array(providerResponse?.all).slice(0, MAX_PROVIDER_SCAN)
  const rawProviders = new Map<string, Record<string, unknown>>()
  const providers = providerValues
    .flatMap((value) => {
      const provider = record(value)
      if (!provider || !safeID(provider.id) || typeof provider.name !== "string" || rawProviders.has(provider.id)) return []
      if (!connected.has(provider.id)) return []
      rawProviders.set(provider.id, provider)
      return [{ id: provider.id, name: safeDisplay(provider.name, 120) || provider.id }]
    })
    .sort((a, b) => Number(a.id !== "opencode") - Number(b.id !== "opencode") || a.name.localeCompare(b.name))
    .slice(0, MAX_PROVIDERS)
  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]))
  const modelCandidates: Array<ModelOption & { releaseDate: string; free: boolean }> = []
  for (const selectedProvider of providers) {
    const provider = rawProviders.get(selectedProvider.id)
    const entries = record(provider?.models)
    if (!entries) continue
    let scanned = 0
    for (const key in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, key)) continue
      if (scanned++ >= MAX_MODELS_PER_PROVIDER || modelCandidates.length >= MAX_MODEL_SCAN) break
      const value = entries[key]
      const model = record(value)
      if (!model) continue
      const id = typeof model.id === "string" ? model.id : key
      if (!safeID(id) || typeof model.name !== "string" || model.status === "deprecated") continue
      // Match the TUI picker: Zen's `-nano` entries are utility models used by
      // OpenCode internally and are intentionally not selectable for chats.
      if (selectedProvider.id === "opencode" && id.includes("-nano")) continue
      const variants = record(model.variants)
      const capabilities = record(model.capabilities)
      const input = record(capabilities?.input)
      const cost = record(model.cost)
      modelCandidates.push({
        providerID: selectedProvider.id,
        id,
        name: safeDisplay(model.name, 160) || id,
        releaseDate: safeReleaseDate(model.release_date),
        free: selectedProvider.id === "opencode" && cost?.input === 0,
        variants: boundedEntries(variants, MAX_VARIANT_SCAN)
          .filter(([variant, value]) => safeID(variant, 128) && record(value)?.disabled !== true)
          .map(([variant]) => variant)
          .slice(0, 100),
        audio: input?.audio === true,
        image: input?.image === true,
        video: input?.video === true,
        pdf: input?.pdf === true,
      })
    }
    if (modelCandidates.length >= MAX_MODEL_SCAN) break
  }
  const models = modelCandidates
    .sort((a, b) =>
      (providerOrder.get(a.providerID) ?? 200) - (providerOrder.get(b.providerID) ?? 200) ||
      Number(!a.free) - Number(!b.free) ||
      b.releaseDate.localeCompare(a.releaseDate) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, MAX_MODELS)
    .map((model) => ({
      providerID: model.providerID,
      id: model.id,
      name: model.name,
      variants: model.variants,
      audio: model.audio,
      image: model.image,
      video: model.video,
      pdf: model.pdf,
    }))
  const agents = array(agentValue)
    .slice(0, MAX_AGENT_SCAN)
    .flatMap((value) => {
      const agent = record(value)
      if (
        !agent ||
        !safeID(agent.name) ||
        agent.hidden === true ||
        (agent.mode !== "primary" && agent.mode !== "all")
      ) return []
      const model = record(agent.model)
      return [{
        id: agent.name,
        name: safeDisplay(title(agent.name), 120) || agent.name,
        model:
          model && typeof model.providerID === "string" && typeof model.modelID === "string"
            ? { providerID: model.providerID, modelID: model.modelID }
            : undefined,
        variant: typeof agent.variant === "string" ? agent.variant : undefined,
      }]
    })
    .slice(0, 100)
    .sort((a, b) => a.name.localeCompare(b.name))
  const defaults = record(providerResponse?.default)
  return {
    agents,
    providers,
    models,
    defaults: Object.fromEntries(
      providers.flatMap((provider): Array<[string, string]> => {
        if (!defaults || !Object.prototype.hasOwnProperty.call(defaults, provider.id)) return []
        const value = defaults[provider.id]
        return safeID(value) ? [[provider.id, value]] : []
      }),
    ),
  }
}

export function resolveSelection(catalog: Catalog, requested: Selection = {}): Selection {
  const agent = catalog.agents.find((item) => item.id === requested.agent) ?? catalog.agents.find((item) => item.id === "build") ?? catalog.agents[0]
  const requestedModel = catalog.models.find(
    (item) => item.providerID === requested.model?.providerID && item.id === requested.model.modelID,
  )
  const agentModel = catalog.models.find(
    (item) => item.providerID === agent?.model?.providerID && item.id === agent.model.modelID,
  )
  const defaultModel = catalog.providers
    .map((provider) => catalog.models.find((model) => model.providerID === provider.id && model.id === catalog.defaults[provider.id]))
    .find((model) => model !== undefined)
  const model = requestedModel ?? agentModel ?? defaultModel ?? catalog.models[0]
  const requestedVariant = requestedModel && model?.variants.includes(requested.variant ?? "") ? requested.variant : undefined
  const agentVariant = agentModel === model && model?.variants.includes(agent?.variant ?? "") ? agent?.variant : undefined
  return {
    agent: agent?.id,
    model: model ? { providerID: model.providerID, modelID: model.id } : undefined,
    variant: requestedVariant ?? agentVariant,
  }
}

export function acceptsSelection(catalog: Catalog, selection: Selection) {
  const agent = catalog.agents.some((item) => item.id === selection.agent)
  const model = catalog.models.find(
    (item) => item.providerID === selection.model?.providerID && item.id === selection.model.modelID,
  )
  return agent && !!model && (!selection.variant || model.variants.includes(selection.variant))
}

export function supportsImageInput(catalog: Catalog, selection: Selection) {
  return supportsFileInput(catalog, selection, "image/png")
}

export function supportsFileInput(catalog: Catalog, selection: Selection, mime: string) {
  if (mime === "text/plain") return true
  const model = catalog.models.find((item) =>
    item.providerID === selection.model?.providerID && item.id === selection.model.modelID,
  )
  if (!model) return false
  if (mime.startsWith("image/")) return model.image
  if (mime.startsWith("audio/")) return model.audio
  if (mime.startsWith("video/")) return model.video
  if (mime === "application/pdf") return model.pdf
  return false
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function boundedEntries(value: Record<string, unknown> | undefined, maximum: number) {
  if (!value) return []
  const result: Array<[string, unknown]> = []
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (result.length >= maximum) break
    result.push([key, value[key]])
  }
  return result
}

function title(value: string) {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value
}

function safeID(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function safeDisplay(value: string, maximum: number) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum)
}

function safeReleaseDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""
}
