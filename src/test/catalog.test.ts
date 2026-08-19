import { deepEqual, equal } from "node:assert/strict"
import { acceptsSelection, projectCatalog, resolveSelection, supportsFileInput, supportsImageInput } from "../catalog"

const rawProviders = {
  connected: ["openai"],
  default: { openai: "gpt-safe" },
  all: [
    {
      id: "openai",
      name: "OpenAI",
      key: "must-not-cross",
      options: { apiKey: "must-not-cross" },
      models: {
        "gpt-safe": {
          id: "gpt-safe",
          name: "GPT Safe",
          headers: { Authorization: "must-not-cross" },
          capabilities: { input: { image: true, audio: true, video: true, pdf: true } },
          variants: {
            high: { options: { secret: "must-not-cross" } },
            hidden: { disabled: true, options: { secret: "must-not-cross" } },
          },
        },
        plain: { id: "plain", name: "Plain" },
        old: { id: "old", name: "Old", status: "deprecated" },
      },
    },
    {
      id: "unconnected",
      name: "Unconnected",
      models: { private: { id: "private", name: "Private" } },
    },
  ],
}

const rawAgents = [
  {
    name: "build",
    description: "Build agent",
    mode: "primary",
    prompt: "must-not-cross",
    permission: { edit: "allow" },
    model: { providerID: "openai", modelID: "gpt-safe" },
    variant: "high",
  },
  { name: "plan", mode: "primary" },
  { name: "explore", mode: "subagent" },
  { name: "hidden", mode: "primary", hidden: true },
]

describe("safe catalog projection", () => {
  const catalog = projectCatalog(rawProviders, rawAgents)

  it("keeps only safe connected picker fields", () => {
    deepEqual(catalog.providers, [{ id: "openai", name: "OpenAI" }])
    deepEqual(catalog.models, [
      { providerID: "openai", id: "gpt-safe", name: "GPT Safe", variants: ["high"], audio: true, image: true, video: true, pdf: true },
      { providerID: "openai", id: "plain", name: "Plain", variants: [], audio: false, image: false, video: false, pdf: false },
    ])
    deepEqual(catalog.agents, [
      {
        id: "build",
        name: "Build",
        model: { providerID: "openai", modelID: "gpt-safe" },
        variant: "high",
      },
      { id: "plan", name: "Plan", model: undefined, variant: undefined },
    ])
    equal(JSON.stringify(catalog).includes("must-not-cross"), false)
  })

  it("rejects spoofed selections and unavailable variants", () => {
    equal(acceptsSelection(catalog, { agent: "root", model: { providerID: "openai", modelID: "gpt-safe" } }), false)
    equal(acceptsSelection(catalog, { agent: "build", model: { providerID: "other", modelID: "gpt-safe" } }), false)
    equal(acceptsSelection(catalog, {
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-safe" },
      variant: "ultra",
    }), false)
  })

  it("uses real agent/model/variant defaults and supports Default", () => {
    deepEqual(resolveSelection(catalog), {
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-safe" },
      variant: "high",
    })
    equal(acceptsSelection(catalog, {
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-safe" },
    }), true)
    deepEqual(resolveSelection(catalog, {
      agent: "plan",
      model: { providerID: "openai", modelID: "plain" },
    }), {
      agent: "plan",
      model: { providerID: "openai", modelID: "plain" },
      variant: undefined,
    })
    equal(supportsImageInput(catalog, resolveSelection(catalog)), true)
    equal(supportsFileInput(catalog, resolveSelection(catalog), "video/mp4"), true)
    equal(supportsFileInput(catalog, resolveSelection(catalog), "audio/mpeg"), true)
    equal(supportsFileInput(catalog, resolveSelection(catalog), "application/pdf"), true)
    equal(supportsFileInput(catalog, resolveSelection(catalog), "application/octet-stream"), false)
    equal(supportsImageInput(catalog, {
      agent: "plan",
      model: { providerID: "openai", modelID: "plain" },
    }), false)
  })

  it("sanitizes and caps every display field before Webview projection", () => {
    const projected = projectCatalog({
      connected: ["safe"],
      default: { safe: "model", forged: "secret" },
      all: [{
        id: "safe",
        name: ` Provider\u202e\n${"x".repeat(200)} `,
        models: {
          model: {
            id: "model",
            name: ` Model\u2066${"y".repeat(200)} `,
            variants: Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`v${index}`, {}])),
          },
        },
      }],
    }, [{ name: "build", mode: "primary" }])
    equal(projected.providers[0]?.name.includes("\u202e"), false)
    equal(projected.providers[0]?.name.length, 120)
    equal(projected.models[0]?.name.includes("\u2066"), false)
    equal(projected.models[0]?.name.length, 160)
    equal(projected.models[0]?.variants.length, 100)
    deepEqual(projected.defaults, { safe: "model" })
  })

  it("matches the TUI model picker order by provider, free status, and release date", () => {
    const projected = projectCatalog({
      connected: ["openai", "opencode"],
      default: {},
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: { alpha: { id: "alpha", name: "Alpha", release_date: "2026-01-01" } },
        },
        {
          id: "opencode",
          name: "OpenCode Zen",
          models: {
            paid: { id: "paid", name: "Paid new", release_date: "2026-08-01", cost: { input: 1 } },
            free: { id: "free", name: "Free older", release_date: "2025-01-01", cost: { input: 0 } },
            "gpt-5.4-nano": {
              id: "gpt-5.4-nano",
              name: "Internal utility model",
              release_date: "2026-08-17",
              cost: { input: 0 },
            },
          },
        },
      ],
    }, [{ name: "build", mode: "primary" }])
    deepEqual(projected.providers.map((provider) => provider.id), ["opencode", "openai"])
    deepEqual(projected.models.map((model) => `${model.providerID}/${model.id}`), [
      "opencode/free",
      "opencode/paid",
      "openai/alpha",
    ])
    equal(projected.models.some((model) => model.id === "gpt-5.4-nano"), false)
  })

  it("caps provider and model scans before sorting large Core responses", () => {
    const filler = Array.from({ length: 240 }, (_, index) => ({
      id: `provider-${index}`,
      name: `Provider ${index}`,
      models: {},
    }))
    const opencode = {
      id: "opencode",
      name: "OpenCode Zen",
      models: Object.fromEntries(Array.from({ length: 2_500 }, (_, index) => [
        `model-${index}`,
        { id: `model-${index}`, name: `Model ${index}`, release_date: "2026-01-01" },
      ])),
    }
    const projected = projectCatalog({
      connected: [...filler.map((provider) => provider.id), "opencode"],
      default: {},
      all: [...filler, opencode],
    }, [{ name: "build", mode: "primary" }])
    equal(projected.providers[0]?.id, "opencode")
    equal(projected.providers.length, 200)
    equal(projected.models.length, 2_000)
  })
})
