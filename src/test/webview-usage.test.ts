import { equal } from "node:assert/strict"
import { formatCost, formatTokens } from "../webview-usage"

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
})
