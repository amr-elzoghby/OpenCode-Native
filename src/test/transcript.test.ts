import { deepEqual, equal } from "node:assert/strict"
import {
  MAX_TRANSCRIPT_DELTA_CHARS,
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_TOTAL_CHARS,
} from "../protocol"
import { Transcript } from "../transcript"

describe("streamed transcript", () => {
  it("retains a part that arrives before its message", () => {
    const transcript = new Transcript()
    transcript.setPart({ id: "part-1", messageID: "message-1", text: "مرحبا" })
    transcript.upsertMessage({ id: "message-1", role: "assistant", time: { created: 2 } })
    deepEqual(transcript.snapshot(), [{ id: "message-1", turnID: "message-1", role: "assistant", text: "مرحبا", createdAt: 2 }])
  })

  it("retains deltas that arrive before the first part snapshot", () => {
    const transcript = new Transcript()
    transcript.appendPart("message-1", "part-1", "world")
    transcript.setPart({ id: "part-1", messageID: "message-1", text: "hello " })
    transcript.upsertMessage({ id: "message-1", role: "assistant", time: { created: 2 } })
    deepEqual(transcript.snapshot(), [{ id: "message-1", turnID: "message-1", role: "assistant", text: "hello world", createdAt: 2 }])
  })

  it("replaces streamed state with the authoritative hydrated transcript", () => {
    const transcript = new Transcript()
    transcript.appendPart("message-1", "part-1", "partial")
    transcript.replace([
      {
        info: { id: "message-1", role: "user", time: { created: 1 } },
        parts: [{ id: "part-1", messageID: "message-1", text: "question" }],
      },
      {
        info: { id: "message-2", parentID: "message-1", role: "assistant", time: { created: 2 } },
        parts: [{ id: "part-2", messageID: "message-2", text: "answer" }],
      },
    ])
    deepEqual(transcript.snapshot(), [
      { id: "message-1", turnID: "message-1", role: "user", text: "question", createdAt: 1 },
      { id: "message-2", turnID: "message-1", role: "assistant", text: "answer", createdAt: 2 },
    ])
  })

  it("keeps safe file metadata without exposing synthetic file contents", () => {
    const transcript = new Transcript()
    transcript.replace([{
      info: { id: "message-file", role: "user", time: { created: 1 } },
      parts: [{ id: "file-1", messageID: "message-file", filename: "src/secret.ts" }],
    }])
    transcript.setPart({ id: "synthetic", messageID: "message-file", text: "must-not-render" })
    transcript.hidePart("message-file", "synthetic")
    transcript.appendPart("message-file", "synthetic", "still-hidden")
    deepEqual(transcript.snapshot(), [{
      id: "message-file",
      turnID: "message-file",
      role: "user",
      text: "",
      createdAt: 1,
      attachments: ["src/secret.ts"],
    }])
  })

  it("does not project absolute or traversing server filenames", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "message-file", role: "user", time: { created: 1 } })
    transcript.setFile({ id: "absolute", messageID: "message-file", filename: "/home/user/private.ts" })
    transcript.setFile({ id: "traversal", messageID: "message-file", filename: "../../secret.ts" })
    deepEqual(transcript.snapshot()[0]?.attachments, ["private.ts", "secret.ts"])
  })

  it("bounds message count, deltas, individual messages, and aggregate text", () => {
    const count = new Transcript()
    Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 5 }, (_, index) => index).forEach((index) => {
      count.upsertMessage({ id: `message-${index}`, role: "assistant", time: { created: index } })
      count.setPart({ id: `part-${index}`, messageID: `message-${index}`, text: "x" })
    })
    equal(count.snapshot().length, MAX_TRANSCRIPT_MESSAGES)
    equal(count.snapshot().some((message) => message.id === "message-0"), false)

    const bounded = new Transcript()
    Array.from({ length: 10 }, (_, index) => index).forEach((index) => {
      bounded.upsertMessage({ id: `large-${index}`, role: "assistant", time: { created: index } })
      bounded.appendPart(`large-${index}`, `part-${index}`, "a".repeat(MAX_TRANSCRIPT_DELTA_CHARS + 100))
      bounded.setPart({
        id: `part-${index}`,
        messageID: `large-${index}`,
        text: "x".repeat(MAX_TRANSCRIPT_MESSAGE_CHARS + 100),
      })
    })
    const snapshot = bounded.snapshot()
    equal(Math.max(...snapshot.map((message) => message.text.length)), MAX_TRANSCRIPT_MESSAGE_CHARS)
    equal(snapshot.reduce((total, message) => total + message.text.length, 0) <= MAX_TRANSCRIPT_TOTAL_CHARS, true)
  })

  it("rejects unsafe record identifiers before they reach Webview state", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: `message\u202e`, role: "assistant", time: { created: 1 } })
    transcript.appendPart("message-safe", "x".repeat(513), "hidden")
    deepEqual(transcript.snapshot(), [])
  })

  it("drops messages with timestamps that cannot be safely rendered", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "message-negative", role: "assistant", time: { created: -1 } })
    transcript.upsertMessage({ id: "message-fractional", role: "assistant", time: { created: 1.5 } })
    transcript.upsertMessage({ id: "message-overflow", role: "assistant", time: { created: 8_640_000_000_000_001 } })
    transcript.upsertMessage({ id: "message-valid", role: "assistant", time: { created: 2 } })
    transcript.setPart({ id: "part-valid", messageID: "message-valid", text: "still renders" })
    deepEqual(transcript.snapshot(), [{
      id: "message-valid",
      turnID: "message-valid",
      role: "assistant",
      text: "still renders",
      createdAt: 2,
    }])
  })

  it("projects typed tool activity without raw output, errors, or environment", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "assistant", parentID: "user", role: "assistant", time: { created: 2 } })
    transcript.setTool({
      id: "tool-part",
      messageID: "assistant",
      tool: "bash",
      state: { status: "running", input: { command: "printenv SECRET" }, title: "printenv SECRET" },
    })
    const running = transcript.activitySnapshot()[0]!
    equal(running.turnID, "user")
    equal(running.items[0]?.title, "Ran command")
    equal(running.items[0]?.detail, "printenv SECRET")
    equal(running.items[0]?.status, "running")
    transcript.setTool({
      id: "tool-part",
      messageID: "assistant",
      tool: "bash",
      state: { status: "error", input: {}, error: "token=secret" },
    })
    equal(transcript.activitySnapshot()[0]?.items[0]?.status, "failed")
    equal(JSON.stringify(transcript.activitySnapshot()).includes("token=secret"), false)
    transcript.removePart("assistant", "tool-part")
    deepEqual(transcript.activitySnapshot(), [])
  })

  it("projects canonical typed details and preserves opaque item identity across updates", () => {
    const transcript = new Transcript("/workspace")
    transcript.upsertMessage({ id: "assistant", parentID: "user", role: "assistant", time: { created: 2 } })
    transcript.setTool({
      id: "grep-part",
      messageID: "assistant",
      tool: "grep",
      state: { status: "running", input: { pattern: "validateTask", path: "/workspace/src" } },
    })
    const initial = transcript.activitySnapshot()[0]!.items[0]!
    equal(initial.title, "Searched “validateTask” in src")
    transcript.setTool({
      id: "grep-part",
      messageID: "assistant",
      tool: "grep",
      state: {
        status: "completed",
        input: { pattern: "validateTask", path: "/workspace/src" },
        metadata: { matches: 6, output: "must-not-cross" },
      },
    })
    const completed = transcript.activitySnapshot()[0]!.items[0]!
    equal(completed.key, initial.key)
    equal(completed.detail, "6 matches")
    equal(JSON.stringify(completed).includes("must-not-cross"), false)
  })

  it("redacts common credential forms from display-safe commands", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "assistant", parentID: "user", role: "assistant", time: { created: 1 } })
    transcript.setTool({
      id: "command",
      messageID: "assistant",
      tool: "bash",
      state: {
        status: "running",
        input: {
          command: "API_KEY=env-secret curl -H \"Authorization: Bearer bearer-secret\" --header 'X-API-Key: api-secret' -u me:user-secret https://me:pass@example.com",
        },
      },
    })
    const detail = transcript.activitySnapshot()[0]?.items[0]?.detail ?? ""
    equal(detail.includes("secret"), false)
    equal(detail.includes("Authorization: <redacted>"), true)
    equal(detail.includes("X-API-Key: <redacted>"), true)
    equal(detail.includes("me:pass"), false)
    equal(detail.includes("<redacted>"), true)
  })

  it("keeps consecutive assistant phases as separate stable disclosures", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "assistant-1", parentID: "user", role: "assistant", time: { created: 1, completed: 2 } })
    transcript.setTool({ id: "read", messageID: "assistant-1", tool: "read", state: { status: "completed", input: { filePath: "src/a.ts" } } })
    const key = transcript.activitySnapshot()[0]!.key
    transcript.upsertMessage({ id: "assistant-2", parentID: "user", role: "assistant", time: { created: 3 } })
    transcript.setTool({ id: "command", messageID: "assistant-2", tool: "bash", state: { status: "running", input: { command: "bun test" } } })
    const activities = transcript.activitySnapshot()
    equal(activities.length, 2)
    equal(activities[0]!.key, key)
    equal(activities[0]!.messageID, "assistant-1")
    equal(activities[0]!.status, "completed")
    equal(activities[0]!.items[0]?.kind, "read")
    equal(activities[1]!.messageID, "assistant-2")
    equal(activities[1]!.status, "working")
    equal(activities[1]!.items[0]?.kind, "command")
    deepEqual(transcript.snapshot().map((message) => message.id), ["assistant-1", "assistant-2"])
  })

  it("projects bounded reasoning with canonical summary timing", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({
      id: "assistant",
      parentID: "user",
      role: "assistant",
      time: { created: 1, completed: 5_000 },
    })
    transcript.setReasoning({
      id: "reasoning-part",
      messageID: "assistant",
      type: "reasoning",
      text: "**Inspecting validation**\n\nChecking the current flow [REDACTED]",
      time: { start: 100, end: 2_100 },
    })
    const activity = transcript.activitySnapshot()[0]!
    equal(activity.status, "completed")
    equal(activity.items[0]?.title, "Thinking · Inspecting validation")
    equal(activity.items[0]?.detail, "Checking the current flow")
    equal(activity.items[0]?.startedAt, 100)
    equal(activity.items[0]?.endedAt, 2_100)
  })

  it("keeps active activity when per-phase retention is exhausted", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "assistant", parentID: "user", role: "assistant", time: { created: 1 } })
    Array.from({ length: 100 }, (_, index) => transcript.setTool({
      id: `completed-${index}`,
      messageID: "assistant",
      tool: "read",
      state: { status: "completed", input: { filePath: `src/${index}.ts` } },
    }))
    transcript.setTool({
      id: "active",
      messageID: "assistant",
      tool: "bash",
      state: { status: "running", input: { command: "bun test" } },
    })
    const activity = transcript.activitySnapshot()[0]!
    equal(activity.items.length, 100)
    equal(activity.items.some((item) => item.detail === "bun test" && item.status === "running"), true)
    equal(activity.truncated, true)
  })

  it("projects only normalized retry timing and preserves abort as interrupted", () => {
    const transcript = new Transcript("/workspace")
    transcript.upsertMessage({ id: "user-retry", role: "user", time: { created: 1 } })
    transcript.upsertMessage({ id: "assistant-retry", parentID: "user-retry", role: "assistant", time: { created: 2 } })
    transcript.setRetry({ attempt: 2, next: 5_000 })
    const retryKey = transcript.activitySnapshot()[0]!.key
    deepEqual(transcript.activitySnapshot()[0], {
      key: retryKey,
      turnID: "user-retry",
      messageID: "assistant-retry",
      status: "retrying",
      retry: { attempt: 2, nextAt: 5_000 },
      startedAt: 2,
      endedAt: undefined,
      actionCount: 0,
      changedFileCount: 0,
      truncated: false,
      items: [],
    })
    transcript.setRetry()
    transcript.setTool({
      id: "read-retry",
      messageID: "assistant-retry",
      tool: "read",
      state: { status: "completed", input: { filePath: "/workspace/src/a.ts" }, output: "private" },
    })
    equal(transcript.activitySnapshot()[0]!.key, retryKey)
    transcript.upsertMessage({
      id: "assistant-retry",
      parentID: "user-retry",
      role: "assistant",
      time: { created: 2, completed: 3 },
      error: { name: "MessageAbortedError" },
    })
    equal(transcript.activitySnapshot()[0]!.status, "interrupted")
  })

  it("projects explicit assistant identity, timing, response cost, and latest-context tokens", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "user-usage", role: "user", time: { created: 1_000 } })
    transcript.setPart({ id: "user-text", messageID: "user-usage", text: "question" })
    transcript.upsertMessage({
      id: "assistant-usage",
      parentID: "user-usage",
      role: "assistant",
      time: { created: 2_000, completed: 5_250 },
      agent: "build",
      providerID: "openai",
      modelID: "gpt-safe",
      variant: "high",
      cost: 0.0000007,
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 30, write: 5 }, total: 999 },
    })
    transcript.setPart({ id: "assistant-text", messageID: "assistant-usage", text: "answer" })

    deepEqual(transcript.snapshot()[1]?.response, {
      completedAt: 5_250,
      agent: "build",
      providerID: "openai",
      modelID: "gpt-safe",
      variant: "high",
      cost: 0.0000007,
      contextTokens: {
        input: 100,
        output: 20,
        reasoning: 10,
        cacheRead: 30,
        cacheWrite: 5,
        total: 165,
      },
    })
  })

  it("sums unique step-finish records per turn without confusing them with current context", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "user-usage", role: "user", time: { created: 1 } })
    transcript.setPart({ id: "user-text", messageID: "user-usage", text: "question" })
    transcript.upsertMessage({
      id: "assistant-usage",
      parentID: "user-usage",
      role: "assistant",
      time: { created: 2, completed: 5 },
      agent: "build",
      providerID: "provider",
      modelID: "model",
      cost: 0.03,
      tokens: { input: 20, output: 2, reasoning: 0, cache: { read: 4, write: 0 } },
    })
    transcript.setPart({ id: "answer", messageID: "assistant-usage", text: "done" })
    transcript.setStepFinish({
      id: "step-1",
      messageID: "assistant-usage",
      type: "step-finish",
      cost: 0.01,
      tokens: { input: 4, output: 1, reasoning: 1, cache: { read: 2, write: 0 } },
    })
    transcript.setStepFinish({
      id: "step-2",
      messageID: "assistant-usage",
      type: "step-finish",
      cost: 0.02,
      tokens: { input: 6, output: 2, reasoning: 0, cache: { read: 3, write: 1 } },
    })
    deepEqual(transcript.turnUsageSnapshot(), [{
      turnID: "user-usage",
      cost: 0.03,
      tokens: { input: 10, output: 3, reasoning: 1, cacheRead: 5, cacheWrite: 1, total: 20 },
    }])
    equal(transcript.snapshot()[1]?.response?.contextTokens?.total, 26)

    transcript.setStepFinish({
      id: "step-2",
      messageID: "assistant-usage",
      type: "step-finish",
      cost: 0.025,
      tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 3, write: 1 } },
    })
    equal(transcript.turnUsageSnapshot()[0]?.cost, 0.035)
    equal(transcript.turnUsageSnapshot()[0]?.tokens?.input, 11)
    transcript.removePart("assistant-usage", "step-1")
    equal(transcript.turnUsageSnapshot()[0]?.cost, 0.025)
    equal(transcript.turnUsageSnapshot()[0]?.tokens?.total, 13)
  })

  it("rejects malformed response metadata and invalid step replacements without retaining raw fields", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({ id: "user-safe", role: "user", time: { created: 10 } })
    transcript.setPart({ id: "user-text", messageID: "user-safe", text: "question" })
    transcript.upsertMessage({
      id: "assistant-safe",
      parentID: "user-safe",
      role: "assistant",
      time: { created: 20, completed: 19 },
      agent: "build\u202e",
      providerID: "provider",
      modelID: "model",
      cost: Number.POSITIVE_INFINITY,
      tokens: { input: -1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    transcript.setPart({ id: "assistant-text", messageID: "assistant-safe", text: "answer" })
    const response = transcript.snapshot()[1]?.response
    equal(response?.completedAt, undefined)
    equal(response?.cost, undefined)
    equal(response?.contextTokens, undefined)
    equal(response?.agent?.includes("\u202e"), false)
    transcript.setStepFinish({
      id: "bad-step",
      messageID: "assistant-safe",
      type: "step-finish",
      cost: 1,
      tokens: { input: -1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    deepEqual(transcript.turnUsageSnapshot(), [])
  })

  it("retains review metadata without retaining raw SDK message fields or patches", () => {
    const transcript = new Transcript()
    transcript.upsertMessage({
      id: "user-review",
      role: "user",
      time: { created: 1 },
      summary: {
        diffs: [{
          file: "src/a.ts",
          patch: "raw-patch-must-not-be-retained",
          additions: 1,
          deletions: 0,
          status: "modified",
        }],
      },
      providerData: { secret: "provider-data-must-not-be-retained" },
    } as Parameters<Transcript["upsertMessage"]>[0] & { providerData: { secret: string } })

    equal(transcript.reviewSnapshot()[0]?.files[0]?.path, "src/a.ts")
    const retained = transcript as unknown as { messages: Map<string, unknown> }
    const serialized = JSON.stringify([...retained.messages.values()])
    equal(serialized.includes("raw-patch-must-not-be-retained"), false)
    equal(serialized.includes("provider-data-must-not-be-retained"), false)
  })
})
