import { deepEqual, equal } from "node:assert/strict"
import { addCosts, addUsageTokens, projectCost, projectTokens, projectUsage } from "../usage"

describe("official usage projection", () => {
  const raw = (input: number, output: number, reasoning = 0, read = 0, write = 0) => ({
    input,
    output,
    reasoning,
    cache: { read, write },
  })

  it("normalizes the five exclusive Core token buckets without trusting raw total", () => {
    deepEqual(projectTokens({ ...raw(10, 4, 3, 7, 2), total: 999_999 }), {
      input: 10,
      output: 4,
      reasoning: 3,
      cacheRead: 7,
      cacheWrite: 2,
      total: 26,
    })
    deepEqual(projectUsage(0, raw(0, 0)), {
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
  })

  it("rejects negative, fractional, non-finite, incomplete, and overflowing values", () => {
    equal(projectCost(-1), undefined)
    equal(projectCost(Number.POSITIVE_INFINITY), undefined)
    equal(projectCost(1_000_000_001), undefined)
    equal(projectTokens(raw(-1, 0)), undefined)
    equal(projectTokens(raw(0.5, 0)), undefined)
    equal(projectTokens({ input: 1, output: 1, reasoning: 0, cache: { read: 0 } }), undefined)
    equal(projectTokens(raw(Number.MAX_SAFE_INTEGER, 1)), undefined)
  })

  it("adds bounded step totals while preserving explicit zero", () => {
    const first = projectTokens(raw(4, 2, 1, 3, 0))!
    const second = projectTokens(raw(6, 1, 0, 2, 1))!
    deepEqual(addUsageTokens([first, second]), {
      input: 10,
      output: 3,
      reasoning: 1,
      cacheRead: 5,
      cacheWrite: 1,
      total: 20,
    })
    equal(Math.abs((addCosts([0, 0.00000001, 0.02]) ?? 0) - 0.02000001) < 1e-12, true)
    equal(addUsageTokens([]), undefined)
  })
})
