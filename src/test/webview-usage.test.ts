import { equal } from "node:assert/strict"
import type { ViewState } from "../protocol"
import { deriveContextUsage, formatCost, formatPercent, formatTokens } from "../webview-usage"

type Message = ViewState["messages"][number]
type Model = ViewState["models"][number]

const tokens = (total: number) => ({
  input: total,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
})

describe("usage presentation", () => {
  it("uses the newest positive assistant context and exact provider/model limit", () => {
    const messages: Message[] = [
      {
        id: "assistant-old",
        turnID: "user-old",
        role: "assistant",
        text: "old",
        response: { providerID: "provider-b", modelID: "same", contextTokens: tokens(200) },
      },
      {
        id: "assistant-streaming",
        turnID: "user-new",
        role: "assistant",
        text: "working",
        response: { providerID: "provider-a", modelID: "same", contextTokens: tokens(0) },
      },
    ]
    const models: Model[] = [
      { providerID: "provider-a", id: "same", name: "A", variants: [], contextLimit: 100, audio: false, image: false, video: false, pdf: false },
      { providerID: "provider-b", id: "same", name: "B", variants: [], contextLimit: 1_000, audio: false, image: false, video: false, pdf: false },
    ]
    const usage = deriveContextUsage(messages, models)
    equal(usage?.message.id, "assistant-old")
    equal(usage?.model?.name, "B")
    equal(usage?.percent, 20)
  })

  it("reports raw over-limit usage while leaving drawing clamping to the control", () => {
    const usage = deriveContextUsage([{
      id: "assistant",
      turnID: "user",
      role: "assistant",
      text: "done",
      response: { providerID: "provider", modelID: "model", contextTokens: tokens(150) },
    }], [{
      providerID: "provider", id: "model", name: "Model", variants: [], contextLimit: 100,
      audio: false, image: false, video: false, pdf: false,
    }])
    equal(usage?.percent, 150)
    equal(formatPercent(usage?.percent), "150%")
  })

  it("preserves tiny positive cost precision and uses em dash only for unknown values", () => {
    equal(formatCost(undefined), "—")
    equal(formatCost(0), "$0.00")
    equal(formatCost(0.0000007), "$0.0000007")
    equal(formatCost(1e-15), "$1.00e-15")
    equal(formatTokens(undefined), "—")
    equal(formatPercent(undefined), "—")
  })
})
