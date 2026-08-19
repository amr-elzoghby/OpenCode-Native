import { deepEqual, equal } from "node:assert/strict"
import {
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_TOTAL_CHARS,
  SubmissionTracker,
  parseActionMessage,
  parseComposerMessage,
  parseHistoryMessage,
  parseProviderConnectMessage,
  parseStateMessage,
  parseSubmissionMessage,
  parseWebviewMessage,
  type SubmissionEvent,
} from "../protocol"

describe("Webview request protocol", () => {
  it("validates a complete prompt lifecycle", () => {
    const requestID = "request_123"
    deepEqual(parseWebviewMessage({ type: "sendPrompt", requestID, text: "  hello  ", attachmentIDs: ["opaque_attachment_123"] }), {
      type: "sendPrompt",
      requestID,
      text: "hello",
      attachmentIDs: ["opaque_attachment_123"],
    })
    deepEqual(parseSubmissionMessage({ type: "submission", requestID, status: "submitted" }), {
      type: "submission",
      requestID,
      status: "submitted",
    })
    deepEqual(parseSubmissionMessage({ type: "submission", requestID, status: "accepted" }), {
      type: "submission",
      requestID,
      status: "accepted",
    })
    deepEqual(parseSubmissionMessage({ type: "submission", requestID, status: "observed", messageID: "msg_123" }), {
      type: "submission",
      requestID,
      status: "observed",
      messageID: "msg_123",
    })
  })

  it("rejects spoofed and malformed messages", () => {
    equal(parseWebviewMessage({ type: "sendPrompt", requestID: "bad id", text: "hello", attachmentIDs: [] }), undefined)
    equal(parseWebviewMessage({ type: "sendPrompt", requestID: "ok", text: "hello", attachmentIDs: [], extra: true }), undefined)
    equal(parseWebviewMessage({ type: "sendPrompt", requestID: "ok", text: "", attachmentIDs: [] }), undefined)
    equal(parseSubmissionMessage({ type: "submission", requestID: "ok", status: "observed" }), undefined)
    equal(parseSubmissionMessage({ type: "submission", requestID: "ok", status: "rejected", error: "" }), undefined)
  })

  it("allows only fixed native actions in either direction", () => {
    deepEqual(parseWebviewMessage({ type: "sidebarFocus", focused: true }), {
      type: "sidebarFocus",
      focused: true,
    })
    equal(parseWebviewMessage({ type: "sidebarFocus", focused: true, command: "workbench.action.reloadWindow" }), undefined)
    deepEqual(parseWebviewMessage({ type: "invokeAction", action: "new" }), {
      type: "invokeAction",
      action: "new",
    })
    deepEqual(parseActionMessage({ type: "action", action: "models" }), {
      type: "action",
      action: "models",
    })
    deepEqual(parseWebviewMessage({ type: "invokeAction", action: "refresh" }), {
      type: "invokeAction",
      action: "refresh",
    })
    deepEqual(parseWebviewMessage({ type: "invokeAction", action: "sessions" }), {
      type: "invokeAction",
      action: "sessions",
    })
    equal(parseWebviewMessage({ type: "invokeAction", action: "new", command: "workbench.action.reloadWindow" }), undefined)
    deepEqual(parseActionMessage({ type: "action", action: "sessions" }), {
      type: "action",
      action: "sessions",
    })
    equal(parseWebviewMessage({ type: "invokeAction", action: "workbench.action.reloadWindow" }), undefined)
  })

  it("accepts only bounded host-to-Webview composer restoration", () => {
    deepEqual(parseComposerMessage({ type: "composer", text: "restore this prompt" }), {
      type: "composer",
      text: "restore this prompt",
    })
    equal(parseComposerMessage({ type: "composer", text: "x".repeat(100_001) }), undefined)
    equal(parseComposerMessage({ type: "composer", text: "safe", command: "workbench.action.terminal.sendSequence" }), undefined)
  })

  it("accepts only opaque host-issued history keys", () => {
    const key = "opaque_session_key_1234"
    deepEqual(parseWebviewMessage({ type: "selectSession", key }), { type: "selectSession", key })
    equal(parseWebviewMessage({ type: "selectSession", key: "session-raw" }), undefined)
    equal(parseWebviewMessage({ type: "selectSession", key, sessionID: "ses_secret" }), undefined)
    deepEqual(parseWebviewMessage({ type: "renameSession", key, title: "New title" }), { type: "renameSession", key, title: "New title" })
    deepEqual(parseWebviewMessage({ type: "deleteSession", key }), { type: "deleteSession", key })
    equal(parseWebviewMessage({ type: "deleteSession", key: "ses_raw" }), undefined)
    deepEqual(parseHistoryMessage({
      type: "history",
      status: "ready",
      sessions: [{ key, title: "Safe chat", updated: 100, current: true, status: "idle" }],
    })?.sessions[0], { key, title: "Safe chat", updated: 100, current: true, status: "idle" })
    equal(parseHistoryMessage({ type: "history", status: "ready", sessions: [{ key, title: "Bad" }] }), undefined)
  })

  it("keeps provider connection selections opaque and bounded", () => {
    const providerKey = "opaque_provider_key_123"
    const methodKey = "opaque_method_key_12345"
    deepEqual(parseWebviewMessage({ type: "selectProviderConnection", key: providerKey }), {
      type: "selectProviderConnection",
      key: providerKey,
    })
    deepEqual(parseWebviewMessage({ type: "selectProviderMethod", key: methodKey }), {
      type: "selectProviderMethod",
      key: methodKey,
    })
    deepEqual(parseWebviewMessage({ type: "providerConnectClose" }), { type: "providerConnectClose" })
    equal(parseWebviewMessage({ type: "selectProviderConnection", key: "openai" }), undefined)
    equal(parseWebviewMessage({ type: "selectProviderMethod", key: methodKey, providerID: "openai" }), undefined)

    const providers = parseProviderConnectMessage({
      type: "providerConnect",
      status: "providers",
      providers: [{
        key: providerKey,
        name: "OpenAI",
        connected: false,
        category: "Popular",
        description: "(ChatGPT Plus/Pro or API key)",
      }],
    })
    equal(providers?.status, "providers")
    const methods = parseProviderConnectMessage({
      type: "providerConnect",
      status: "methods",
      provider: "OpenAI",
      methods: [
        { key: methodKey, label: "ChatGPT Pro/Plus (browser)", type: "oauth" },
        { key: "opaque_method_key_67890", label: "Manually enter API Key", type: "api" },
      ],
    })
    equal(methods?.status, "methods")
    equal(JSON.stringify(methods).includes("providerID"), false)
    equal(parseProviderConnectMessage({
      type: "providerConnect",
      status: "methods",
      provider: "OpenAI",
      methods: [{ key: methodKey, label: "Browser", type: "oauth", url: "https://secret.example" }],
    }), undefined)
    equal(parseProviderConnectMessage({
      type: "providerConnect",
      status: "providers",
      providers: Array.from({ length: 201 }, (_, index) => ({
        key: `opaque_provider_key_${index}`,
        name: `Provider ${index}`,
        connected: false,
        category: "Providers",
      })),
    }), undefined)
    equal(parseProviderConnectMessage({
      type: "providerConnect",
      status: "methods",
      provider: "OpenAI",
      methods: Array.from({ length: 11 }, (_, index) => ({
        key: `opaque_method_key_${index}`,
        label: `Method ${index}`,
        type: "oauth",
      })),
    }), undefined)
  })

  it("accepts only bounded local file uploads", () => {
    const upload = { type: "uploadFile", name: "clip.mp4", mime: "video/mp4", data: "AAAAAGZ0eXA=" }
    deepEqual(parseWebviewMessage(upload), upload)
    equal(parseWebviewMessage({ ...upload, data: "not base64" }), undefined)
    equal(parseWebviewMessage({ ...upload, name: "x".repeat(241) }), undefined)
    equal(parseWebviewMessage({ ...upload, command: "workbench.action.files.openFile" }), undefined)
  })

  it("accepts only opaque native-review selections and metadata", () => {
    const reviewKey = "opaque_review_key_123"
    const fileKey = "opaque_review_file_123"
    deepEqual(parseWebviewMessage({ type: "openReview", reviewKey, fileKey }), { type: "openReview", reviewKey, fileKey })
    equal(parseWebviewMessage({ type: "openReview", reviewKey: "message-raw", fileKey }), undefined)
    equal(parseWebviewMessage({ type: "openReview", reviewKey, fileKey, command: "vscode.diff" }), undefined)
    const state = {
      phase: "ready",
      messages: [
        { id: "message-1", turnID: "message-1", role: "user" as const, text: "Change it" },
        { id: "assistant-1", turnID: "message-1", role: "assistant" as const, text: "" },
      ],
      commands: [],
      agents: [],
      providers: [],
      models: [],
      selection: {},
      attachments: [],
      reviews: [{
        key: reviewKey,
        turnID: "message-1",
        attribution: "direct" as const,
        files: [{
          key: fileKey,
          path: "src/a.ts",
          additions: 2,
          deletions: 1,
          provenance: "direct" as const,
          reviewable: true,
          conflicted: false,
          overlapsDirect: false,
        }],
      }],
      permissions: [],
      questions: [],
      activities: [{
        key: "opaque_activity_key_123",
        turnID: "message-1",
        messageID: "assistant-1",
        status: "completed",
        actionCount: 1,
        changedFileCount: 0,
        truncated: false,
        items: [{
          key: "opaque_activity_item_123",
          kind: "command",
          status: "completed",
          title: "Ran command",
          detail: "bun test",
        }],
      }],
      turnUsage: [],
      sessionUsage: {},
      workspace: true,
      trusted: true,
    }
    equal(parseStateMessage({ type: "state", id: 1, state })?.state.reviews[0]?.files[0]?.path, "src/a.ts")
    equal(parseStateMessage({ type: "state", id: 1, state })?.state.activities[0]?.items[0]?.detail, "bun test")
    equal(parseStateMessage({
      type: "state",
      id: 1,
      state: { ...state, reviews: [{ ...state.reviews[0], patch: "secret" }] },
    }), undefined)
    equal(parseStateMessage({
      type: "state",
      id: 1,
      state: { ...state, activities: [{ ...state.activities[0], output: "secret" }] },
    }), undefined)
    equal(parseStateMessage({
      type: "state",
      id: 1,
      state: { ...state, activities: [{ ...state.activities[0], messageID: "message-1", turnID: "another-turn" }] },
    }), undefined)
  })

  it("accepts only fixed permission decisions", () => {
    const key = "opaque_permission_key_123"
    deepEqual(parseWebviewMessage({ type: "replyPermission", key, decision: "allow" }), {
      type: "replyPermission",
      key,
      decision: "allow",
    })
    deepEqual(parseWebviewMessage({ type: "replyPermission", key, decision: "deny" }), {
      type: "replyPermission",
      key,
      decision: "deny",
    })
    equal(parseWebviewMessage({ type: "replyPermission", key, decision: "always" }), undefined)
    equal(parseWebviewMessage({ type: "replyPermission", key, decision: "allow", requestID: "per_raw" }), undefined)
  })

  it("accepts only opaque bounded question answers", () => {
    const key = "opaque_question_key_123"
    const questionKey = "opaque_question_item_123"
    const optionKey = "opaque_question_option_123"
    deepEqual(parseWebviewMessage({
      type: "replyQuestion",
      key,
      answers: [{ questionKey, optionKeys: [optionKey], custom: "Safe answer" }],
    }), {
      type: "replyQuestion",
      key,
      answers: [{ questionKey, optionKeys: [optionKey], custom: "Safe answer" }],
    })
    deepEqual(parseWebviewMessage({ type: "rejectQuestion", key }), { type: "rejectQuestion", key })
    equal(parseWebviewMessage({ type: "replyQuestion", key, requestID: "raw", answers: [] }), undefined)
    equal(parseWebviewMessage({ type: "replyQuestion", key, answers: [{ questionKey, optionKeys: [], custom: "x".repeat(2_001) }] }), undefined)
  })

  it("accepts the post-catalog state used to enable prompts", () => {
    const message = parseStateMessage({
      type: "state",
      id: 3,
      state: {
        phase: "ready",
        messages: [{ id: "message-1", turnID: "message-1", role: "user", text: "hello" }],
        commands: [{ key: "opaque_command_key_123", name: "review", description: "Review changes", source: "command" }],
        agents: [{ id: "build", name: "Build" }],
        providers: [{ id: "openai", name: "OpenAI" }],
        models: [{
          providerID: "openai", id: "gpt-safe", name: "GPT Safe", variants: ["high"],
          audio: true, image: true, video: true, pdf: true,
        }],
        selection: { agent: "build", model: { providerID: "openai", modelID: "gpt-safe" }, variant: "high" },
        attachments: [{ id: "opaque_attachment_123", kind: "file", label: "src/a.ts" }],
        reviews: [],
        permissions: [],
        questions: [],
        activities: [],
        turnUsage: [],
        sessionUsage: {},
        workspace: true,
        trusted: true,
      },
    })
    equal(message?.state.selection.model?.modelID, "gpt-safe")
    equal(message?.state.messages[0]?.turnID, "message-1")
  })

  it("accepts only explicit bounded response, turn, session, and context-limit fields", () => {
    const tokens = { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 20 }
    const state = {
      phase: "ready",
      messages: [
        { id: "user-usage", turnID: "user-usage", role: "user", text: "مرحبا", createdAt: 1_000 },
        {
          id: "assistant-usage",
          turnID: "user-usage",
          role: "assistant",
          text: "hello",
          createdAt: 2_000,
          response: {
            completedAt: 3_000,
            agent: "build",
            providerID: "openai",
            modelID: "gpt-safe",
            variant: "high",
            cost: 0.0000001,
            contextTokens: tokens,
          },
        },
      ],
      commands: [],
      agents: [{ id: "build", name: "Build" }],
      providers: [{ id: "openai", name: "OpenAI" }],
      models: [{
        providerID: "openai", id: "gpt-safe", name: "GPT Safe", variants: ["high"], contextLimit: 128_000,
        audio: false, image: false, video: false, pdf: false,
      }],
      selection: { agent: "build", model: { providerID: "openai", modelID: "gpt-safe" }, variant: "high" },
      attachments: [],
      reviews: [],
      permissions: [],
      questions: [],
      activities: [],
      turnUsage: [{ turnID: "user-usage", cost: 0.0000001, tokens }],
      sessionUsage: { cost: 0.0000001, tokens },
      workspace: true,
      trusted: true,
    }
    const accepted = parseStateMessage({ type: "state", id: 6, state })
    equal(accepted?.state.messages[1]?.response?.modelID, "gpt-safe")
    equal(accepted?.state.turnUsage[0]?.tokens?.total, 20)
    equal(accepted?.state.models[0]?.contextLimit, 128_000)

    const assistant = state.messages[1]!
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, messages: [state.messages[0], { ...assistant, response: { ...assistant.response, raw: "secret" } }] },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, messages: [{ ...state.messages[0], response: assistant.response }, assistant] },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, messages: [state.messages[0], { ...assistant, response: { ...assistant.response, completedAt: 1_999 } }] },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, messages: [state.messages[0], { ...assistant, response: { ...assistant.response, agent: "build\u202e" } }] },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, sessionUsage: { cost: Number.POSITIVE_INFINITY, tokens } },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, sessionUsage: { tokens: { ...tokens, total: 21 } } },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, turnUsage: [{ ...state.turnUsage[0] }, { ...state.turnUsage[0] }] },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, turnUsage: [{ ...state.turnUsage[0], turnID: "hidden-turn" }] },
    }), undefined)
    equal(parseStateMessage({
      type: "state", id: 6, state: { ...state, models: [{ ...state.models[0], contextLimit: 0 }] },
    }), undefined)
  })

  it("rejects transcript messages without a validated turn identity", () => {
    equal(parseStateMessage({
      type: "state",
      id: 4,
      state: {
        phase: "ready",
        messages: [{ id: "message-1", role: "user", text: "hello" }],
        commands: [],
        agents: [],
        providers: [],
        models: [],
        selection: {},
        attachments: [],
        reviews: [],
        permissions: [],
        questions: [],
        activities: [],
        turnUsage: [],
        sessionUsage: {},
        trusted: true,
      },
    }), undefined)
  })

  it("rejects timestamps outside the JavaScript Date range", () => {
    equal(parseStateMessage({
      type: "state",
      id: 5,
      state: {
        phase: "ready",
        messages: [{ id: "message-1", turnID: "message-1", role: "user", text: "hello", createdAt: 1e308 }],
        commands: [],
        agents: [],
        providers: [],
        models: [],
        selection: {},
        attachments: [],
        reviews: [],
        permissions: [],
        questions: [],
        activities: [],
        turnUsage: [],
        sessionUsage: {},
        workspace: true,
        trusted: true,
      },
    }), undefined)
  })

  it("orders accepted before observed even when the event arrives first", () => {
    const events: SubmissionEvent[] = []
    const tracker = new SubmissionTracker((event) => events.push(event))
    tracker.start("request-1", "message-1")
    tracker.observe("message-1")
    tracker.accept("message-1")
    deepEqual(events, [
      { requestID: "request-1", status: "accepted" },
      { requestID: "request-1", status: "observed", messageID: "message-1" },
    ])
  })

  it("reports a rejected request without losing its correlation ID", () => {
    const events: SubmissionEvent[] = []
    const tracker = new SubmissionTracker((event) => events.push(event))
    tracker.start("request-2", "message-2")
    tracker.reject("message-2", "Request failed.")
    deepEqual(events, [{ requestID: "request-2", status: "rejected", error: "Request failed." }])
  })

  it("resolves every unobserved submission after a session error", () => {
    const events: SubmissionEvent[] = []
    const tracker = new SubmissionTracker((event) => events.push(event))
    tracker.start("request-3", "message-3")
    tracker.accept("message-3")
    tracker.fail("Provider failed.")
    tracker.fail("Provider failed again.")
    deepEqual(events, [
      { requestID: "request-3", status: "accepted" },
      { requestID: "request-3", status: "rejected", error: "Provider failed." },
    ])
  })

  it("rejects oversized transcript state before rendering", () => {
    const base = {
      phase: "ready",
      commands: [],
      agents: [],
      providers: [],
      models: [],
      selection: {},
      attachments: [],
      reviews: [],
      permissions: [],
      questions: [],
      activities: [],
      turnUsage: [],
      sessionUsage: {},
      workspace: true,
      trusted: true,
    }
    equal(parseStateMessage({
      type: "state",
      id: 8,
      state: {
        ...base,
        messages: Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 1 }, (_, index) => ({
          id: `message-${index}`,
          turnID: `message-${index}`,
          role: "user",
          text: "x",
        })),
      },
    }), undefined)
    equal(parseStateMessage({
      type: "state",
      id: 9,
      state: {
        ...base,
        messages: [{ id: "message", turnID: "message", role: "assistant", text: "x".repeat(MAX_TRANSCRIPT_MESSAGE_CHARS + 1) }],
      },
    }), undefined)
    equal(parseStateMessage({
      type: "state",
      id: 10,
      state: {
        ...base,
        messages: Array.from({ length: 10 }, (_, index) => ({
          id: `message-${index}`,
          turnID: `message-${index}`,
          role: "assistant",
          text: "x".repeat(Math.floor(MAX_TRANSCRIPT_TOTAL_CHARS / 10) + 1),
        })),
      },
    }), undefined)
  })

  it("accepts only metadata for image chips", () => {
    const state = {
      phase: "ready",
      messages: [],
      commands: [],
      agents: [],
      providers: [],
      models: [],
      selection: {},
      attachments: [{ id: "opaque_image_key_123", kind: "image", label: "pixel.png" }],
      reviews: [],
      permissions: [],
      questions: [],
      activities: [],
      turnUsage: [],
      sessionUsage: {},
      workspace: true,
      trusted: true,
    }
    equal(parseStateMessage({ type: "state", id: 1, state })?.state.attachments[0]?.kind, "image")
    equal(parseStateMessage({
      type: "state",
      id: 1,
      state: { ...state, attachments: [{ ...state.attachments[0], data: "data:image/png;base64,secret" }] },
    }), undefined)
  })

  it("runs only opaque bounded Core command selections", () => {
    const message = {
      type: "runCommand",
      requestID: "command_request_1",
      key: "opaque_command_key_123",
      arguments: "branch main",
      attachmentIDs: ["opaque_attachment_123"],
    }
    deepEqual(parseWebviewMessage(message), message)
    equal(parseWebviewMessage({ ...message, key: "review" }), undefined)
    equal(parseWebviewMessage({ ...message, command: "review" }), undefined)
    equal(parseWebviewMessage({ ...message, vscodeCommand: "workbench.action.terminal.new" }), undefined)
  })
})
