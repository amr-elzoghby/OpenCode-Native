import { equal } from "node:assert/strict"
import { activityLabel, formatDuration, formatTimestamp, reviewReady } from "../webview-transcript"
import type { ViewState } from "../protocol"

type Activity = ViewState["activities"][number]
type Item = Activity["items"][number]

describe("activity disclosure presentation", () => {
  it("summarizes a completed phase in sentence-style canonical actions", () => {
    equal(activityLabel(activity([
      item("read", "Read src/a.ts"),
      item("read", "Read src/b.ts"),
      item("command", "Ran command"),
    ], { startedAt: 0, endedAt: 2_500 })), "Read files, ran a command · 3s")
  })

  it("keeps live, retry, failure, and interruption states compact", () => {
    equal(activityLabel(activity([
      item("reasoning", "Thinking"),
      item("search", "Searched the workspace"),
    ], { status: "working" })), "Thinking · searched the workspace")
    equal(activityLabel(activity([], { status: "retrying", retry: { attempt: 3, nextAt: 100 } })), "Retrying · attempt 3")
    equal(activityLabel(activity([item("edit", "Edited src/a.ts")], { status: "failed" })), "Edited a file · failed")
    equal(activityLabel(activity([item("command", "Ran command")], { status: "interrupted" })), "Ran a command · interrupted")
  })

  it("withholds the review while any assistant phase is still active", () => {
    equal(reviewReady([
      activity([item("read", "Read src/a.ts")], { status: "working" }),
      activity([item("command", "Ran command")], { status: "completed" }),
    ]), false)
    equal(reviewReady([
      activity([item("read", "Read src/a.ts")], { status: "completed" }),
      activity([item("command", "Ran command")], { status: "failed" }),
    ]), true)
  })

  it("formats only real response timing and preserves unknown as an em dash", () => {
    equal(formatDuration(999), "999ms")
    equal(formatDuration(2_500), "3s")
    equal(formatTimestamp(undefined), "—")
    equal(formatTimestamp(Number.NaN), "—")
    equal(formatTimestamp(0) === "—", false)
  })
})

function activity(items: Item[], overrides: Partial<Activity> = {}): Activity {
  return {
    key: "opaque_activity_key_123",
    turnID: "turn-1",
    messageID: "assistant-1",
    status: "completed",
    actionCount: items.length,
    changedFileCount: 0,
    truncated: false,
    items,
    ...overrides,
  }
}

function item(kind: Item["kind"], title: string): Item {
  return {
    key: `opaque_activity_${kind}_123`,
    kind,
    status: "completed",
    title,
  }
}
