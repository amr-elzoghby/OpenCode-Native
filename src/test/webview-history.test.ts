import { equal } from "node:assert/strict"
import { formatRelativeTime } from "../webview-history"

describe("chat history relative time", () => {
  const now = Date.UTC(2026, 7, 16, 12)

  it("uses compact units and rolls hours into whole days", () => {
    equal(formatRelativeTime(now - 30_000, now), "now")
    equal(formatRelativeTime(now - 5 * 60_000, now), "5m")
    equal(formatRelativeTime(now - 23 * 3_600_000, now), "23h")
    equal(formatRelativeTime(now - 25 * 3_600_000, now), "1d")
    equal(formatRelativeTime(now - 49 * 3_600_000, now), "2d")
  })
})
