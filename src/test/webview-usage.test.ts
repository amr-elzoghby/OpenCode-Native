import { deepEqual, equal } from "node:assert/strict"
import { chatUsageRows, formatCost, formatTokens } from "../webview-usage"

describe("usage presentation", () => {
  it("formats the current conversation token total without inventing unavailable data", () => {
    equal(formatTokens(6_157), "6,157")
    equal(formatTokens(0), "0")
    equal(formatTokens(undefined), "—")
  })

  it("preserves tiny positive cost precision for per-turn response details", () => {
    equal(formatCost(undefined), "—")
    equal(formatCost(0), "$0.00")
    equal(formatCost(0.0000007), "$0.0000007")
    equal(formatCost(1e-15), "$1.00e-15")
  })

  it("presents the authoritative complete-chat usage as one detailed breakdown", () => {
    deepEqual(chatUsageRows({
      cost: 0.25,
      tokens: { input: 2_563, output: 14, reasoning: 0, cacheRead: 3_584, cacheWrite: 0, total: 6_161 },
    }), [
      ["Cost", "$0.25"],
      ["Input", "2,563"],
      ["Output", "14"],
      ["Reasoning", "0"],
      ["Cache read", "3,584"],
      ["Cache write", "0"],
      ["Tokens", "6,161"],
    ])

    const zero = chatUsageRows({
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
    deepEqual(zero[0], ["Cost", "—"])
    deepEqual(zero.at(-1), ["Tokens", "0"])
  })
})
