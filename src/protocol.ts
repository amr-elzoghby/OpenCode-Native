import type { ResponseMetadata, TurnUsage, UsageTokens, UsageTotals } from "./usage"

const MAX_PROMPT_LENGTH = 100_000
const MAX_REQUEST_ID_LENGTH = 128
const MAX_ATTACHMENTS = 20
const MAX_REVIEWS = 40
const MAX_REVIEW_FILES = 100
const MAX_REVIEW_TOTAL_FILES = 500
const MAX_PERMISSIONS = 20
const MAX_QUESTION_REQUESTS = 10
const MAX_TURN_ACTIVITIES = 200
const MAX_ACTIVITY_ITEMS = 500
const MAX_ACTIVITY_TOTAL_CHARS = 512_000
const MAX_COMMANDS = 200
const MAX_PROVIDER_CONNECTIONS = 200
const MAX_PROVIDER_METHODS = 10
export const MAX_ROLLED_BACK_MESSAGES = 20
export const MAX_ROLLED_BACK_PREVIEW_CHARS = 320
const MAX_ROLLED_BACK_TOTAL_CHARS = MAX_ROLLED_BACK_MESSAGES * MAX_ROLLED_BACK_PREVIEW_CHARS
export const MAX_TRANSCRIPT_MESSAGES = 200
export const MAX_TRANSCRIPT_MESSAGE_CHARS = 256_000
export const MAX_TRANSCRIPT_TOTAL_CHARS = 2_000_000
export const MAX_TRANSCRIPT_DELTA_CHARS = 32_000

export const NATIVE_ACTIONS = [
  "new",
  "refresh",
  "sessions",
  "models",
  "org",
  "agents",
  "variants",
  "connect",
  "mcps",
  "status",
  "timeline",
  "timestamps",
  "compact",
  "rename",
  "copy",
  "debug",
  "diff",
  "export",
  "exit",
  "fork",
  "help",
  "share",
  "skills",
  "themes",
  "thinking",
  "unshare",
  "undo",
  "redo",
] as const
export type NativeAction = (typeof NATIVE_ACTIONS)[number]
export const NATIVE_ACTION_ALIASES: Partial<Record<NativeAction, readonly string[]>> = {
  new: ["clear"],
  sessions: ["resume", "continue"],
  models: ["mo"],
  org: ["orgs", "switch-org"],
  compact: ["summarize"],
  exit: ["quit", "q"],
  thinking: ["toggle-thinking"],
  timestamps: ["toggle-timestamps"],
}

export function isReservedNativeSlashName(value: string) {
  const name = value.toLocaleLowerCase()
  return NATIVE_ACTIONS.some((action) => name === action || NATIVE_ACTION_ALIASES[action]?.includes(name))
}

export type HistorySession = {
  key: string
  title: string
  updated: number
  current: boolean
  status?: "idle" | "busy" | "retry"
}

export const ATTACHMENT_ACTIONS = ["workspaceFiles", "currentFile", "currentSelection"] as const
export type AttachmentAction = (typeof ATTACHMENT_ACTIONS)[number]
export const MAX_LOCAL_FILE_BYTES = 25 * 1024 * 1024
export const MAX_LOCAL_FILE_BASE64_CHARS = Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4
export type AttachmentChip = {
  id: string
  kind: "file" | "selection" | "image"
  label: string
  range?: { start: number; end: number }
}

export type ViewState = {
  phase: "idle" | "starting" | "ready" | "loading" | "stopping" | "syncing" | "error"
  messages: Array<{
    id: string
    turnID: string
    role: "user" | "assistant"
    text: string
    createdAt?: number
    attachments?: string[]
    response?: ResponseMetadata
  }>
  commands: Array<{
    key: string
    name: string
    description?: string
    source: "command" | "mcp" | "skill"
  }>
  agents: Array<{ id: string; name: string }>
  providers: Array<{ id: string; name: string }>
  models: Array<{
    providerID: string
    id: string
    name: string
    variants: string[]
    contextLimit?: number
    audio: boolean
    image: boolean
    video: boolean
    pdf: boolean
  }>
  selection: { agent?: string; model?: { providerID: string; modelID: string }; variant?: string }
  attachments: AttachmentChip[]
  reviews: Array<{
    key: string
    turnID: string
    attribution: "direct" | "observed" | "mixed"
    files: Array<{
      key: string
      path: string
      previousPath?: string
      additions?: number
      deletions?: number
      provenance: "direct" | "snapshot"
      reviewable: boolean
      conflicted: boolean
      overlapsDirect: boolean
    }>
  }>
  permissions: Array<{ key: string; title: string; details: string[]; files: Array<{ key: string; path: string }> }>
  questions: Array<{
    key: string
    questions: Array<{
      key: string
      header: string
      question: string
      multiple: boolean
      custom: boolean
      options: Array<{ key: string; label: string; description: string }>
    }>
  }>
  activities: Array<{
    key: string
    turnID: string
    messageID: string
    status: "working" | "retrying" | "completed" | "interrupted" | "failed"
    retry?: { attempt: number; nextAt: number }
    startedAt?: number
    endedAt?: number
    actionCount: number
    changedFileCount: number
    truncated: boolean
    items: Array<{
      key: string
      kind: "reasoning" | "command" | "read" | "search" | "web" | "edit" | "task" | "question" | "todo" | "tool"
      status: "waiting" | "running" | "completed" | "failed" | "denied"
      title: string
      detail?: string
      startedAt?: number
      endedAt?: number
      files?: Array<{ key: string; path: string; additions?: number; deletions?: number }>
    }>
  }>
  turnUsage: TurnUsage[]
  sessionUsage: UsageTotals
  rolledBack: {
    count: number
    truncated: boolean
    messages: Array<{ key: string; preview: string; createdAt?: number }>
  }
  workspace: boolean
  trusted: boolean
  error?: string
}

export type StateMessage = { type: "state"; id: number; state: ViewState }
export type ActionMessage = { type: "action"; action: NativeAction }
export type UsageMessage = { type: "usage"; action: "open" }
export type ComposerMessage = { type: "composer"; text: string }
export type RollbackResultMessage = {
  type: "rollbackResult"
  key: string
  status: "restored" | "rejected"
}
export type HistoryMessage =
  | { type: "history"; status: "loading" | "closed"; sessions: [] }
  | { type: "history"; status: "ready"; sessions: HistorySession[] }
  | { type: "history"; status: "error"; sessions: HistorySession[]; error: string }

export type ProviderConnectMessage =
  | { type: "providerConnect"; status: "closed" }
  | { type: "providerConnect"; status: "loading"; message: string }
  | { type: "providerConnect"; status: "busy"; message: string }
  | {
      type: "providerConnect"
      status: "providers"
      providers: Array<{
        key: string
        name: string
        connected: boolean
        category: "Popular" | "Providers"
        description?: string
      }>
    }
  | {
      type: "providerConnect"
      status: "methods"
      provider: string
      methods: Array<{ key: string; label: string; type: "api" | "oauth" }>
    }
  | { type: "providerConnect"; status: "error"; message: string }

export type WebviewMessage =
  | { type: "ready" }
  | { type: "sidebarFocus"; focused: boolean }
  | { type: "invokeAction"; action: NativeAction }
  | { type: "providerConnectClose" }
  | { type: "selectProviderConnection"; key: string }
  | { type: "selectProviderMethod"; key: string }
  | { type: "runCommand"; requestID: string; key: string; arguments: string; attachmentIDs: string[] }
  | { type: "sendPrompt"; requestID: string; text: string; attachmentIDs: string[] }
  | { type: "stop" }
  | { type: "selectAgent"; id: string }
  | { type: "selectModel"; providerID: string; modelID: string }
  | { type: "selectVariant"; id?: string }
  | { type: "selectSession"; key: string }
  | { type: "renameSession"; key: string; title: string }
  | { type: "deleteSession"; key: string }
  | { type: "restoreRolledBack"; key: string }
  | { type: "attachmentAction"; action: AttachmentAction }
  | { type: "uploadFile"; name: string; mime: string; data: string }
  | { type: "removeAttachment"; id: string }
  | { type: "openReview"; reviewKey: string; fileKey: string }
  | { type: "replyPermission"; key: string; decision: "allow" | "deny" }
  | { type: "replyQuestion"; key: string; answers: Array<{ questionKey: string; optionKeys: string[]; custom?: string }> }
  | { type: "rejectQuestion"; key: string }
  | { type: "composerFocus"; focused: boolean }
  | { type: "rendered"; id: number }

export type SubmissionEvent =
  | { requestID: string; status: "accepted" }
  | { requestID: string; status: "rejected"; error: string }
  | { requestID: string; status: "observed"; messageID: string }

export type SubmissionMessage =
  | { type: "submission"; requestID: string; status: "submitted" }
  | ({ type: "submission" } & SubmissionEvent)

export class SubmissionTracker {
  private submissions = new Map<string, { requestID: string; accepted: boolean; observed: boolean }>()

  constructor(private emit: (event: SubmissionEvent) => void) {}

  start(requestID: string, messageID: string) {
    this.submissions.set(messageID, { requestID, accepted: false, observed: false })
  }

  accept(messageID: string) {
    const submission = this.submissions.get(messageID)
    if (!submission || submission.accepted) return
    submission.accepted = true
    this.emit({ requestID: submission.requestID, status: "accepted" })
    this.complete(messageID, submission)
  }

  observe(messageID: string) {
    const submission = this.submissions.get(messageID)
    if (!submission || submission.observed) return false
    submission.observed = true
    this.complete(messageID, submission)
    return true
  }

  reject(messageID: string, error: string) {
    const submission = this.submissions.get(messageID)
    if (!submission) return
    if (submission.observed) {
      this.accept(messageID)
      return
    }
    this.submissions.delete(messageID)
    this.emit({ requestID: submission.requestID, status: "rejected", error })
  }

  rejectRequest(requestID: string, error: string) {
    this.emit({ requestID, status: "rejected", error })
  }

  clear() {
    this.submissions.clear()
  }

  fail(error: string) {
    this.submissions.forEach((submission, messageID) => {
      if (submission.observed) {
        this.accept(messageID)
        return
      }
      this.submissions.delete(messageID)
      this.emit({ requestID: submission.requestID, status: "rejected", error })
    })
  }

  private complete(messageID: string, submission: { requestID: string; accepted: boolean; observed: boolean }) {
    if (!submission.accepted || !submission.observed) return
    this.emit({ requestID: submission.requestID, status: "observed", messageID })
    this.submissions.delete(messageID)
  }
}

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  const item = record(value)
  if (!item || typeof item.type !== "string") return
  if (item.type === "ready" && exactKeys(item, ["type"])) return { type: "ready" }
  if (item.type === "providerConnectClose" && exactKeys(item, ["type"])) return { type: "providerConnectClose" }
  if (
    item.type === "selectProviderConnection" && exactKeys(item, ["type", "key"]) && validOpaqueKey(item.key)
  ) return { type: "selectProviderConnection", key: item.key }
  if (
    item.type === "selectProviderMethod" && exactKeys(item, ["type", "key"]) && validOpaqueKey(item.key)
  ) return { type: "selectProviderMethod", key: item.key }
  if (item.type === "invokeAction" && exactKeys(item, ["type", "action"]) && isNativeAction(item.action)) {
    return { type: "invokeAction", action: item.action }
  }
  if (
    item.type === "runCommand" &&
    exactKeys(item, ["type", "requestID", "key", "arguments", "attachmentIDs"]) &&
    validRequestID(item.requestID) && validOpaqueKey(item.key) &&
    typeof item.arguments === "string" && item.arguments.length <= MAX_PROMPT_LENGTH &&
    safeArray(item.attachmentIDs, validOpaqueKey) && (item.attachmentIDs as unknown[]).length <= MAX_ATTACHMENTS
  ) return {
    type: "runCommand",
    requestID: item.requestID,
    key: item.key,
    arguments: item.arguments,
    attachmentIDs: item.attachmentIDs as string[],
  }
  if (item.type === "stop" && exactKeys(item, ["type"])) return { type: "stop" }
  if (item.type === "sidebarFocus" && exactKeys(item, ["type", "focused"]) && typeof item.focused === "boolean") {
    return { type: "sidebarFocus", focused: item.focused }
  }
  if (item.type === "composerFocus" && exactKeys(item, ["type", "focused"]) && typeof item.focused === "boolean") {
    return { type: "composerFocus", focused: item.focused }
  }
  if (item.type === "selectSession" && exactKeys(item, ["type", "key"]) && validOpaqueKey(item.key)) {
    return { type: "selectSession", key: item.key }
  }
  if (
    item.type === "renameSession" &&
    exactKeys(item, ["type", "key", "title"]) &&
    validOpaqueKey(item.key) &&
    typeof item.title === "string" &&
    item.title.length <= 200
  ) return { type: "renameSession", key: item.key, title: item.title }
  if (item.type === "deleteSession" && exactKeys(item, ["type", "key"]) && validOpaqueKey(item.key)) {
    return { type: "deleteSession", key: item.key }
  }
  if (item.type === "restoreRolledBack" && exactKeys(item, ["type", "key"]) && validOpaqueKey(item.key)) {
    return { type: "restoreRolledBack", key: item.key }
  }
  if (
    item.type === "attachmentAction" &&
    exactKeys(item, ["type", "action"]) &&
    ATTACHMENT_ACTIONS.some((action) => action === item.action)
  ) return { type: "attachmentAction", action: item.action as AttachmentAction }
  if (
    item.type === "uploadFile" &&
    exactKeys(item, ["type", "name", "mime", "data"]) &&
    safeString(item.name, 240) &&
    safeString(item.mime, 100) &&
    typeof item.data === "string" &&
    item.data.length > 0 &&
    item.data.length <= MAX_LOCAL_FILE_BASE64_CHARS &&
    item.data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(item.data)
  ) return { type: "uploadFile", name: item.name, mime: item.mime, data: item.data }
  if (item.type === "removeAttachment" && exactKeys(item, ["type", "id"]) && validOpaqueKey(item.id)) {
    return { type: "removeAttachment", id: item.id }
  }
  if (
    item.type === "openReview" &&
    exactKeys(item, ["type", "reviewKey", "fileKey"]) &&
    validOpaqueKey(item.reviewKey) &&
    validOpaqueKey(item.fileKey)
  ) return { type: "openReview", reviewKey: item.reviewKey, fileKey: item.fileKey }
  if (
    item.type === "replyPermission" &&
    exactKeys(item, ["type", "key", "decision"]) &&
    validOpaqueKey(item.key) &&
    (item.decision === "allow" || item.decision === "deny")
  ) return { type: "replyPermission", key: item.key, decision: item.decision }
  if (item.type === "rejectQuestion" && exactKeys(item, ["type", "key"]) && validOpaqueKey(item.key)) {
    return { type: "rejectQuestion", key: item.key }
  }
  if (
    item.type === "replyQuestion" &&
    exactKeys(item, ["type", "key", "answers"]) &&
    validOpaqueKey(item.key) &&
    safeArray(item.answers, isQuestionAnswer) &&
    (item.answers as unknown[]).length <= 10
  ) return {
    type: "replyQuestion",
    key: item.key,
    answers: item.answers as Array<{ questionKey: string; optionKeys: string[]; custom?: string }>,
  }
  if (
    item.type === "rendered" &&
    exactKeys(item, ["type", "id"]) &&
    Number.isSafeInteger(item.id) &&
    Number(item.id) > 0
  ) return { type: "rendered", id: Number(item.id) }
  if (item.type === "selectAgent" && exactKeys(item, ["type", "id"]) && validID(item.id)) {
    return { type: "selectAgent", id: item.id }
  }
  if (
    item.type === "selectModel" &&
    exactKeys(item, ["type", "providerID", "modelID"]) &&
    validID(item.providerID) &&
    validID(item.modelID)
  ) {
    return { type: "selectModel", providerID: item.providerID, modelID: item.modelID }
  }
  if (
    item.type === "selectVariant" &&
    (exactKeys(item, ["type"]) || exactKeys(item, ["type", "id"])) &&
    (item.id === undefined || validID(item.id))
  ) {
    return { type: "selectVariant", id: typeof item.id === "string" ? item.id : undefined }
  }
  if (
    item.type !== "sendPrompt" ||
    !exactKeys(item, ["type", "requestID", "text", "attachmentIDs"]) ||
    !validRequestID(item.requestID) ||
    typeof item.text !== "string" ||
    !safeArray(item.attachmentIDs, validOpaqueKey) ||
    (item.attachmentIDs as unknown[]).length > MAX_ATTACHMENTS
  ) return

  const text = item.text.trim()
  if ((!text && !(item.attachmentIDs as string[]).length) || text.length > MAX_PROMPT_LENGTH) return
  return { type: "sendPrompt", requestID: item.requestID, text, attachmentIDs: item.attachmentIDs as string[] }
}

export function parseActionMessage(value: unknown): ActionMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "action" || !exactKeys(item, ["type", "action"]) || !isNativeAction(item.action)) return
  return { type: "action", action: item.action }
}

export function parseUsageMessage(value: unknown): UsageMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "usage" || item.action !== "open" || !exactKeys(item, ["type", "action"])) return
  return { type: "usage", action: "open" }
}

export function parseComposerMessage(value: unknown): ComposerMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "composer" || !exactKeys(item, ["type", "text"]) ||
    typeof item.text !== "string" || item.text.length > MAX_PROMPT_LENGTH) return
  return { type: "composer", text: item.text }
}

export function parseRollbackResultMessage(value: unknown): RollbackResultMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "rollbackResult" || !exactKeys(item, ["type", "key", "status"]) ||
    !validOpaqueKey(item.key) || (item.status !== "restored" && item.status !== "rejected")) return
  return { type: "rollbackResult", key: item.key, status: item.status }
}

export function parseHistoryMessage(value: unknown): HistoryMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "history" || !safeArray(item.sessions, isHistorySession) || (item.sessions as unknown[]).length > 200) return
  if (
    (item.status === "loading" || item.status === "closed") &&
    exactKeys(item, ["type", "status", "sessions"]) &&
    (item.sessions as unknown[]).length === 0
  ) return { type: "history", status: item.status, sessions: [] }
  if (item.status === "ready" && exactKeys(item, ["type", "status", "sessions"])) {
    return { type: "history", status: "ready", sessions: item.sessions as HistorySession[] }
  }
  if (
    item.status === "error" &&
    exactKeys(item, ["type", "status", "sessions", "error"]) &&
    safeString(item.error, 10_000)
  ) {
    return { type: "history", status: "error", sessions: item.sessions as HistorySession[], error: item.error }
  }
}

export function parseProviderConnectMessage(value: unknown): ProviderConnectMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "providerConnect" || typeof item.status !== "string") return
  if (item.status === "closed" && exactKeys(item, ["type", "status"])) {
    return { type: "providerConnect", status: "closed" }
  }
  if (
    (item.status === "loading" || item.status === "busy" || item.status === "error") &&
    exactKeys(item, ["type", "status", "message"]) && safeString(item.message, 1_000)
  ) return { type: "providerConnect", status: item.status, message: item.message }
  if (
    item.status === "providers" && exactKeys(item, ["type", "status", "providers"]) &&
    safeArray(item.providers, isProviderConnectionOption) &&
    (item.providers as unknown[]).length <= MAX_PROVIDER_CONNECTIONS
  ) return { type: "providerConnect", status: "providers", providers: item.providers as Extract<ProviderConnectMessage, { status: "providers" }>["providers"] }
  if (
    item.status === "methods" && exactKeys(item, ["type", "status", "provider", "methods"]) &&
    safeString(item.provider, 120) && safeArray(item.methods, isProviderMethodOption) &&
    (item.methods as unknown[]).length > 0 && (item.methods as unknown[]).length <= MAX_PROVIDER_METHODS
  ) return {
    type: "providerConnect",
    status: "methods",
    provider: item.provider,
    methods: item.methods as Extract<ProviderConnectMessage, { status: "methods" }>["methods"],
  }
}

export function parseSubmissionMessage(value: unknown): SubmissionMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "submission" || !validRequestID(item.requestID)) return
  if (item.status !== "submitted" && item.status !== "accepted" && item.status !== "rejected" && item.status !== "observed") return
  if (item.status === "rejected") {
    if (!exactKeys(item, ["type", "requestID", "status", "error"]) || typeof item.error !== "string") return
    if (!item.error || item.error.length > 10_000) return
    return { type: "submission", requestID: item.requestID, status: item.status, error: item.error }
  }
  if (item.status === "observed") {
    if (!exactKeys(item, ["type", "requestID", "status", "messageID"]) || !validID(item.messageID)) return
    return { type: "submission", requestID: item.requestID, status: item.status, messageID: item.messageID }
  }
  if (!exactKeys(item, ["type", "requestID", "status"])) return
  return { type: "submission", requestID: item.requestID, status: item.status }
}

export function parseStateMessage(value: unknown): StateMessage | undefined {
  const item = record(value)
  if (!item || item.type !== "state" || !Number.isSafeInteger(item.id) || Number(item.id) <= 0) return
  const state = record(item.state)
  if (!state || !validPhase(state) || typeof state.trusted !== "boolean" || typeof state.workspace !== "boolean") return
  const stateKeys = ["phase", "messages", "commands", "agents", "providers", "models", "selection", "attachments", "reviews", "permissions", "questions", "activities", "turnUsage", "sessionUsage", "workspace", "trusted"]
  const stateKeysWithRollback = [...stateKeys, "rolledBack"]
  if (!(exactKeys(state, stateKeys) || exactKeys(state, [...stateKeys, "error"]) ||
    exactKeys(state, stateKeysWithRollback) || exactKeys(state, [...stateKeysWithRollback, "error"]))) return
  if (!safeArray(state.messages, isMessage) || (state.messages as unknown[]).length > MAX_TRANSCRIPT_MESSAGES) return
  if ((state.messages as ViewState["messages"]).reduce((total, message) => total + message.text.length, 0) > MAX_TRANSCRIPT_TOTAL_CHARS) return
  if (!safeArray(state.commands, isCommand) || (state.commands as unknown[]).length > MAX_COMMANDS) return
  if (!safeArray(state.agents, isAgent)) return
  if (!safeArray(state.providers, isProvider)) return
  if (!safeArray(state.models, isModel)) return
  if (!safeArray(state.attachments, isAttachment) || (state.attachments as unknown[]).length > MAX_ATTACHMENTS) return
  if (!safeArray(state.reviews, isReview) || (state.reviews as unknown[]).length > MAX_REVIEWS) return
  if ((state.reviews as ViewState["reviews"]).reduce((total, review) => total + review.files.length, 0) > MAX_REVIEW_TOTAL_FILES) return
  if (!safeArray(state.permissions, isPermission) || (state.permissions as unknown[]).length > MAX_PERMISSIONS) return
  if (!safeArray(state.questions, isQuestionPrompt) || (state.questions as unknown[]).length > MAX_QUESTION_REQUESTS) return
  if (!safeArray(state.activities, isTurnActivity) || (state.activities as unknown[]).length > MAX_TURN_ACTIVITIES) return
  if ((state.activities as ViewState["activities"]).reduce((total, activity) => total + activity.items.length, 0) > MAX_ACTIVITY_ITEMS) return
  const activityMessages = new Map((state.messages as ViewState["messages"]).map((message) => [message.id, message]))
  if ((state.activities as ViewState["activities"]).some((activity) => {
    const message = activityMessages.get(activity.messageID)
    return message?.role !== "assistant" || message.turnID !== activity.turnID
  })) return
  if ((state.activities as ViewState["activities"]).reduce(
    (total, activity) => total + activity.items.reduce((sum, item) => sum + item.title.length + (item.detail?.length ?? 0), 0),
    0,
  ) > MAX_ACTIVITY_TOTAL_CHARS) return
  if (!safeArray(state.turnUsage, isTurnUsage) || (state.turnUsage as unknown[]).length > MAX_TRANSCRIPT_MESSAGES) return
  if (!isUsageTotals(state.sessionUsage, true)) return
  const messageTurns = new Set((state.messages as ViewState["messages"]).map((message) => message.turnID))
  const usageTurns = (state.turnUsage as ViewState["turnUsage"]).map((usage) => usage.turnID)
  if (usageTurns.some((turnID) => !messageTurns.has(turnID)) || new Set(usageTurns).size !== usageTurns.length) return
  const rolledBack = state.rolledBack ?? { count: 0, truncated: false, messages: [] }
  if (!isRolledBack(rolledBack)) return
  if (!isSelection(state.selection)) return
  if (!optionalString(state, "error")) return
  return { type: "state", id: Number(item.id), state: { ...state, rolledBack } as ViewState }
}

function validRequestID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)
}

function validOpaqueKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isNativeAction(value: unknown): value is NativeAction {
  return typeof value === "string" && NATIVE_ACTIONS.some((action) => action === value)
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
}

function validPhase(value: Record<string, unknown>): value is Record<string, unknown> & { phase: ViewState["phase"] } {
  return ["idle", "starting", "ready", "loading", "stopping", "syncing", "error"].includes(String(value.phase))
}

function isMessage(value: unknown): value is ViewState["messages"][number] {
  const item = record(value)
  const required = ["id", "turnID", "role", "text"]
  const allowed = [...required, "createdAt", "attachments", "response"]
  return !!item && required.every((key) => Object.prototype.hasOwnProperty.call(item, key)) &&
    Object.keys(item).every((key) => allowed.includes(key)) &&
    safeString(item.id) && safeString(item.turnID) &&
    (item.role === "user" || item.role === "assistant") && safeString(item.text, MAX_TRANSCRIPT_MESSAGE_CHARS) &&
    (item.createdAt === undefined || (Number.isSafeInteger(item.createdAt) && Number(item.createdAt) >= 0 && Number(item.createdAt) <= 8_640_000_000_000_000)) &&
    (item.attachments === undefined || safeArray(item.attachments, (label) => safeString(label, 240))) &&
    (item.response === undefined || (item.role === "assistant" && isResponseMetadata(item.response, item.createdAt)))
}

function isRolledBack(value: unknown): value is ViewState["rolledBack"] {
  const item = record(value)
  if (!item || !exactKeys(item, ["count", "truncated", "messages"]) ||
    !Number.isSafeInteger(item.count) || Number(item.count) < 0 || Number(item.count) > MAX_TRANSCRIPT_MESSAGES ||
    typeof item.truncated !== "boolean" || !safeArray(item.messages, isRolledBackMessage) ||
    (item.messages as unknown[]).length > MAX_ROLLED_BACK_MESSAGES) return false
  const messages = item.messages as ViewState["rolledBack"]["messages"]
  if (messages.length > Number(item.count) || item.truncated !== (Number(item.count) > messages.length)) return false
  if (new Set(messages.map((message) => message.key)).size !== messages.length) return false
  return messages.reduce((total, message) => total + message.preview.length, 0) <= MAX_ROLLED_BACK_TOTAL_CHARS
}

function isRolledBackMessage(value: unknown): value is ViewState["rolledBack"]["messages"][number] {
  const item = record(value)
  if (!item || !(exactKeys(item, ["key", "preview"]) || exactKeys(item, ["key", "preview", "createdAt"]))) return false
  return validOpaqueKey(item.key) && safeString(item.preview, MAX_ROLLED_BACK_PREVIEW_CHARS) && item.preview.length > 0 &&
    (item.createdAt === undefined || (Number.isSafeInteger(item.createdAt) && Number(item.createdAt) >= 0 && Number(item.createdAt) <= 8_640_000_000_000_000))
}

function isCommand(value: unknown): value is ViewState["commands"][number] {
  const item = record(value)
  return !!item &&
    (exactKeys(item, ["key", "name", "source"]) || exactKeys(item, ["key", "name", "description", "source"])) &&
    validOpaqueKey(item.key) && safeString(item.name, 128) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(item.name) &&
    (item.description === undefined || safeString(item.description, 500)) &&
    (item.source === "command" || item.source === "mcp" || item.source === "skill")
}

function isAgent(value: unknown): value is ViewState["agents"][number] {
  const item = record(value)
  return !!item && exactKeys(item, ["id", "name"]) && safeString(item.id) && safeString(item.name, 120)
}

function isProvider(value: unknown): value is ViewState["providers"][number] {
  const item = record(value)
  return !!item && exactKeys(item, ["id", "name"]) && safeString(item.id) && safeString(item.name, 120)
}

function isProviderConnectionOption(value: unknown): value is Extract<ProviderConnectMessage, { status: "providers" }>["providers"][number] {
  const item = record(value)
  return !!item &&
    (exactKeys(item, ["key", "name", "connected", "category"]) ||
      exactKeys(item, ["key", "name", "connected", "category", "description"])) &&
    validOpaqueKey(item.key) && safeString(item.name, 120) && typeof item.connected === "boolean" &&
    (item.category === "Popular" || item.category === "Providers") &&
    (item.description === undefined || safeString(item.description, 160))
}

function isProviderMethodOption(value: unknown): value is Extract<ProviderConnectMessage, { status: "methods" }>["methods"][number] {
  const item = record(value)
  return !!item && exactKeys(item, ["key", "label", "type"]) && validOpaqueKey(item.key) &&
    safeString(item.label, 120) && (item.type === "api" || item.type === "oauth")
}

function isModel(value: unknown): value is ViewState["models"][number] {
  const item = record(value)
  const required = ["providerID", "id", "name", "variants", "audio", "image", "video", "pdf"]
  return !!item && (exactKeys(item, required) || exactKeys(item, [...required, "contextLimit"])) &&
    safeString(item.providerID) && safeString(item.id) && safeString(item.name, 160) &&
    safeArray(item.variants, (variant) => safeString(variant, 128)) && (item.variants as unknown[]).length <= 100 &&
    typeof item.audio === "boolean" && typeof item.image === "boolean" &&
    typeof item.video === "boolean" && typeof item.pdf === "boolean" &&
    (item.contextLimit === undefined || (Number.isSafeInteger(item.contextLimit) && Number(item.contextLimit) > 0))
}

function isAttachment(value: unknown): value is AttachmentChip {
  const item = record(value)
  if (!item ||
    !(exactKeys(item, ["id", "kind", "label"]) || exactKeys(item, ["id", "kind", "label", "range"])) ||
    !validOpaqueKey(item.id) || (item.kind !== "file" && item.kind !== "selection" && item.kind !== "image") ||
    !safeString(item.label, 240)) return false
  if (item.kind === "image") return item.range === undefined
  if (item.range === undefined) return true
  const range = record(item.range)
  return !!range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
    Number(range.start) > 0 && Number(range.end) >= Number(range.start)
}

function isHistorySession(value: unknown): value is HistorySession {
  const item = record(value)
  return !!item &&
    (exactKeys(item, ["key", "title", "updated", "current"]) || exactKeys(item, ["key", "title", "updated", "current", "status"])) &&
    validOpaqueKey(item.key) && safeString(item.title, 200) && typeof item.updated === "number" &&
    Number.isFinite(item.updated) && typeof item.current === "boolean" &&
    (!("status" in item) || item.status === undefined || item.status === "idle" || item.status === "busy" || item.status === "retry")
}

function isReview(value: unknown): value is ViewState["reviews"][number] {
  const item = record(value)
  return !!item && exactKeys(item, ["key", "turnID", "attribution", "files"]) && validOpaqueKey(item.key) && safeString(item.turnID) &&
    ["direct", "observed", "mixed"].includes(String(item.attribution)) &&
    safeArray(item.files, isReviewFile) && (item.files as unknown[]).length > 0 &&
    (item.files as unknown[]).length <= MAX_REVIEW_FILES
}

function isReviewFile(value: unknown): value is ViewState["reviews"][number]["files"][number] {
  const item = record(value)
  return !!item && ["key", "path", "provenance", "reviewable", "conflicted", "overlapsDirect"].every((key) => key in item) &&
    Object.keys(item).every((key) => ["key", "path", "previousPath", "additions", "deletions", "provenance", "reviewable", "conflicted", "overlapsDirect"].includes(key)) &&
    validOpaqueKey(item.key) && safeString(item.path, 512) &&
    (item.previousPath === undefined || safeString(item.previousPath, 512)) &&
    optionalCount(item, "additions") && optionalCount(item, "deletions") &&
    ["direct", "snapshot"].includes(String(item.provenance)) && typeof item.reviewable === "boolean" &&
    typeof item.conflicted === "boolean" && typeof item.overlapsDirect === "boolean"
}

function isPermission(value: unknown): value is ViewState["permissions"][number] {
  const item = record(value)
  return !!item && exactKeys(item, ["key", "title", "details", "files"]) && validOpaqueKey(item.key) &&
    safeString(item.title, 160) && safeArray(item.details, (detail) => safeString(detail, 500)) &&
    (item.details as unknown[]).length <= 4 && safeArray(item.files, isPermissionFile) && (item.files as unknown[]).length <= 20
}

function isPermissionFile(value: unknown) {
  const item = record(value)
  return !!item && exactKeys(item, ["key", "path"]) && validOpaqueKey(item.key) && safeString(item.path, 512)
}

function isQuestionPrompt(value: unknown): value is ViewState["questions"][number] {
  const item = record(value)
  return !!item && exactKeys(item, ["key", "questions"]) && validOpaqueKey(item.key) &&
    safeArray(item.questions, isQuestion) && (item.questions as unknown[]).length > 0 &&
    (item.questions as unknown[]).length <= 10
}

function isQuestion(value: unknown): value is ViewState["questions"][number]["questions"][number] {
  const item = record(value)
  return !!item && exactKeys(item, ["key", "header", "question", "multiple", "custom", "options"]) &&
    validOpaqueKey(item.key) && safeString(item.header, 80) && safeString(item.question, 1_000) &&
    typeof item.multiple === "boolean" && typeof item.custom === "boolean" &&
    safeArray(item.options, isQuestionOption) && (item.options as unknown[]).length <= 20
}

function isQuestionOption(value: unknown) {
  const item = record(value)
  return !!item && exactKeys(item, ["key", "label", "description"]) && validOpaqueKey(item.key) &&
    safeString(item.label, 160) && safeString(item.description, 500)
}

function isQuestionAnswer(value: unknown) {
  const item = record(value)
  if (!item || !(exactKeys(item, ["questionKey", "optionKeys"]) || exactKeys(item, ["questionKey", "optionKeys", "custom"]))) return false
  return validOpaqueKey(item.questionKey) && safeArray(item.optionKeys, validOpaqueKey) &&
    (item.optionKeys as unknown[]).length <= 20 &&
    (item.custom === undefined || safeString(item.custom, 2_000))
}

function isTurnActivity(value: unknown): value is ViewState["activities"][number] {
  const item = record(value)
  if (!item || !["key", "turnID", "messageID", "status", "actionCount", "changedFileCount", "truncated", "items"].every((key) => key in item) ||
    !Object.keys(item).every((key) => ["key", "turnID", "messageID", "status", "retry", "startedAt", "endedAt", "actionCount", "changedFileCount", "truncated", "items"].includes(key)) ||
    !validOpaqueKey(item.key) || !safeString(item.turnID) || !safeString(item.messageID) ||
    !["working", "retrying", "completed", "interrupted", "failed"].includes(String(item.status)) ||
    !Number.isSafeInteger(item.actionCount) || Number(item.actionCount) < 0 ||
    !Number.isSafeInteger(item.changedFileCount) || Number(item.changedFileCount) < 0 ||
    typeof item.truncated !== "boolean" || !safeArray(item.items, isActivityItem) ||
    (item.items as unknown[]).length > 100) return false
  if (!optionalFiniteNumber(item, "startedAt") || !optionalFiniteNumber(item, "endedAt")) return false
  if (item.retry === undefined) return item.status !== "retrying"
  const retry = record(item.retry)
  return item.status === "retrying" && !!retry && exactKeys(retry, ["attempt", "nextAt"]) &&
    Number.isSafeInteger(retry.attempt) && Number(retry.attempt) >= 0 && Number(retry.attempt) <= 1_000_000 &&
    typeof retry.nextAt === "number" && Number.isFinite(retry.nextAt) && Number(retry.nextAt) >= 0
}

function isActivityItem(value: unknown): value is ViewState["activities"][number]["items"][number] {
  const item = record(value)
  if (!item || !Object.keys(item).every((key) =>
    ["key", "kind", "status", "title", "detail", "startedAt", "endedAt", "files"].includes(key)
  ) || !validOpaqueKey(item.key) ||
    !["reasoning", "command", "read", "search", "web", "edit", "task", "question", "todo", "tool"].includes(String(item.kind)) ||
    !["waiting", "running", "completed", "failed", "denied"].includes(String(item.status)) ||
    !safeString(item.title, 160) || (item.detail !== undefined && !safeString(item.detail, 32_000)) ||
    !optionalFiniteNumber(item, "startedAt") || !optionalFiniteNumber(item, "endedAt")) return false
  if (item.files === undefined) return true
  return safeArray(item.files, isActivityFile) && (item.files as unknown[]).length <= 20
}

function isActivityFile(value: unknown) {
  const item = record(value)
  return !!item && Object.keys(item).every((key) => ["key", "path", "additions", "deletions"].includes(key)) &&
    validOpaqueKey(item.key) && safeString(item.path, 512) && optionalCount(item, "additions") && optionalCount(item, "deletions")
}

function isResponseMetadata(value: unknown, createdAt: unknown): value is ResponseMetadata {
  const item = record(value)
  const allowed = ["completedAt", "agent", "providerID", "modelID", "variant", "cost", "contextTokens"]
  if (!item || !Object.keys(item).length || !Object.keys(item).every((key) => allowed.includes(key))) return false
  if (item.completedAt !== undefined && (
    !validTimestamp(item.completedAt) || (validTimestamp(createdAt) && Number(item.completedAt) < Number(createdAt))
  )) return false
  if (!optionalSafeMetadata(item, "agent", 120) || !optionalSafeMetadata(item, "providerID", 512) ||
    !optionalSafeMetadata(item, "modelID", 512) || !optionalSafeMetadata(item, "variant", 128)) return false
  if (item.cost !== undefined && !safeUsageCost(item.cost)) return false
  return item.contextTokens === undefined || isUsageTokens(item.contextTokens)
}

function isTurnUsage(value: unknown): value is TurnUsage {
  const item = record(value)
  if (!item || !safeMetadataString(item.turnID, 512)) return false
  const keys = Object.keys(item)
  if (!keys.every((key) => key === "turnID" || key === "cost" || key === "tokens")) return false
  return keys.some((key) => key === "cost" || key === "tokens") && isUsageTotals(item, false, true)
}

function isUsageTotals(value: unknown, allowEmpty: boolean, allowTurnID = false): value is UsageTotals {
  const item = record(value)
  if (!item) return false
  const keys = Object.keys(item).filter((key) => !allowTurnID || key !== "turnID")
  if (!keys.every((key) => key === "cost" || key === "tokens") || (!allowEmpty && !keys.length)) return false
  if ("cost" in item && !safeUsageCost(item.cost)) return false
  return !("tokens" in item) || isUsageTokens(item.tokens)
}

function isUsageTokens(value: unknown): value is UsageTokens {
  const item = record(value)
  if (!item || !exactKeys(item, ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"])) return false
  const values = [item.input, item.output, item.reasoning, item.cacheRead, item.cacheWrite]
  if (!values.every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)) return false
  const total = values.map(Number).reduce((sum, entry) => sum + entry, 0)
  return Number.isSafeInteger(total) && item.total === total
}

function safeUsageCost(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
}

function validTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000
}

function optionalSafeMetadata(value: Record<string, unknown>, key: string, maximum: number) {
  return !(key in value) || value[key] === undefined || safeMetadataString(value[key], maximum)
}

function safeMetadataString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function optionalCount(value: Record<string, unknown>, key: string) {
  return !(key in value) || value[key] === undefined ||
    (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 10_000_000)
}

function optionalFiniteNumber(value: Record<string, unknown>, key: string) {
  return !(key in value) || value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]))
}

function isSelection(value: unknown) {
  const item = record(value)
  if (!item || !Object.keys(item).every((key) => key === "agent" || key === "model" || key === "variant")) return false
  if (!optionalString(item, "agent") || !optionalString(item, "variant")) return false
  if (!("model" in item) || item.model === undefined) return true
  const selected = record(item.model)
  return !!selected && safeString(selected.providerID) && safeString(selected.modelID)
}

function safeArray(value: unknown, predicate: (item: unknown) => boolean) {
  return Array.isArray(value) && value.length <= 10_000 && value.every(predicate)
}

function safeString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length <= maximum
}

function optionalString(value: Record<string, unknown>, key: string) {
  return !(key in value) || value[key] === undefined || safeString(value[key], 10_000)
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
