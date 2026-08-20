import { deepEqual, equal, match } from "node:assert/strict"
import { QuestionStore } from "../questions"

describe("question trust boundary", () => {
  it("projects bounded questions behind opaque keys and resolves only real options", () => {
    let index = 0
    const store = new QuestionStore(() => `opaque_question_key_${++index}`)
    const request = questionRequest()
    store.upsert(request, "session")
    const prompt = store.snapshot()[0]!
    equal(prompt.questions[0]!.question, "Choose a strategy")
    equal(JSON.stringify(prompt).includes("request"), false)
    match(prompt.key, /^opaque_question_key_/)
    deepEqual(store.answers(prompt.key, request, [{
      questionKey: prompt.questions[0]!.key,
      optionKeys: [prompt.questions[0]!.options[1]!.key],
    }]), [["Careful"]])
    equal(store.answers(prompt.key, request, [{
      questionKey: prompt.questions[0]!.key,
      optionKeys: ["opaque_forged_key_123"],
    }]), undefined)
    store.upsert(request, "session")
    deepEqual(store.snapshot(), [prompt])
  })

  it("enforces single/multiple and custom-answer semantics", () => {
    let index = 0
    const store = new QuestionStore(() => `opaque_question_key_${++index}`)
    const request = questionRequest()
    store.upsert(request, "session")
    const prompt = store.snapshot()[0]!
    const question = prompt.questions[0]!
    equal(store.answers(prompt.key, request, [{
      questionKey: question.key,
      optionKeys: question.options.map((option) => option.key),
    }]), undefined)
    deepEqual(store.answers(prompt.key, request, [{
      questionKey: question.key,
      optionKeys: [],
      custom: "Another safe answer",
    }]), [["Another safe answer"]])
    const changed = { ...request, questions: [{ ...request.questions[0]!, question: "Changed" }] }
    equal(store.answers(prompt.key, changed, [{ questionKey: question.key, optionKeys: [question.options[0]!.key] }]), undefined)
    equal(store.matches(prompt.key, { ...request, tool: { messageID: "different", callID: "private" } }), false)
  })

  it("rejects cross-session and sanitizes control and BiDi text", () => {
    let index = 0
    const store = new QuestionStore(() => `opaque_question_key_${++index}`)
    store.upsert(questionRequest(), "other")
    deepEqual(store.snapshot(), [])
    store.upsert({
      ...questionRequest(),
      questions: [{
        ...questionRequest().questions[0]!,
        header: "Mode\u202ehidden",
        question: "Pick\u0000 one",
      }],
    }, "session")
    const question = store.snapshot()[0]!.questions[0]!
    equal(question.header.includes("\u202e"), false)
    equal(question.question.includes("\u0000"), false)
  })
})

function questionRequest() {
  return {
    id: "question_request",
    sessionID: "session",
    questions: [{
      header: "Strategy",
      question: "Choose a strategy",
      options: [
        { label: "Fast", description: "Use the shortest path" },
        { label: "Careful", description: "Check each step" },
      ],
      multiple: false,
      custom: true,
    }],
    tool: { messageID: "secret", callID: "secret" },
  }
}
