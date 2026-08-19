import { deepEqual, equal, rejects } from "node:assert/strict"
import type { Catalog } from "../catalog"
import { SessionController } from "../session"
import { SessionHistory, type SessionInfo } from "../session-history"
import { Transcript } from "../transcript"
import type { UsageTotals } from "../usage"

describe("lazy session state", () => {
  it("does not create state for repeated empty New Chat actions", () => {
    const session = new SessionController()
    equal(session.newChat(), true)
    equal(session.newChat(), true)
    equal(session.boundDirectory(), undefined)
    deepEqual(session.snapshot().messages, [])
    equal(session.snapshot().phase, "idle")
  })
})

describe("provider auth store synchronization", () => {
  it("reboots the Core instance before importing provider auth changed by the TUI", async () => {
    const session = controller("old")
    const internal = internals(session)
    const order: string[] = []
    internal.attempt!.events = Promise.resolve()
    internal.consumeEvents = async () => {}
    internal.loadCatalog = async () => {
      order.push("catalog")
      return catalog("shared-model")
    }
    internal.attempt!.client = {
      instance: {
        dispose: async () => {
          order.push("dispose")
          return { data: true }
        },
      },
      command: {
        list: async () => {
          order.push("commands")
          return { data: [] }
        },
      },
      global: {
        event: async () => {
          order.push("events")
          return { stream: emptyEvents() }
        },
      },
      provider: {
        list: async () => {
          order.push("providers")
          return {
            data: {
              all: [{ id: "openai", name: "OpenAI" }],
              connected: ["openai"],
            },
          }
        },
        auth: async () => {
          order.push("auth")
          return { data: { openai: [{ type: "oauth", label: "ChatGPT Pro/Plus" }] } }
        },
      },
    }

    const providers = await session.refreshProviderConnections("/workspace")

    deepEqual(order, ["dispose", "catalog", "commands", "events", "providers", "auth"])
    equal(providers?.[0]?.id, "openai")
    equal(providers?.[0]?.connected, true)
    equal(providers?.[0]?.methods[0]?.type, "oauth")
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("restores the event stream when provider catalog rebootstrap fails", async () => {
    const session = controller("old")
    const internal = internals(session)
    const order: string[] = []
    let catalogs = 0
    internal.attempt!.events = Promise.resolve()
    internal.consumeEvents = async () => {}
    internal.loadCatalog = async () => {
      order.push("catalog")
      catalogs++
      if (catalogs === 1) throw new Error("catalog unavailable")
      return catalog("recovered-model")
    }
    internal.attempt!.client = {
      instance: {
        dispose: async () => {
          order.push("dispose")
          return { data: true }
        },
      },
      command: {
        list: async () => {
          order.push("commands")
          return { data: [] }
        },
      },
      global: {
        event: async () => {
          order.push("events")
          return { stream: emptyEvents() }
        },
      },
    }

    await rejects(session.refreshProviderConnections("/workspace"), /catalog unavailable/)

    deepEqual(order, ["dispose", "catalog", "commands", "catalog", "commands", "events"])
    equal(internal.attempt?.connected, true)
    equal(session.snapshot().phase, "ready")
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("marks the session unavailable when provider refresh recovery cannot restore events", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.attempt!.events = Promise.resolve()
    internal.loadCatalog = async () => catalog("recovered-model")
    internal.attempt!.client = {
      instance: {
        dispose: async () => {
          throw new Error("dispose unavailable")
        },
      },
      command: {
        list: async () => ({ data: [] }),
      },
      global: {
        event: async () => {
          throw new Error("events unavailable")
        },
      },
    }

    await rejects(session.refreshProviderConnections("/workspace"), /dispose unavailable/)

    equal(internal.attempt?.connected, false)
    equal(session.snapshot().phase, "error")
    equal(session.snapshot().error?.includes("event connection could not be restored"), true)
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("sends API credentials only to the authoritative Core auth endpoint", async () => {
    const session = controller("old")
    const internal = internals(session)
    let payload: unknown
    internal.reloadProviderCatalog = async () => true
    internal.attempt!.client = {
      provider: {
        list: async () => ({
          data: { all: [{ id: "anthropic", name: "Anthropic" }], connected: [] },
        }),
        auth: async () => ({ data: { anthropic: [{ type: "api", label: "API key" }] } }),
      },
      auth: {
        set: async (value: unknown) => {
          payload = value
          return { data: true }
        },
      },
    }

    equal(await session.connectProviderKey("/workspace", "anthropic", 0, {}, "host-only-secret"), true)
    deepEqual(payload, {
      providerID: "anthropic",
      auth: { type: "api", key: "host-only-secret" },
    })
    equal(JSON.stringify(session.snapshot()).includes("host-only-secret"), false)
  })
})

describe("atomic session transitions", () => {
  it("switches an allowlisted session only after hydration succeeds", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_123")
    const target = info("target", 2)
    const key = history.replace([target], {}, undefined)[0]!.key
    internal.attempt!.history = history
    internal.loadStableSession = async () => ({ session: target, transcript: transcript("target prompt") })

    equal(await session.switchSession(key), true)
    equal(internal.attempt?.sessionID, "target")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["target prompt"])
  })

  it("preserves the current session and transcript when switching hydration fails", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_123")
    const key = history.replace([info("target", 2)], {}, undefined)[0]!.key
    internal.attempt!.history = history
    internal.loadStableSession = async () => { throw new Error("failure") }

    equal(await session.switchSession(key), false)
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("refreshes an idle session and re-resolves its catalog selection", async () => {
    const session = controller("old")
    const internal = internals(session)
    const refreshed = info("old", 2, "plan", "new-model")
    internal.loadStableSession = async () => ({ session: refreshed, transcript: transcript("refreshed") })
    internal.loadCatalog = async () => ({
      ...catalog("new-model"),
    })

    equal(await session.refresh(), true)
    deepEqual(session.snapshot().messages.map((message) => message.text), ["refreshed"])
    equal(session.snapshot().selection.agent, "plan")
    equal(session.snapshot().selection.model?.modelID, "new-model")
  })

  it("invalidates stale refresh hydration and reconciles a queued external rollback boundary", async () => {
    const session = controller("old")
    const internal = internals(session)
    const stale = deferred<{ session: SessionInfo; transcript: Transcript }>()
    const streamEnd = deferred<void>()
    let hydrations = 0
    internal.loadStableSession = async () => {
      hydrations++
      if (hydrations === 1) return stale.promise
      return {
        session: { ...info("old", 10), revert: { messageID: "user-2" } },
        transcript: transcript("authoritative visible turn"),
        rolledBack: {
          count: 2,
          truncated: false,
          targets: [
            { messageID: "user-2", preview: "question 2" },
            { messageID: "user-3", preview: "question 3" },
          ],
        },
      }
    }
    internal.loadCatalog = async () => internal.attempt!.catalog
    async function* boundaryEvents() {
      yield {
        payload: {
          type: "session.updated",
          properties: { info: { ...info("old", 10), revert: { messageID: "user-2" } } },
        },
      } as never
      await streamEnd.promise
    }

    const refreshing = session.refresh()
    const consuming = internal.consumeEvents(internal.attempt!, boundaryEvents())
    await new Promise((resolve) => setTimeout(resolve, 0))
    equal(internal.attempt!.pendingEvents?.events.length, 1)
    stale.resolve({ session: info("old", 10), transcript: transcript("stale visible turn") })

    equal(await refreshing, false)
    await internal.attempt!.boundarySync
    deepEqual(session.snapshot().messages.map((message) => message.text), ["authoritative visible turn"])
    equal(session.snapshot().rolledBack.count, 2)
    equal(internal.attempt!.revertMessageID, "user-2")

    internal.attempt!.abort.abort()
    streamEnd.resolve()
    await consuming
  })

  it("refuses busy refresh and preserves state on failure", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.promptBusy = true
    equal(await session.refresh(), false)
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])

    internal.promptBusy = false
    internal.loadStableSession = async () => { throw new Error("failure") }
    internal.loadCatalog = async () => ({
      ...catalog("safe-model"),
    })
    equal(await session.refresh(), false)
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("rejects a refresh when the session generation changes during hydration", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.loadStableSession = async () => {
      internal.generation++
      return { session: info("old", 2), transcript: transcript("stale") }
    }
    internal.loadCatalog = async () => ({
      ...catalog("safe-model"),
    })
    equal(await session.refresh(), false)
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("rejects a refresh when a queued session update changes the revert boundary", async () => {
    const session = controller("old")
    const internal = internals(session)
    const hydration = deferred<{ session: SessionInfo; transcript: Transcript }>()
    internal.loadStableSession = async () => hydration.promise
    internal.loadCatalog = async () => catalog("safe-model")

    const refreshing = session.refresh()
    internal.attempt!.pendingEvents!.events.push({
      payload: {
        type: "session.updated",
        properties: { info: { ...info("old", 3), revert: { messageID: "user-2" } } },
      },
    } as never)
    hydration.resolve({ session: info("old", 2), transcript: transcript("stale pre-revert") })

    equal(await refreshing, false)
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("discards late hydration after New Chat", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_new_chat")
    const target = info("target", 2)
    const key = history.replace([target], {}, undefined)[0]!.key
    const hydration = deferred<{ session: SessionInfo; transcript: Transcript }>()
    internal.attempt!.history = history
    internal.loadStableSession = async () => hydration.promise

    const switching = session.switchSession(key)
    equal(session.newChat(), true)
    hydration.resolve({ session: target, transcript: transcript("stale target") })
    equal(await switching, false)
    equal(internal.attempt?.sessionID, undefined)
    deepEqual(session.snapshot().messages, [])
  })

  it("lets only the newest of two rapid session selections commit", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", keys())
    const first = info("first", 2)
    const second = info("second", 3)
    const projected = history.replace([first, second], {}, undefined)
    const firstHydration = deferred<{ session: SessionInfo; transcript: Transcript }>()
    internal.attempt!.history = history
    internal.loadStableSession = async (_attempt, sessionID) => {
      if (sessionID === "first") return firstHydration.promise
      return { session: second, transcript: transcript("second prompt") }
    }

    const firstSwitch = session.switchSession(projected.find((item) => history.resolve(item.key)?.id === "first")!.key)
    const secondSwitch = session.switchSession(projected.find((item) => history.resolve(item.key)?.id === "second")!.key)
    equal(await secondSwitch, true)
    firstHydration.resolve({ session: first, transcript: transcript("stale first") })
    equal(await firstSwitch, false)
    equal(internal.attempt?.sessionID, "second")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["second prompt"])
  })

  it("rejects hydration when the target is deleted before it commits", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_deleted_late")
    const target = info("target", 2)
    const key = history.replace([target], {}, undefined)[0]!.key
    const hydration = deferred<{ session: SessionInfo; transcript: Transcript }>()
    internal.attempt!.history = history
    internal.loadStableSession = async () => hydration.promise

    const switching = session.switchSession(key)
    internal.attempt!.pendingEvents!.events.push({
      payload: { type: "session.deleted", properties: { sessionID: "target" } },
    } as never)
    hydration.resolve({ session: target, transcript: transcript("deleted target") })
    equal(await switching, false)
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("rejects a session switch when its queued session metadata changes during hydration", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_reverted_late")
    const target = info("target", 2)
    const key = history.replace([target], {}, undefined)[0]!.key
    const hydration = deferred<{ session: SessionInfo; transcript: Transcript }>()
    internal.attempt!.history = history
    internal.loadStableSession = async () => hydration.promise

    const switching = session.switchSession(key)
    internal.attempt!.pendingEvents!.events.push({
      payload: {
        type: "session.updated",
        properties: { info: { ...info("target", 3), revert: { messageID: "user-2" } } },
      },
    } as never)
    hydration.resolve({ session: target, transcript: transcript("stale target") })

    equal(await switching, false)
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("ignores a stale idle event after returning to lazy New Chat", async () => {
    const session = controller("old")
    const internal = internals(session)
    let reconciliations = 0
    internal.loadTranscript = async () => {
      reconciliations++
      return transcript("stale")
    }
    session.newChat()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await Promise.resolve()
    equal(reconciliations, 0)
    deepEqual(session.snapshot().messages, [])
  })

  it("resolves an optimistic submission when session.error arrives", async () => {
    const session = controller("old")
    const internal = internals(session)
    const events: Array<{ status: string; requestID: string; error?: string }> = []
    session.subscribeSubmissions((event) => events.push(event))
    internal.submissionTracker.start("request-error", "message-error")
    internal.promptBusy = true
    internal.loadTranscript = async () => transcript("authoritative")
    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.error", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling
    deepEqual(events, [{
      requestID: "request-error",
      status: "rejected",
      error: "OpenCode could not complete the request. Check your provider configuration in OpenCode.",
    }])
    equal(internal.promptBusy, false)
    equal(session.snapshot().phase, "error")
  })

  it("rejects oversized queued message updates instead of retaining them", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.attempt!.pendingEvents = {
      sessionID: "old",
      generation: internal.generation,
      events: [],
      overflow: false,
    }
    const event = {
      payload: {
        type: "message.updated",
        properties: {
          info: {
            id: "user-large",
            sessionID: "old",
            role: "user",
            time: { created: 1 },
            summary: {
              diffs: [{ file: "src/a.ts", patch: "x".repeat(65_000), additions: 1, deletions: 0 }],
            },
          },
        },
      },
    } as never
    async function* events() {
      yield event
    }

    await internal.consumeEvents(internal.attempt!, events())

    equal(internal.attempt!.pendingEvents.overflow, true)
    deepEqual(internal.attempt!.pendingEvents.events, [])
  })
})

describe("canonical session mutations", () => {
  it("lets OpenCode assign the canonical default title when creating a session", async () => {
    const session = controller("")
    const internal = internals(session)
    internal.attempt!.sessionID = undefined
    equal(session.selectAgent("build"), true)
    equal(session.selectModel({ providerID: "provider", modelID: "safe-model" }), true)
    let createInput: Record<string, unknown> | undefined
    internal.attempt!.client = {
      session: {
        create: async (input: Record<string, unknown>) => {
          createInput = input
          return { data: info("created", 1) }
        },
      },
    }

    await internal.ensureSession(internal.attempt!)

    equal(internal.attempt!.sessionID, "created")
    equal(createInput?.directory, "/workspace")
    equal(Object.hasOwn(createInput ?? {}, "title"), false)
  })

  it("shows OpenCode's asynchronous generated title on the next History refresh", async () => {
    const session = controller("old")
    const internal = internals(session)
    const initial = { ...info("old", 1), title: "New session - 2026-08-16T12:00:00.000Z" }
    const generated = { ...initial, title: "Diagnose native session sync", time: { created: 1, updated: 2 } }
    let listed = initial
    internal.attempt!.client = {
      session: {
        list: async () => ({ data: [listed] }),
        status: async () => ({ data: {} }),
      },
    }

    equal((await session.listHistory("/workspace"))[0]?.title, initial.title)
    listed = generated
    equal((await session.listHistory("/workspace"))[0]?.title, generated.title)
  })

  it("renames only an allowlisted workspace session after backend success", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_rename")
    const target = info("old", 2)
    const key = history.replace([target], {}, "old")[0]!.key
    internal.attempt!.history = history
    let updated = ""
    internal.attempt!.client = client(target, {
      update: async (input) => {
        updated = input.title ?? ""
        return { data: { ...target, title: updated } }
      },
    })

    equal(await session.renameSession(key, "  Deployment   fix  "), true)
    equal(updated, "Deployment fix")
    equal(await session.renameSession("forged_session_key_123", "No"), false)
  })

  it("rejects unsafe titles and preserves the backend title on failure", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_rename")
    const target = info("old", 2)
    const key = history.replace([target], {}, "old")[0]!.key
    internal.attempt!.history = history
    let calls = 0
    internal.attempt!.client = client(target, {
      update: async () => {
        calls++
        throw new Error("raw backend failure")
      },
    })

    equal(await session.renameSession(key, "bad\u202etitle"), false)
    equal(calls, 0)
    equal(await session.renameSession(key, "Safe title"), false)
    equal(calls, 1)
    equal(session.sessionTitle(key), "old")
    equal(session.snapshot().error?.includes("raw backend failure"), false)
  })

  it("deletes non-current sessions but returns a current deletion to lazy New Chat", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", keys())
    const current = info("old", 2)
    const other = info("other", 1)
    const projected = history.replace([current, other], {}, "old")
    internal.attempt!.history = history
    const deleted: string[] = []
    internal.attempt!.client = client(current, {
      get: async (input) => ({ data: input.sessionID === "other" ? other : current }),
      delete: async (input) => {
        deleted.push(input.sessionID)
        return { data: true }
      },
    })

    equal(await session.deleteSession(projected.find((item) => !item.current)!.key), true)
    equal(internal.attempt?.sessionID, "old")
    equal(await session.deleteSession(projected.find((item) => item.current)!.key), true)
    deepEqual(deleted, ["other", "old"])
    equal(internal.attempt?.sessionID, undefined)
    deepEqual(session.snapshot().messages, [])
  })

  it("refuses busy deletion and keeps state after backend failure", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_delete")
    const target = info("old", 2)
    const key = history.replace([target], {}, "old")[0]!.key
    internal.attempt!.history = history
    let calls = 0
    internal.attempt!.client = client(target, {
      status: async () => ({ data: { old: { type: "busy" } } }),
      delete: async () => {
        calls++
        return { data: true }
      },
    })
    equal(await session.deleteSession(key), false)
    equal(calls, 0)

    internal.attempt!.client = client(target, {
      delete: async () => {
        calls++
        throw new Error("raw backend failure")
      },
    })
    equal(await session.deleteSession(key), false)
    equal(calls, 1)
    equal(internal.attempt?.sessionID, "old")
    deepEqual(session.snapshot().messages.map((message) => message.text), ["old prompt"])
  })

  it("refreshes the canonical History source after deletion", async () => {
    const session = controller("old")
    const internal = internals(session)
    const history = new SessionHistory("/workspace", () => "opaque_session_key_deleted")
    const target = info("other", 1)
    const key = history.replace([target], {}, undefined)[0]!.key
    internal.attempt!.history = history
    let sessions = [target]
    internal.attempt!.client = {
      session: {
        get: async () => ({ data: target }),
        status: async () => ({ data: {} }),
        delete: async () => {
          sessions = []
          return { data: true }
        },
        list: async () => ({ data: sessions }),
      },
    }
    equal(await session.deleteSession(key), true)
    deepEqual(await session.listHistory("/workspace"), [])
  })
})

describe("official usage event projection", () => {
  it("keeps response context, unique turn steps, and session totals separate", () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = new Transcript()
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "message.updated",
        properties: { info: {
          id: "user-usage", sessionID: "old", role: "user", time: { created: 1 },
          agent: "build", model: { providerID: "provider", modelID: "safe-model" },
        } },
      },
    } as never)
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "message.part.updated",
        properties: { part: {
          id: "user-text", sessionID: "old", messageID: "user-usage", type: "text", text: "question",
        } },
      },
    } as never)
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "message.updated",
        properties: { info: {
          id: "assistant-usage", sessionID: "old", parentID: "user-usage", role: "assistant",
          time: { created: 2, completed: 5 }, agent: "build", providerID: "provider", modelID: "safe-model",
          cost: 0.03,
          tokens: { input: 20, output: 2, reasoning: 0, cache: { read: 4, write: 0 } },
        } },
      },
    } as never)
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "message.part.updated",
        properties: { part: {
          id: "assistant-text", sessionID: "old", messageID: "assistant-usage", type: "text", text: "answer",
        } },
      },
    } as never)
    ;[{
      id: "step-1", cost: 0.01,
      tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 2, write: 0 } },
    }, {
      id: "step-2", cost: 0.02,
      tokens: { input: 6, output: 2, reasoning: 1, cache: { read: 3, write: 1 } },
    }].forEach((step) => internal.applyEvent(internal.attempt!, {
      payload: {
        type: "message.part.updated",
        properties: { part: {
          ...step, sessionID: "old", messageID: "assistant-usage", type: "step-finish", reason: "stop",
        } },
      },
    } as never))
    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.updated", properties: { info: {
        ...info("old", 2),
        cost: 0.04,
        tokens: { input: 30, output: 4, reasoning: 1, cache: { read: 8, write: 1 } },
      } } },
    } as never)
    internal.flushRender()

    const state = session.snapshot()
    equal(state.messages[1]?.response?.cost, 0.03)
    equal(state.messages[1]?.response?.contextTokens?.total, 26)
    equal(state.turnUsage[0]?.cost, 0.03)
    equal(state.turnUsage[0]?.tokens?.total, 20)
    equal(state.sessionUsage.cost, 0.04)
    equal(state.sessionUsage.tokens?.total, 44)
  })

  it("hydrates step-finish records through the official messages endpoint", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.attempt!.client = {
      session: {
        messages: async () => ({ data: [{
          info: {
            id: "assistant-hydrated", sessionID: "old", parentID: "user-hydrated", role: "assistant",
            time: { created: 2, completed: 4 }, agent: "build", providerID: "provider", modelID: "safe-model",
            cost: 0.01,
            tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 2, write: 0 } },
          },
          parts: [
            { id: "text", sessionID: "old", messageID: "assistant-hydrated", type: "text", text: "answer" },
            {
              id: "finish", sessionID: "old", messageID: "assistant-hydrated", type: "step-finish", reason: "stop", cost: 0.01,
              tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 2, write: 0 } },
            },
          ],
        }] }),
      },
    }
    const transcript = await internal.loadTranscript(internal.attempt!, "old")
    equal(transcript.snapshot()[0]?.response?.modelID, "safe-model")
    equal(transcript.turnUsageSnapshot()[0]?.tokens?.total, 8)
  })

  it("refreshes the authoritative full-session aggregate after idle reconciliation", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.promptBusy = true
    internal.loadTranscript = async () => transcript("complete")
    internal.attempt!.client = {
      session: {
        get: async () => ({ data: {
          ...info("old", 2),
          cost: 0.25,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } },
        } }),
      },
    }
    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling
    equal(session.snapshot().sessionUsage.cost, 0.25)
    equal(session.snapshot().sessionUsage.tokens?.total, 157)
  })

  it("preserves the last authoritative session aggregate when its refresh fails transiently", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.promptBusy = true
    internal.attempt!.sessionUsage = {
      cost: 0.2,
      tokens: { input: 80, output: 10, reasoning: 2, cacheRead: 20, cacheWrite: 1, total: 113 },
    }
    internal.flushRender()
    internal.loadTranscript = async () => transcript("complete")
    internal.attempt!.client = {
      session: {
        get: async () => { throw new Error("temporary connection failure") },
      },
    }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    equal(session.snapshot().sessionUsage.cost, 0.2)
    equal(session.snapshot().sessionUsage.tokens?.total, 113)
  })

  it("clears a stale aggregate when a successful refresh explicitly has no usage", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.promptBusy = true
    internal.attempt!.sessionUsage = { cost: 0.2 }
    internal.flushRender()
    internal.loadTranscript = async () => transcript("complete")
    internal.attempt!.client = {
      session: { get: async () => ({ data: info("old", 2) }) },
    }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    deepEqual(session.snapshot().sessionUsage, {})
  })
})

describe("native review session isolation", () => {
  it("hydrates official summary diffs and labels paths reported by completed edit tools", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.attempt!.client = {
      session: {
        messages: async () => ({ data: [
          {
            info: {
              id: "user-change",
              sessionID: "old",
              role: "user",
              time: { created: 1 },
              summary: {
                title: "change",
                body: "change",
                diffs: [{
                  file: "src/a.ts",
                  additions: 1,
                  deletions: 1,
                  patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
                }],
              },
              agent: "build",
              model: { providerID: "provider", modelID: "safe-model" },
            },
            parts: [{ id: "part-user-change", sessionID: "old", messageID: "user-change", type: "text", text: "change it" }],
          },
          {
            info: {
              id: "assistant-change",
              sessionID: "old",
              parentID: "user-change",
              role: "assistant",
              time: { created: 2, completed: 3 },
              agent: "build",
              providerID: "provider",
              modelID: "safe-model",
              mode: "build",
              path: { cwd: "/workspace", root: "/workspace" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{
              id: "tool-edit",
              sessionID: "old",
              messageID: "assistant-change",
              type: "tool",
              callID: "call-edit",
              tool: "edit",
              state: {
                status: "completed",
                input: { filePath: "/workspace/src/a.ts" },
                output: "done",
                title: "edit",
                metadata: { filediff: { additions: 1, deletions: 1 } },
                time: { start: 2, end: 3 },
              },
            }],
          },
        ] }),
      },
    }
    const transcript = await internal.loadTranscript(internal.attempt!, "old")
    const review = transcript.reviewSnapshot()[0]!
    equal(review.attribution, "direct")
    equal(review.files[0]!.path, "src/a.ts")
    equal(review.files[0]!.reviewable, true)
  })

  it("creates a one-file review from the originating user diff after idle reconciliation", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = turnTranscript("user-review", "assistant-review")
    const order: string[] = []
    const messageIDs: string[] = []
    internal.loadTranscript = async () => {
      order.push("reconcile")
      return turnTranscript("user-review", "assistant-review")
    }
    internal.attempt!.client = { session: { diff: async (input: { messageID: string }) => {
      order.push("diff")
      messageIDs.push(input.messageID)
      return { data: [{ file: "src/a.ts", additions: 3, deletions: 1, status: "modified" }] }
    } } }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    deepEqual(order, ["reconcile", "diff"])
    deepEqual(messageIDs, ["user-review"])
    deepEqual(session.snapshot().reviews[0]?.files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })), [{ path: "src/a.ts", additions: 3, deletions: 1 }])
  })

  it("aggregates multiple reviewed files without querying an assistant message ID", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = turnTranscript("user-many", "assistant-many")
    internal.loadTranscript = async () => turnTranscript("user-many", "assistant-many")
    const messageIDs: string[] = []
    internal.attempt!.client = { session: { diff: async (input: { messageID: string }) => {
      messageIDs.push(input.messageID)
      return { data: [
        { file: "src/a.ts", additions: 4, deletions: 2, status: "modified" },
        { file: "src/b.ts", additions: 1, deletions: 5, status: "modified" },
      ] }
    } } }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    const files = session.snapshot().reviews[0]!.files
    equal(files.reduce((total, file) => total + (file.additions ?? 0), 0), 5)
    equal(files.reduce((total, file) => total + (file.deletions ?? 0), 0), 7)
    deepEqual(files.map((file) => [file.path, file.additions, file.deletions]), [
      ["src/a.ts", 4, 2],
      ["src/b.ts", 1, 5],
    ])
    deepEqual(messageIDs, ["user-many"])
    equal(messageIDs.includes("assistant-many"), false)
  })

  it("commits a mocked diff returned within the bounded retry sequence", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = turnTranscript("user-late", "assistant-late")
    internal.loadTranscript = async () => turnTranscript("user-late", "assistant-late")
    let calls = 0
    internal.attempt!.client = { session: { diff: async () => ({ data: ++calls === 3
      ? [{ file: "src/late.ts", additions: 2, deletions: 0, status: "modified" }]
      : [] }) } }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    equal(calls, 3)
    equal(session.snapshot().reviews[0]?.files[0]?.path, "src/late.ts")
  })

  it("stops bounded diff retries cleanly without creating an empty review", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = turnTranscript("user-empty", "assistant-empty")
    internal.loadTranscript = async () => turnTranscript("user-empty", "assistant-empty")
    let calls = 0
    internal.attempt!.client = { session: { diff: async () => {
      calls++
      return { data: [] }
    } } }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    equal(calls, 4)
    deepEqual(session.snapshot().reviews, [])
    equal(session.snapshot().phase, "ready")
  })

  it("shows only a safe touched path when official snapshots return no diff", async () => {
    const session = controller("old")
    const internal = internals(session)
    const hydrated = turnTranscript("user-unavailable", "assistant-unavailable", "/workspace")
    hydrated.setTool({
      id: "tool-unavailable",
      messageID: "assistant-unavailable",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: "/workspace/src/unavailable.ts", content: "must-not-cross" },
        output: "must-not-cross",
        time: { start: 2, end: 3 },
      },
    })
    internal.transcript = hydrated
    internal.loadTranscript = async () => hydrated
    let calls = 0
    internal.attempt!.client = { session: { diff: async () => {
      calls++
      return { data: [] }
    } } }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    equal(calls, 4)
    const review = session.snapshot().reviews[0]!
    equal(review.files[0]!.path, "src/unavailable.ts")
    equal(review.files[0]!.reviewable, false)
    equal(JSON.stringify(session.snapshot()).includes("must-not-cross"), false)
  })

  it("preserves a hydrated official summary when transient diff requests fail", async () => {
    const session = controller("old")
    const internal = internals(session)
    const hydrated = reviewTranscript()
    internal.transcript = hydrated
    internal.loadTranscript = async () => hydrated
    let calls = 0
    internal.attempt!.client = { session: { diff: async () => {
      calls++
      throw new Error("temporary network failure")
    } } }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await internal.attempt!.reconciling

    equal(calls, 4)
    equal(session.snapshot().reviews[0]!.files[0]!.path, "src/a.ts")
    equal(session.snapshot().reviews[0]!.files[0]!.reviewable, true)
  })

  it("does not surface a late diff after New Chat changes the generation", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = turnTranscript("user-stale", "assistant-stale")
    internal.loadTranscript = async () => turnTranscript("user-stale", "assistant-stale")
    const response = deferred<{ data: Array<{ file: string; additions: number; deletions: number; status: "modified" }> }>()
    internal.attempt!.client = { session: { diff: async () => response.promise } }

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.idle", properties: { sessionID: "old" } },
    } as never)
    await Promise.resolve()
    await Promise.resolve()
    session.newChat()
    response.resolve({ data: [{ file: "src/stale.ts", additions: 1, deletions: 0, status: "modified" }] })
    await internal.attempt!.reconciling

    deepEqual(session.snapshot().reviews, [])
  })

  it("opens only an authoritative current-session revision", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = reviewTranscript()
    internal.attempt!.client = {
      session: {
        diff: async () => ({ data: [{
          file: "src/a.ts",
          additions: 1,
          deletions: 1,
          patch: "Index: src/a.ts\n===\n--- src/a.ts\t\n+++ src/a.ts\t\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        }] }),
      },
    }
    internal.flushRender()
    const review = session.snapshot().reviews[0]!
    deepEqual(await session.review(review.key, review.files[0]!.key), {
      path: "src/a.ts",
      before: "old\n",
      after: "new\n",
    })
  })

  it("rejects a review response that completes after New Chat", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = reviewTranscript()
    const response = deferred<{ data: Array<{ file: string; additions: number; deletions: number; patch: string }> }>()
    internal.attempt!.client = { session: { diff: async () => response.promise } }
    internal.flushRender()
    const review = session.snapshot().reviews[0]!
    const opening = session.review(review.key, review.files[0]!.key)
    session.newChat()
    response.resolve({ data: [{
      file: "src/a.ts",
      additions: 1,
      deletions: 1,
      patch: "Index: src/a.ts\n===\n--- src/a.ts\t\n+++ src/a.ts\t\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    }] })
    await rejects(opening, /changed/)
  })

  it("rejects an in-flight review when undo changes the canonical snapshot boundary", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = reviewTranscript()
    const response = deferred<{ data: Array<{ file: string; additions: number; deletions: number; patch: string }> }>()
    internal.attempt!.client = { session: {
      diff: async () => response.promise,
      revert: async () => ({ data: { ...info("old", 2), revert: { messageID: "message-review" } } }),
    } }
    internal.loadStableSession = async () => ({
      session: { ...info("old", 2), revert: { messageID: "message-review" } },
      transcript: new Transcript("/workspace"),
    })
    internal.flushRender()
    const review = session.snapshot().reviews[0]!
    const opening = session.review(review.key, review.files[0]!.key)
    const undo = session.undoCurrentSession()
    response.resolve({ data: [{
      file: "src/a.ts",
      additions: 1,
      deletions: 1,
      patch: "Index: src/a.ts\n===\n--- src/a.ts\t\n+++ src/a.ts\t\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    }] })
    await rejects(opening, /changed/)
    equal(await undo, true)
  })
})

describe("retry and error state", () => {
  it("uses canonical retry timing without forwarding provider text", () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript.upsertMessage({ id: "assistant-retry", parentID: "user-old", role: "assistant", time: { created: 2 } })
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "session.status",
        properties: {
          sessionID: "old",
          status: {
            type: "retry",
            attempt: 3,
            next: 9_000,
            message: "Authorization: provider-secret",
            action: { reason: "private", provider: "private", title: "private", message: "private", label: "private" },
          },
        },
      },
    } as never)
    const state = session.snapshot()
    equal(state.activities[0]!.status, "retrying")
    deepEqual(state.activities[0]!.retry, { attempt: 3, nextAt: 9_000 })
    equal(JSON.stringify(state).includes("provider-secret"), false)
  })
})

describe("dynamic command session isolation", () => {
  it("executes only the current host-resolved command name", async () => {
    const session = controller("old")
    const internal = internals(session)
    const command = coreCommand()
    internal.commands.replace([command])
    internal.flushRender()
    equal(session.selectAgent("build"), true)
    equal(session.selectModel({ providerID: "provider", modelID: "safe-model" }), true)
    let input: Record<string, unknown> | undefined
    internal.attempt!.client = {
      command: { list: async () => ({ data: [command] }) },
      session: { command: async (value: Record<string, unknown>) => {
        input = value
        return { data: {} }
      } },
    }

    const key = session.snapshot().commands[0]!.key
    equal(await session.runCommand("request_command", "/workspace", key, "branch main"), true)
    equal(input?.command, "review")
    equal(input?.arguments, "branch main")
    equal(input?.directory, "/workspace")
  })

  it("rejects changed commands and a listing that completes after disposal", async () => {
    const stale = controller("old")
    const staleInternal = internals(stale)
    const command = coreCommand()
    staleInternal.commands.replace([command])
    staleInternal.flushRender()
    equal(stale.selectAgent("build"), true)
    equal(stale.selectModel({ providerID: "provider", modelID: "safe-model" }), true)
    let calls = 0
    staleInternal.attempt!.client = {
      command: { list: async () => ({ data: [{ ...command, template: "changed" }] }) },
      session: { command: async () => {
        calls++
        return { data: {} }
      } },
    }
    equal(await stale.runCommand("request_stale", "/workspace", stale.snapshot().commands[0]!.key, ""), false)
    equal(calls, 0)
    equal(stale.snapshot().error?.includes("changed"), false)

    const disposed = controller("old")
    const disposedInternal = internals(disposed)
    disposedInternal.commands.replace([command])
    disposedInternal.flushRender()
    equal(disposed.selectAgent("build"), true)
    equal(disposed.selectModel({ providerID: "provider", modelID: "safe-model" }), true)
    const listing = deferred<{ data: Array<typeof command> }>()
    disposedInternal.attempt!.client = {
      command: { list: async () => listing.promise },
      session: { command: async () => {
        calls++
        return { data: {} }
      } },
    }
    const running = disposed.runCommand("request_dispose", "/workspace", disposed.snapshot().commands[0]!.key, "")
    await Promise.resolve()
    const disposing = disposed.dispose()
    listing.resolve({ data: [command] })
    equal(await running, false)
    await disposing
    equal(calls, 0)
  })
})

describe("MCP session isolation", () => {
  it("revalidates a projected MCP name before toggling it", async () => {
    const session = controller("old")
    const internal = internals(session)
    let status: Record<string, { status: "connected" | "disabled"; error: string }> = {
      docs: { status: "connected", error: "private" },
    }
    let disconnected = ""
    internal.attempt!.client = {
      mcp: {
        status: async () => ({ data: status }),
        disconnect: async (input: { name: string }) => {
          disconnected = input.name
          status = { docs: { status: "disabled", error: "private" } }
          return { data: true }
        },
      },
    }
    deepEqual(await session.listMcpConnections("/workspace"), [{ name: "docs", status: "connected" }])
    deepEqual(await session.toggleMcp("/workspace", "docs"), { name: "docs", status: "disabled" })
    equal(disconnected, "docs")
    equal(await session.toggleMcp("/workspace", "forged"), undefined)
    equal(disconnected, "docs")
  })
})

describe("native slash session mutations", () => {
  it("reconciles transcript and reviews after another OpenCode client changes the revert boundary", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = turnHistory(3)
    internal.transcript.setReview("user-2", [{ file: "src/reverted.ts", additions: 1, deletions: 0 }])
    internal.flushRender()
    internal.loadTranscript = async () => visibleTurnHistory(internal.attempt?.revertMessageID)
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "session.updated",
        properties: { info: { ...info("old", 2), revert: { messageID: "user-2" } } },
      },
    } as never)
    await internal.attempt!.reconciling
    equal(session.hasUndoneTurns(), true)
    deepEqual(session.snapshot().messages.filter((message) => message.role === "user").map((message) => message.id), ["user-1"])
    deepEqual(session.snapshot().reviews, [])

    internal.applyEvent(internal.attempt!, {
      payload: { type: "session.updated", properties: { info: info("old", 3) } },
    } as never)
    await internal.attempt!.reconciling
    equal(session.hasUndoneTurns(), false)
    deepEqual(session.snapshot().messages.filter((message) => message.role === "user").map((message) => message.id), [
      "user-1", "user-2", "user-3",
    ])
  })

  it("runs a queued external-revert reconcile after an unrelated chat mutation finishes", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.transcript = turnHistory(3)
    internal.flushRender()
    const shared = deferred<{ data: ReturnType<typeof info> & { share: { url: string } } }>()
    let loads = 0
    internal.loadTranscript = async () => {
      loads++
      return visibleTurnHistory(internal.attempt?.revertMessageID)
    }
    internal.attempt!.client = { session: { share: async () => shared.promise } }
    const sharing = session.shareCurrentSession()

    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "session.updated",
        properties: { info: { ...info("old", 2), revert: { messageID: "user-2" } } },
      },
    } as never)
    equal(loads, 0)
    shared.resolve({ data: { ...info("old", 3), share: { url: "https://share.opencode.ai/safe" } } })
    equal(await sharing, "https://share.opencode.ai/safe")
    await internal.attempt!.reconciling

    equal(loads, 1)
    deepEqual(session.snapshot().messages.filter((message) => message.role === "user").map((message) => message.id), ["user-1"])
  })

  it("defers an external rollback boundary during an unrelated mutation, then reconciles it", async () => {
    const session = controller("old")
    const internal = internals(session)
    const shared = deferred<{ data: SessionInfo & { share: { url: string } } }>()
    internal.attempt!.client = {
      session: {
        share: async () => shared.promise,
      },
    }
    internal.loadStableSession = async () => ({
      session: { ...info("old", 10), revert: { messageID: "user-2" } },
      transcript: transcript("authoritative visible turn"),
      rolledBack: {
        count: 2,
        truncated: false,
        targets: [
          { messageID: "user-2", preview: "question 2" },
          { messageID: "user-3", preview: "question 3" },
        ],
      },
    })

    const sharing = session.shareCurrentSession()
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "session.updated",
        properties: { info: { ...info("old", 10), revert: { messageID: "user-2" } } },
      },
    } as never)
    equal(session.snapshot().phase, "syncing")
    equal(internal.attempt!.boundarySync, undefined)

    shared.resolve({ data: { ...info("old", 10), share: { url: "https://share.opencode.ai/safe" } } })
    equal(await sharing, "https://share.opencode.ai/safe")
    await internal.attempt!.boundarySync

    deepEqual(session.snapshot().messages.map((message) => message.text), ["authoritative visible turn"])
    equal(session.snapshot().rolledBack.count, 2)
    equal(session.snapshot().phase, "ready")
  })

  it("accepts only HTTPS or loopback HTTP share links", async () => {
    const session = controller("old")
    const internal = internals(session)
    let url = "https://share.opencode.ai/safe"
    let shareSessionID = "old"
    let unshareResponse: ReturnType<typeof info> & { share?: unknown } = info("old", 11)
    internal.attempt!.client = {
      session: {
        share: async () => ({ data: { ...info(shareSessionID, 10), share: { url } } }),
        unshare: async () => ({ data: unshareResponse }),
      },
    }
    equal(await session.shareCurrentSession(), "https://share.opencode.ai/safe")
    url = "http://127.0.0.1:4096/safe"
    equal(await session.shareCurrentSession(), "http://127.0.0.1:4096/safe")
    url = "http://share.opencode.ai/insecure"
    equal(await session.shareCurrentSession(), undefined)
    url = "https://user:secret@share.opencode.ai/credential"
    equal(await session.shareCurrentSession(), undefined)
    url = "https://share.opencode.ai/wrong-session"
    shareSessionID = "other"
    equal(await session.shareCurrentSession(), undefined)

    equal(await session.unshareCurrentSession(), true)
    unshareResponse = { ...info("other", 12) }
    equal(await session.unshareCurrentSession(), false)
    unshareResponse = { ...info("old", 13), share: { url: "https://share.opencode.ai/still-public" } }
    equal(await session.unshareCurrentSession(), false)
    unshareResponse = { ...info("old", 14), share: { url: "javascript:malformed" } }
    equal(await session.unshareCurrentSession(), false)
  })

  it("undoes and redoes user turns one step at a time", async () => {
    const session = controller("old")
    const internal = internals(session)
    const all = turnHistory(3)
    internal.transcript = all
    internal.flushRender()
    let marker: string | undefined
    const reverted: string[] = []
    let unreverted = 0
    internal.loadStableSession = async () => ({
      session: { ...info("old", 10), ...(marker ? { revert: { messageID: marker } } : {}) },
      transcript: visibleTurnHistory(marker),
    })
    internal.attempt!.client = {
      session: {
        get: async () => ({ data: { ...info("old", 10), ...(marker ? { revert: { messageID: marker } } : {}) } }),
        messages: async () => ({ data: rawTurnHistory() }),
        revert: async (input: { messageID: string }) => {
          marker = input.messageID
          reverted.push(input.messageID)
          return { data: { ...info("old", 10), revert: { messageID: marker } } }
        },
        unrevert: async () => {
          marker = undefined
          unreverted++
          return { data: info("old", 10) }
        },
      },
    }

    equal(await session.undoCurrentSession(), true)
    equal(session.hasUndoneTurns(), true)
    equal(await session.undoCurrentSession(), true)
    equal(session.hasUndoneTurns(), true)
    deepEqual(reverted, ["user-3", "user-2"])
    equal(await session.redoCurrentSession(), true)
    equal(session.hasUndoneTurns(), true)
    equal(await session.redoCurrentSession(), true)
    equal(session.hasUndoneTurns(), false)
    deepEqual(reverted, ["user-3", "user-2", "user-3"])
    equal(unreverted, 1)
    deepEqual(session.snapshot().messages.filter((message) => message.role === "user").map((message) => message.id), [
      "user-1", "user-2", "user-3",
    ])
  })

  it("fails closed when the redo marker is outside the bounded message window", async () => {
    const session = controller("old")
    const internal = internals(session)
    let mutations = 0
    internal.attempt!.client = {
      session: {
        get: async () => ({ data: { ...info("old", 10), revert: { messageID: "missing-user" } } }),
        messages: async () => ({ data: rawTurnHistory() }),
        revert: async () => { mutations++; return { data: info("old", 10) } },
        unrevert: async () => { mutations++; return { data: info("old", 10) } },
      },
    }
    equal(await session.redoCurrentSession(), false)
    equal(mutations, 0)
  })

  it("forks only from a current message and clears inherited revert state", async () => {
    const session = controller("old")
    const internal = internals(session)
    internal.attempt!.revertMessageID = "message-old prompt"
    let forkPoint = ""
    internal.attempt!.client = {
      session: {
        fork: async (input: { messageID: string }) => {
          forkPoint = input.messageID
          return { data: info("forked", 5) }
        },
      },
    }
    internal.loadStableSession = async () => ({ session: info("forked", 5), transcript: transcript("forked prompt") })
    equal(await session.forkCurrentSession("message-old prompt"), true)
    equal(forkPoint, "message-old prompt")
    equal(internal.attempt?.sessionID, "forked")
    equal(internal.attempt?.revertMessageID, undefined)
    equal(await session.forkCurrentSession("forged-message"), false)
  })

  it("forks the full current session without inventing a message boundary", async () => {
    const session = controller("old")
    const internal = internals(session)
    let forkInput: Record<string, unknown> | undefined
    internal.attempt!.client = {
      session: {
        fork: async (input: Record<string, unknown>) => {
          forkInput = input
          return { data: info("forked-full", 5) }
        },
      },
    }
    internal.loadStableSession = async () => ({
      session: info("forked-full", 5),
      transcript: transcript("complete fork"),
    })
    equal(await session.forkCurrentSession(), true)
    equal(Object.hasOwn(forkInput ?? {}, "messageID"), false)
    equal(internal.attempt?.sessionID, "forked-full")
  })

  it("projects and freshly revalidates Console organizations before switching", async () => {
    const session = controller("old")
    const internal = internals(session)
    let switched = 0
    const organizations = { orgs: [
      { accountID: "account-a", accountEmail: "a@example.com", accountUrl: "https://example.com", orgID: "org-a", orgName: "Alpha", active: true },
      { accountID: "account-b", accountEmail: "b@example.com", accountUrl: "https://example.com", orgID: "org-b", orgName: "Beta", active: false },
    ] }
    internal.attempt!.client = {
      experimental: { console: {
        listOrgs: async () => ({ data: organizations }),
        switchOrg: async (input: { accountID: string; orgID: string }) => {
          equal(input.accountID, "account-b")
          equal(input.orgID, "org-b")
          switched++
          return { data: true }
        },
      } },
    }
    internal.reloadProviderCatalog = async () => true
    deepEqual(await session.listConsoleOrganizations("/workspace"), [
      { accountID: "account-a", orgID: "org-a", name: "Alpha", email: "a@example.com", active: true },
      { accountID: "account-b", orgID: "org-b", name: "Beta", email: "b@example.com", active: false },
    ])
    equal(await session.switchConsoleOrganization("/workspace", "account-b", "org-b"), true)
    equal(switched, 1)
    equal(await session.switchConsoleOrganization("/workspace", "account-b", "forged"), false)
    equal(switched, 1)
  })
})

describe("permission session isolation", () => {
  it("does not create Native permission UI for routine tool activity without permission.asked", () => {
    const session = controller("old")
    const internal = internals(session)
    internal.applyEvent(internal.attempt!, {
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_read",
            sessionID: "old",
            messageID: "assistant_read",
            type: "tool",
            callID: "call_read",
            tool: "read",
            state: { status: "completed", input: { filePath: "src/app.ts" }, output: "private", title: "Read", metadata: {}, time: { start: 1, end: 2 } },
          },
        },
      },
    } as never)
    deepEqual(session.snapshot().permissions, [])
  })

  it("maps an active opaque Allow decision to OpenCode once", async () => {
    const session = controller("old")
    const internal = internals(session)
    const request = permissionRequest()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "permission.asked", properties: request },
    } as never)
    let reply: string | undefined
    internal.attempt!.client = {
      permission: {
        list: async () => ({ data: [request] }),
        reply: async (input: { reply: string }) => {
          reply = input.reply
          return { data: true }
        },
      },
    }
    const key = session.snapshot().permissions[0]!.key
    equal(await session.replyPermission(key, "allow"), true)
    equal(reply, "once")
    deepEqual(session.snapshot().permissions, [])
  })

  it("maps an active opaque Deny decision to OpenCode reject", async () => {
    const session = controller("old")
    const internal = internals(session)
    const request = permissionRequest()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "permission.asked", properties: request },
    } as never)
    let reply: string | undefined
    internal.attempt!.client = {
      permission: {
        list: async () => ({ data: [request] }),
        reply: async (input: { reply: string }) => {
          reply = input.reply
          return { data: true }
        },
      },
    }
    equal(await session.replyPermission(session.snapshot().permissions[0]!.key, "deny"), true)
    equal(reply, "reject")
    deepEqual(session.snapshot().permissions, [])
  })

  it("does not reply to a changed or stale permission request", async () => {
    const session = controller("old")
    const internal = internals(session)
    const request = permissionRequest()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "permission.asked", properties: request },
    } as never)
    let replies = 0
    internal.attempt!.client = {
      permission: {
        list: async () => ({ data: [{ ...request, patterns: ["different"] }] }),
        reply: async () => {
          replies++
          return { data: true }
        },
      },
    }
    equal(await session.replyPermission(session.snapshot().permissions[0]!.key, "allow"), false)
    equal(replies, 0)
  })

  it("does not approve after New Chat wins a pending revalidation", async () => {
    const session = controller("old")
    const internal = internals(session)
    const request = permissionRequest()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "permission.asked", properties: request },
    } as never)
    const listing = deferred<{ data: Array<typeof request> }>()
    let replies = 0
    internal.attempt!.client = {
      permission: {
        list: async () => listing.promise,
        reply: async () => {
          replies++
          return { data: true }
        },
      },
    }
    const responding = session.replyPermission(session.snapshot().permissions[0]!.key, "allow")
    session.newChat()
    listing.resolve({ data: [request] })
    equal(await responding, false)
    equal(replies, 0)
  })
})

describe("question session isolation", () => {
  it("resolves opaque option keys against the active OpenCode request", async () => {
    const session = controller("old")
    const internal = internals(session)
    const request = questionRequest()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "question.asked", properties: request },
    } as never)
    const prompt = session.snapshot().questions[0]!
    let answers: string[][] | undefined
    internal.attempt!.client = {
      question: {
        list: async () => ({ data: [request] }),
        reply: async (input: { answers: string[][] }) => {
          answers = input.answers
          return { data: true }
        },
      },
    }
    equal(await session.replyQuestion(prompt.key, [{
      questionKey: prompt.questions[0]!.key,
      optionKeys: [prompt.questions[0]!.options[1]!.key],
    }]), true)
    deepEqual(answers, [["Careful"]])
    deepEqual(session.snapshot().questions, [])
  })

  it("rejects through the exact active request and ignores changed requests", async () => {
    const session = controller("old")
    const internal = internals(session)
    const request = questionRequest()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "question.asked", properties: request },
    } as never)
    const key = session.snapshot().questions[0]!.key
    let rejects = 0
    internal.attempt!.client = {
      question: {
        list: async () => ({ data: [{ ...request, questions: [{ ...request.questions[0]!, question: "Changed" }] }] }),
        reject: async () => {
          rejects++
          return { data: true }
        },
      },
    }
    equal(await session.replyQuestion(key), false)
    equal(rejects, 0)
  })

  it("does not answer after New Chat wins pending revalidation", async () => {
    const session = controller("old")
    const internal = internals(session)
    const request = questionRequest()
    internal.applyEvent(internal.attempt!, {
      payload: { type: "question.asked", properties: request },
    } as never)
    const prompt = session.snapshot().questions[0]!
    const listing = deferred<{ data: Array<typeof request> }>()
    let replies = 0
    internal.attempt!.client = {
      question: {
        list: async () => listing.promise,
        reply: async () => {
          replies++
          return { data: true }
        },
      },
    }
    const responding = session.replyQuestion(prompt.key, [{
      questionKey: prompt.questions[0]!.key,
      optionKeys: [prompt.questions[0]!.options[0]!.key],
    }])
    session.newChat()
    listing.resolve({ data: [request] })
    equal(await responding, false)
    equal(replies, 0)
  })
})

type ControllerInternals = {
  attempt?: {
    directory: string
    abort: AbortController
    connected: boolean
    client: object
    sessionID?: string
    catalog: Catalog
    history?: SessionHistory
    pendingEvents?: { sessionID: string; generation: number; events: never[]; overflow: boolean }
    reconciling?: Promise<void>
    revertMessageID?: string
    sessionUsage?: UsageTotals
    events?: Promise<void>
    eventAbort?: AbortController
  }
  promptBusy: boolean
  generation: number
  transcript: Transcript
  commands: { replace(value: unknown): void }
  submissionTracker: { start(requestID: string, messageID: string): void }
  applyEvent: (attempt: object, event: never) => void
  consumeEvents: (attempt: object, events: AsyncIterable<never>) => Promise<void>
  loadStableSession: (attempt: object, sessionID: string) => Promise<{ session: SessionInfo; transcript: Transcript }>
  loadTranscript: (attempt: object, sessionID: string) => Promise<Transcript>
  loadCatalog: (attempt: object) => Promise<Catalog>
  reloadProviderCatalog: (attempt: object, generation: number) => Promise<boolean>
  ensureSession: (attempt: object) => Promise<void>
  flushRender: () => void
}

function controller(sessionID: string) {
  const session = new SessionController()
  const internal = internals(session)
  internal.transcript = transcript("old prompt")
  internal.attempt = {
    directory: "/workspace",
    abort: new AbortController(),
    connected: true,
    client: {
      command: {
        list: async () => ({ data: [] }),
      },
    },
    sessionID,
    catalog: catalog("safe-model"),
  }
  internal.flushRender()
  return session
}

function internals(session: SessionController) {
  return session as unknown as ControllerInternals
}

async function* emptyEvents() {}

function catalog(modelID: string): Catalog {
  return {
    agents: [
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ],
    providers: [{ id: "provider", name: "Provider" }],
    models: [{ providerID: "provider", id: modelID, name: modelID, variants: [], image: false }],
    defaults: { provider: modelID },
  }
}

function info(id: string, updated: number, agent = "build", modelID = "safe-model"): SessionInfo {
  return {
    id,
    directory: "/workspace",
    title: id,
    agent,
    model: { providerID: "provider", id: modelID },
    time: { created: 1, updated },
  }
}

function transcript(text: string) {
  const transcript = new Transcript()
  transcript.replace([{
    info: { id: `message-${text}`, role: "user", time: { created: 1 } },
    parts: [{ id: `part-${text}`, messageID: `message-${text}`, text }],
  }])
  return transcript
}

function reviewTranscript() {
  const value = new Transcript()
  value.replace([{
    info: {
      id: "message-review",
      role: "user",
      time: { created: 1 },
      summary: {
        diffs: [{
          file: "src/a.ts",
          additions: 1,
          deletions: 1,
          status: "modified",
          patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
        }],
      },
    },
    parts: [{ id: "part-review", messageID: "message-review", text: "change it" }],
  }])
  return value
}

function turnTranscript(userID: string, assistantID: string, directory?: string) {
  const value = new Transcript(directory)
  value.replace([
    {
      info: { id: userID, role: "user", time: { created: 1 } },
      parts: [{ id: `part-${userID}`, messageID: userID, text: "change it" }],
    },
    {
      info: { id: assistantID, parentID: userID, role: "assistant", time: { created: 2 } },
      parts: [{ id: `part-${assistantID}`, messageID: assistantID, text: "done" }],
    },
  ])
  return value
}

function turnHistory(count: number) {
  const value = new Transcript()
  for (let index = 1; index <= count; index++) {
    value.upsertMessage({ id: `user-${index}`, role: "user", time: { created: index * 2 - 1 } })
    value.setPart({ id: `part-user-${index}`, messageID: `user-${index}`, text: `question ${index}` })
    value.upsertMessage({ id: `assistant-${index}`, parentID: `user-${index}`, role: "assistant", time: { created: index * 2 } })
    value.setPart({ id: `part-assistant-${index}`, messageID: `assistant-${index}`, text: `answer ${index}` })
  }
  return value
}

function visibleTurnHistory(marker?: string) {
  const count = marker ? Math.max(0, Number(marker.split("-")[1]) - 1) : 3
  return turnHistory(count)
}

function rawTurnHistory() {
  return Array.from({ length: 3 }, (_, offset) => offset + 1).flatMap((index) => [
    {
      info: { id: `user-${index}`, sessionID: "old", role: "user" as const, time: { created: index * 2 - 1 } },
      parts: [{ id: `part-user-${index}`, messageID: `user-${index}`, sessionID: "old", type: "text" as const, text: `question ${index}` }],
    },
    {
      info: { id: `assistant-${index}`, sessionID: "old", parentID: `user-${index}`, role: "assistant" as const, time: { created: index * 2 } },
      parts: [{ id: `part-assistant-${index}`, messageID: `assistant-${index}`, sessionID: "old", type: "text" as const, text: `answer ${index}` }],
    },
  ])
}

function permissionRequest() {
  return {
    id: "per_request_123",
    sessionID: "old",
    permission: "bash",
    patterns: ["bun test"],
    always: ["bun test*"],
    metadata: {},
  }
}

function questionRequest() {
  return {
    id: "question_request_123",
    sessionID: "old",
    questions: [{
      header: "Strategy",
      question: "Choose a strategy",
      options: [
        { label: "Fast", description: "Shortest path" },
        { label: "Careful", description: "Check each step" },
      ],
      multiple: false,
      custom: true,
    }],
    tool: { messageID: "private", callID: "private" },
  }
}

function coreCommand() {
  return {
    name: "review",
    description: "Review changes",
    source: "command" as const,
    template: "Review $ARGUMENTS",
    hints: ["$ARGUMENTS"],
  }
}

function client(session: SessionInfo, overrides: {
  get?: (input: { sessionID: string }) => Promise<{ data: SessionInfo }>
  status?: () => Promise<{ data: Record<string, { type: string }> }>
  update?: (input: { sessionID: string; title?: string }) => Promise<{ data: SessionInfo }>
  delete?: (input: { sessionID: string }) => Promise<{ data: boolean }>
}) {
  return {
    session: {
      get: overrides.get ?? (async () => ({ data: session })),
      status: overrides.status ?? (async () => ({ data: {} })),
      update: overrides.update ?? (async () => ({ data: session })),
      delete: overrides.delete ?? (async () => ({ data: true })),
    },
  }
}

function keys() {
  let value = 0
  return () => `opaque_session_mutation_${++value}`
}

function deferred<Value>() {
  const state: { resolve?: (value: Value) => void } = {}
  const promise = new Promise<Value>((resolve) => { state.resolve = resolve })
  return {
    promise,
    resolve(value: Value) {
      state.resolve?.(value)
    },
  }
}
