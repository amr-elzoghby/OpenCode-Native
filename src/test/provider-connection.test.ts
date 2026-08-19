import { deepEqual, equal, throws } from "node:assert/strict"
import {
  ProviderConnectionGate,
  ProviderConnectionStore,
  providerAuthorization,
  providerConnections,
  providerInputs,
} from "../provider-connection"

describe("provider connection projection", () => {
  it("projects typed provider methods without credentials", () => {
    const providers = providerConnections({
      all: [{ id: "openai", name: "OpenAI" }],
      connected: ["openai"],
    }, {
      openai: [{
        type: "oauth",
        label: "ChatGPT",
        prompts: [{ type: "select", key: "region", message: "Region", options: [{ label: "US", value: "us" }] }],
      }],
    })
    equal(providers[0]?.connected, true)
    equal(providers[0]?.methods[0]?.type, "oauth")
    deepEqual(providerInputs(providers[0]!.methods[0]!, { region: "us" }), { region: "us" })
    equal(providerInputs(providers[0]!.methods[0]!, { region: "invalid" }), undefined)
    equal(JSON.stringify(providers).includes("template"), false)
  })

  it("falls back to API key and validates authorization URLs", () => {
    equal(providerConnections({ all: [{ id: "custom", name: "Custom" }], connected: [] }, {})[0]?.methods[0]?.type, "api")
    deepEqual(providerAuthorization({ url: "https://example.com/login", method: "code", instructions: "Sign in" }), {
      url: "https://example.com/login",
      origin: "https://example.com",
      method: "code",
      instructions: "Sign in",
    })
    equal(providerAuthorization({ url: "javascript:alert(1)", method: "code", instructions: "Sign in" }), undefined)
    equal(providerAuthorization({ url: "https://token@example.com", method: "code", instructions: "Sign in" }), undefined)
    equal(providerAuthorization({ url: "http://example.com/login", method: "code", instructions: "Sign in" }), undefined)
    equal(providerAuthorization({ url: "http://127.0.0.1:8080/login", method: "auto", instructions: "Sign in" })?.origin,
      "http://127.0.0.1:8080")
    equal(providerAuthorization({ url: "http://[::1]:8080/login", method: "auto", instructions: "Sign in" })?.origin,
      "http://[::1]:8080")
    equal(providerAuthorization({ url: "http://localhost:8080/login", method: "auto", instructions: "Sign in" })?.origin,
      "http://localhost:8080")
    equal(providerAuthorization({ url: "http://localhost.example/login", method: "auto", instructions: "Sign in" }), undefined)
  })

  it("uses the TUI Popular order and preserves declared subscription methods", () => {
    const filler = Array.from({ length: 240 }, (_, index) => ({ id: `provider-${index}`, name: `Provider ${index}` }))
    const providers = providerConnections({
      all: [...filler, { id: "openai", name: "OpenAI" }, { id: "opencode", name: "OpenCode Zen" }],
      connected: ["openai"],
    }, {
      openai: [
        { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
        { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
        { type: "api", label: "Manually enter API Key" },
      ],
    })
    deepEqual(providers.slice(0, 2).map((provider) => provider.id), ["opencode", "openai"])
    equal(providers[0]?.category, "Popular")
    equal(providers[1]?.description, "(ChatGPT Plus/Pro or API key)")
    deepEqual(providers[1]?.methods.map((method) => [method.type, method.label]), [
      ["oauth", "ChatGPT Pro/Plus (browser)"],
      ["oauth", "ChatGPT Pro/Plus (headless)"],
      ["api", "Manually enter API Key"],
    ])
    equal(providers.length, 200)
  })

  it("keeps provider IDs and method details behind opaque fresh-validated keys", () => {
    let key = 0
    const store = new ProviderConnectionStore(() => `opaque_provider_key_${key++}`)
    const providers = providerConnections({
      all: [{ id: "private-runtime-id", name: "Safe Provider" }],
      connected: [],
    }, {
      "private-runtime-id": [{
        type: "oauth",
        label: "Subscription",
        prompts: [{ type: "text", key: "tenant", message: "Tenant" }],
      }],
    })
    const projected = store.replace(providers)
    equal(JSON.stringify(projected).includes("private-runtime-id"), false)
    const selected = store.selectProvider(projected[0]!.key, providers)
    equal(selected?.name, "Safe Provider")
    equal(JSON.stringify(selected).includes("tenant"), false)
    const resolved = store.resolveMethod(selected!.methods[0]!.key, providers)
    equal(resolved?.provider.id, "private-runtime-id")
    equal(store.resolveMethod(selected!.methods[0]!.key, providers), undefined)

    const changed = store.selectProvider(projected[0]!.key, providers)
    equal(store.resolveMethod(changed!.methods[0]!.key, providers.map((provider) => ({
      ...provider,
      connected: true,
    }))), undefined)
    equal(store.resolveMethod(changed!.methods[0]!.key, providers), undefined)
    equal(store.selectProvider("opaque_provider_key_missing", providers), undefined)
  })

  it("fails closed for unsafe projection records and key generation", () => {
    const projected = providerConnections({
      all: [
        { id: "constructor", name: "Constructor Provider" },
        { id: "toString", name: "String Provider" },
        { id: "duplicate", name: "First" },
        { id: "duplicate", name: "Spoofed" },
        { id: "malformed", name: "Malformed" },
        { id: "empty-auth", name: "Empty auth" },
        { id: "blank", name: "   " },
      ],
      connected: [],
    }, {
      malformed: [{
        type: "oauth",
        label: "Oversized",
        prompts: [{
          type: "select",
          key: "region",
          message: "Region",
          options: Array.from({ length: 101 }, (_, index) => ({ label: `Region ${index}`, value: String(index) })),
        }],
      }],
      "empty-auth": [],
    })
    deepEqual(projected.map((provider) => [provider.id, provider.category, provider.description]), [
      ["constructor", "Providers", undefined],
      ["duplicate", "Providers", undefined],
      ["toString", "Providers", undefined],
    ])
    equal(projected.find((provider) => provider.id === "duplicate")?.name, "First")
    equal(projected.some((provider) => provider.id === "malformed"), false)
    equal(projected.some((provider) => provider.id === "empty-auth"), false)
    equal(projected.some((provider) => provider.id === "blank"), false)
    equal(providerConnections({
      all: [{ id: "normalized", name: "  Normalized   Provider  " }],
      connected: [],
    }, {})[0]?.name, "Normalized Provider")

    throws(() => new ProviderConnectionStore(() => "short").replace(projected))
    throws(() => new ProviderConnectionStore(() => "opaque_provider_key_same").replace(projected))
  })

  it("serializes Webview-triggered connection operations without stale unlocks", () => {
    const gate = new ProviderConnectionGate()
    const first = gate.begin()
    equal(typeof first, "symbol")
    equal(gate.begin(), undefined)
    gate.cancel()
    const second = gate.begin()
    equal(typeof second, "symbol")
    gate.finish(first!)
    equal(gate.begin(), undefined)
    gate.finish(second!)
    equal(typeof gate.begin(), "symbol")
  })

  it("matches the TUI conditional prompt semantics", () => {
    const method = providerConnections({
      all: [{ id: "conditional", name: "Conditional" }],
      connected: [],
    }, {
      conditional: [{
        type: "oauth",
        label: "Conditional auth",
        prompts: [
          {
            type: "select",
            key: "deployment",
            message: "Deployment",
            options: [
              { label: "Cloud", value: "cloud" },
              { label: "Enterprise", value: "enterprise" },
            ],
          },
          {
            type: "text",
            key: "hostname",
            message: "Hostname",
            when: { key: "deployment", op: "eq", value: "enterprise" },
          },
          {
            type: "text",
            key: "region",
            message: "Region",
            when: { key: "missing", op: "neq", value: "local" },
          },
        ],
      }],
    })[0]!.methods[0]!

    deepEqual(providerInputs(method, { deployment: "cloud" }), { deployment: "cloud" })
    deepEqual(providerInputs(method, { deployment: "enterprise", hostname: "example.test" }), {
      deployment: "enterprise",
      hostname: "example.test",
    })
    equal(providerInputs(method, { deployment: "cloud", region: "us" }), undefined)
  })
})
