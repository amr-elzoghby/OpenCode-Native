import { randomBytes } from "node:crypto"

const MAX_REQUESTS = 10
const MAX_QUESTIONS = 10
const MAX_OPTIONS = 20
export const MAX_CUSTOM_ANSWER = 2_000

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
  tool?: { messageID: string; callID: string }
}

export type QuestionPrompt = {
  key: string
  questions: Array<{
    key: string
    header: string
    question: string
    multiple: boolean
    custom: boolean
    options: Array<{ key: string; label: string; description: string }>
  }>
}

export type QuestionAnswer = {
  questionKey: string
  optionKeys: string[]
  custom?: string
}

type Record = QuestionPrompt & {
  requestID: string
  sessionID: string
  fingerprint: string
  values: Map<string, string>
}

export class QuestionStore {
  private records = new Map<string, Record>()

  constructor(private createKey: () => string = () => randomBytes(18).toString("base64url")) {}

  clear() {
    this.records.clear()
  }

  upsert(request: QuestionRequest, sessionID: string) {
    const projected = project(request, sessionID, this.createKey)
    if (!projected) return
    const existing = this.records.get(request.id)
    if (existing?.fingerprint === projected.fingerprint) return
    this.records.set(request.id, projected)
    while (this.records.size > MAX_REQUESTS) this.records.delete(this.records.keys().next().value!)
  }

  remove(requestID: string) {
    this.records.delete(requestID)
  }

  snapshot(): QuestionPrompt[] {
    return [...this.records.values()].map((record) => ({
      key: record.key,
      questions: record.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option })),
      })),
    }))
  }

  resolve(key: string) {
    const record = [...this.records.values()].find((item) => item.key === key)
    return record ? { requestID: record.requestID, sessionID: record.sessionID, fingerprint: record.fingerprint } : undefined
  }

  matches(key: string, request: QuestionRequest) {
    const record = [...this.records.values()].find((item) => item.key === key)
    return !!record && record.requestID === request.id && record.sessionID === request.sessionID && record.fingerprint === fingerprint(request)
  }

  answers(key: string, request: QuestionRequest, answers: QuestionAnswer[]) {
    const record = [...this.records.values()].find((item) => item.key === key)
    if (!record || record.fingerprint !== fingerprint(request) || answers.length !== record.questions.length) return
    const resolved = answers.map((answer, index) => {
      const question = record.questions[index]
      if (!question || answer.questionKey !== question.key || answer.optionKeys.length > MAX_OPTIONS) return
      if (!question.multiple && answer.optionKeys.length > 1) return
      if (new Set(answer.optionKeys).size !== answer.optionKeys.length) return
      const selected = answer.optionKeys.map((option) => record.values.get(`${question.key}:${option}`))
      if (selected.some((value) => value === undefined)) return
      const custom = answer.custom === undefined ? undefined : safeText(answer.custom, MAX_CUSTOM_ANSWER)
      if (answer.custom !== undefined && (!question.custom || custom === undefined)) return
      const values = [...selected] as string[]
      if (custom) values.push(custom)
      if (values.length === 0) return
      return values
    })
    if (resolved.some((answer) => answer === undefined)) return
    return resolved as string[][]
  }
}

function project(request: QuestionRequest, sessionID: string, createKey: () => string): Record | undefined {
  if (request.sessionID !== sessionID || !safeID(request.id) || !Array.isArray(request.questions) || request.questions.length === 0 || request.questions.length > MAX_QUESTIONS) return
  if (request.tool && (!safeID(request.tool.messageID) || !safeID(request.tool.callID))) return
  const values = new Map<string, string>()
  const questions = request.questions.map((question) => {
    const header = safeText(question.header, 80)
    const text = safeText(question.question, 1_000)
    if (!header || !text || !Array.isArray(question.options) || question.options.length > MAX_OPTIONS || (question.options.length === 0 && question.custom === false)) return
    const questionKey = createKey()
    const options = question.options.map((option) => {
      const label = safeText(option.label, 160)
      const description = safeOptionalText(option.description, 500)
      if (!label || description === undefined) return
      const key = createKey()
      values.set(`${questionKey}:${key}`, option.label)
      return { key, label, description }
    })
    if (options.some((option) => option === undefined)) return
    return {
      key: questionKey,
      header,
      question: text,
      multiple: question.multiple === true,
      custom: question.custom !== false,
      options: options as Array<{ key: string; label: string; description: string }>,
    }
  })
  if (questions.some((question) => question === undefined)) return
  return {
    key: createKey(),
    requestID: request.id,
    sessionID,
    fingerprint: fingerprint(request),
    questions: questions as QuestionPrompt["questions"],
    values,
  }
}

function fingerprint(request: QuestionRequest) {
  return JSON.stringify([request.id, request.sessionID, request.questions, request.tool])
}

function safeText(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length > maximum * 4) return
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�").trim().slice(0, maximum)
  return text || undefined
}

function safeOptionalText(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length > maximum * 4) return
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�").trim().slice(0, maximum)
}

function safeID(value: string) {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}
