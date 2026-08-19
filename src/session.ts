import { randomBytes } from "node:crypto"
import type { PromptFilePart } from "./attachments"
import { startServer, type OwnedServer } from "./server"
import {
  acceptsSelection,
  projectCatalog,
  resolveSelection,
  supportsFileInput,
  supportsImageInput,
  type AgentOption,
  type Catalog,
  type ModelOption,
  type ModelSelection,
  type ProviderOption,
  type Selection,
} from "./catalog"
import {
  MAX_TRANSCRIPT_DELTA_CHARS,
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  SubmissionTracker,
  type HistorySession,
  type SubmissionEvent,
} from "./protocol"
import { SessionHistory, parseSession, proposedSessionTitle, sameSessionVersion, type SessionInfo } from "./session-history"
import { Transcript, type TranscriptMessage, type TurnActivity } from "./transcript"
import { MAX_REVIEW_FILES, reviewDocument, type FileDiff, type ReviewSummary } from "./review"
import { PermissionStore, type PermissionPrompt, type PermissionRequest } from "./permissions"
import { QuestionStore, type QuestionAnswer, type QuestionPrompt, type QuestionRequest } from "./questions"
import { CommandStore, type CommandSummary } from "./commands"
import {
  providerAuthorization,
  providerConnections,
  providerInputs,
  type ProviderAuthorization,
  type ProviderConnection,
  type ProviderMethod,
} from "./provider-connection"
import { mcpSummaries, systemStatusItems, type McpSummary, type SystemStatusItem } from "./system-status"
import type { TurnUsage, UsageTotals } from "./usage"

type Sdk = typeof import("@opencode-ai/sdk/v2/client", { with: { "resolution-mode": "import" } })
type GlobalEvent = import("@opencode-ai/sdk/v2/client", { with: { "resolution-mode": "import" } }).GlobalEvent
type Message = import("@opencode-ai/sdk/v2/client", { with: { "resolution-mode": "import" } }).Message
type Part = import("@opencode-ai/sdk/v2/client", { with: { "resolution-mode": "import" } }).Part
export type ConsoleOrganization = {
  accountID: string
  orgID: string
  name: string
  email: string
  active: boolean
}

export type SessionState = {
  phase: "idle" | "starting" | "ready" | "loading" | "stopping" | "syncing" | "error"
  messages: TranscriptMessage[]
  commands: CommandSummary[]
  reviews: ReviewSummary[]
  permissions: PermissionPrompt[]
  questions: QuestionPrompt[]
  activities: TurnActivity[]
  turnUsage: TurnUsage[]
  sessionUsage: UsageTotals
  agents: AgentOption[]
  providers: ProviderOption[]
  models: ModelOption[]
  selection: Selection
  error?: string
}

type Client = ReturnType<Sdk["createOpencodeClient"]>
type Attempt = {
  directory: string
  abort: AbortController
  connected: boolean
  server?: OwnedServer
  client?: Client
  sessionID?: string
  events?: Promise<void>
  eventAbort?: AbortController
  cleanup?: Promise<void>
  catalog?: Catalog
  history?: SessionHistory
  pendingEvents?: { sessionID: string; generation: number; events: GlobalEvent[]; overflow: boolean }
  reconciling?: Promise<void>
  reconcileRequested?: boolean
  reconciliationError?: string
  reviewMessageID?: string
  revertMessageID?: string
  sessionUsage?: UsageTotals
}

const REVIEW_DIFF_ATTEMPTS = 4
const REVIEW_DIFF_RETRY_MS = 50
const MAX_QUEUED_MESSAGE_EVENT_CHARS = 64_000

type HydratedSession = {
  session: SessionInfo
  transcript: Transcript
}

export class SessionController {
  private state: SessionState = {
    phase: "idle",
    messages: [],
    commands: [],
    reviews: [],
    permissions: [],
    questions: [],
    activities: [],
    turnUsage: [],
    sessionUsage: {},
    agents: [],
    providers: [],
    models: [],
    selection: {},
  }
  private transcript = new Transcript()
  private permissions = new PermissionStore()
  private questions = new QuestionStore()
  private commands = new CommandStore()
  private listeners = new Set<(state: SessionState) => void>()
  private submissionListeners = new Set<(event: SubmissionEvent) => void>()
  private submissionTracker: SubmissionTracker
  private attempt?: Attempt
  private starting?: Promise<void>
  private submitting?: Promise<boolean>
  private disposing?: Promise<void>
  private transitioning?: Promise<boolean>
  private renderTimer?: ReturnType<typeof setTimeout>
  private promptBusy = false
  private mutationBusy = false
  private permissionReplyBusy = false
  private questionReplyBusy = false
  private reviewEpoch = 0
  private generation = 0
  private disposed = false

  constructor(private timing: (message: string) => void = () => {}) {
    this.submissionTracker = new SubmissionTracker((event) => {
      this.submissionListeners.forEach((listener) => listener(event))
    })
  }

  subscribe(listener: (state: SessionState) => void) {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  subscribeSubmissions(listener: (event: SubmissionEvent) => void) {
    this.submissionListeners.add(listener)
    return () => this.submissionListeners.delete(listener)
  }

  snapshot() {
    return this.state
  }

  boundDirectory() {
    return this.attempt?.directory
  }

  supportsImageInput() {
    return !!this.attempt?.catalog && supportsImageInput(this.attempt.catalog, this.state.selection)
  }

  supportsFileInput(mime: string) {
    return !!this.attempt?.catalog && supportsFileInput(this.attempt.catalog, this.state.selection, mime)
  }

  reportError(message: string) {
    this.update({ error: message })
  }

  async review(reviewKey: string, fileKey: string) {
    const permissionDocument = this.permissions.resolveReview(reviewKey, fileKey)
    if (permissionDocument) return permissionDocument
    if (this.mutationBusy) throw new Error("Wait for the current chat change before opening its file review.")
    const attempt = this.attempt
    const sessionID = attempt?.sessionID
    const target = this.transcript.resolveReview(reviewKey, fileKey)
    if (!attempt?.client || !sessionID || !target) throw new Error("That file review is no longer available.")
    const generation = this.generation
    const reviewEpoch = this.reviewEpoch
    const response = await attempt.client.session.diff(
      { sessionID, directory: attempt.directory, messageID: target.messageID },
      { signal: attempt.abort.signal },
    )
    if (
      this.attempt !== attempt ||
      attempt.abort.signal.aborted ||
      attempt.sessionID !== sessionID ||
      this.generation !== generation ||
      this.reviewEpoch !== reviewEpoch ||
      this.transcript.resolveReview(reviewKey, fileKey)?.path !== target.path
    ) throw new Error("That file review changed before it could be opened.")
    const matches = (response.data ?? []).slice(0, MAX_REVIEW_FILES).filter((diff) => normalizedDiffPath(diff.file) === target.path)
    if (matches.length !== 1) throw new Error("OpenCode could not provide that file revision.")
    const document = reviewDocument(matches[0]!, target.path)
    if (!document) throw new Error("OpenCode could not provide a safe text diff for that file.")
    return document
  }

  async replyPermission(key: string, decision: "allow" | "deny") {
    if (this.permissionReplyBusy) return false
    const attempt = this.attempt
    const sessionID = attempt?.sessionID
    const target = this.permissions.resolve(key)
    if (!attempt?.client || !sessionID || !target || target.sessionID !== sessionID) return false
    const generation = this.generation
    this.permissionReplyBusy = true
    try {
      const pending = await attempt.client.permission.list(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      const request = (pending.data ?? []).find((item) => item.id === target.requestID && item.sessionID === sessionID)
      if (
        !request ||
        !this.permissions.matches(key, request) ||
        this.attempt !== attempt ||
        attempt.sessionID !== sessionID ||
        this.generation !== generation
      ) throw new Error("stale")
      const response = await attempt.client.permission.reply(
        { requestID: request.id, directory: attempt.directory, reply: decision === "allow" ? "once" : "reject" },
        { signal: attempt.abort.signal },
      )
      if (
        response.data !== true ||
        this.attempt !== attempt ||
        attempt.sessionID !== sessionID ||
        this.generation !== generation
      ) throw new Error("stale")
      if (decision === "deny") this.permissions.clear()
      else this.permissions.remove(request.id)
      this.flushRender()
      return true
    } catch {
      if (this.attempt === attempt && attempt.sessionID === sessionID && this.generation === generation) {
        this.update({ error: "That permission request is no longer available." })
      }
      return false
    } finally {
      this.permissionReplyBusy = false
    }
  }

  async replyQuestion(key: string, answers?: QuestionAnswer[]) {
    if (this.questionReplyBusy) return false
    const attempt = this.attempt
    const sessionID = attempt?.sessionID
    const target = this.questions.resolve(key)
    if (!attempt?.client || !sessionID || !target || target.sessionID !== sessionID) return false
    const generation = this.generation
    this.questionReplyBusy = true
    try {
      const pending = await attempt.client.question.list(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      const request = (pending.data ?? []).find((item) => item.id === target.requestID && item.sessionID === sessionID)
      if (
        !request ||
        !this.questions.matches(key, request) ||
        this.attempt !== attempt ||
        attempt.sessionID !== sessionID ||
        this.generation !== generation
      ) throw new Error("stale")
      const resolved = answers ? this.questions.answers(key, request, answers) : undefined
      if (answers && !resolved) throw new Error("invalid")
      const response = answers ? await attempt.client.question.reply(
        { requestID: request.id, directory: attempt.directory, answers: resolved },
        { signal: attempt.abort.signal },
      ) : await attempt.client.question.reject(
        { requestID: request.id, directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      if (
        response.data !== true ||
        this.attempt !== attempt ||
        attempt.sessionID !== sessionID ||
        this.generation !== generation
      ) throw new Error("stale")
      this.questions.remove(request.id)
      this.flushRender()
      return true
    } catch {
      if (this.attempt === attempt && attempt.sessionID === sessionID && this.generation === generation) {
        this.update({ error: "That question is no longer available." })
      }
      return false
    } finally {
      this.questionReplyBusy = false
    }
  }

  prepare(directory: string) {
    return this.ensureStarted(directory).then(() => undefined).catch((error) => {
      this.update({ phase: "error", error: safeError(error) })
    })
  }

  selectAgent(id: string) {
    const catalog = this.attempt?.catalog
    if (!catalog || !catalog.agents.some((agent) => agent.id === id)) return false
    if (this.promptBusy || this.transitioning || this.mutationBusy) return true
    this.setSelection(resolveSelection(catalog, { agent: id }))
    return true
  }

  selectModel(model: ModelSelection) {
    const catalog = this.attempt?.catalog
    if (!catalog || !catalog.models.some((item) => item.providerID === model.providerID && item.id === model.modelID)) {
      return false
    }
    if (this.promptBusy || this.transitioning || this.mutationBusy) return true
    const selection = resolveSelection(catalog, { ...this.state.selection, model, variant: undefined })
    this.setSelection(selection)
    return true
  }

  selectVariant(variant?: string) {
    const catalog = this.attempt?.catalog
    if (!catalog) return false
    const selection = { ...this.state.selection, variant }
    if (!acceptsSelection(catalog, selection)) return false
    if (this.promptBusy || this.transitioning || this.mutationBusy) return true
    this.setSelection(selection)
    return true
  }

  async listProviderConnections(directory: string): Promise<ProviderConnection[]> {
    const attempt = await this.ensureStarted(directory)
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    return this.providerConnectionList(attempt, this.generation)
  }

  refreshProviderConnections(directory: string): Promise<ProviderConnection[] | undefined> {
    return this.mutate(async () => {
      const attempt = await this.ensureStarted(directory)
      if (!attempt.client) throw new Error("OpenCode session is unavailable.")
      const generation = this.generation
      if (!(await this.reloadProviderCatalog(attempt, generation))) {
        throw new Error("OpenCode provider state changed while refreshing.")
      }
      return this.providerConnectionList(attempt, generation)
    }, "Wait for the current OpenCode response to finish before connecting a provider.")
      .then((result) => result || undefined)
  }

  private async providerConnectionList(attempt: Attempt, generation: number) {
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const [providers, methods] = await Promise.all([
      attempt.client.provider.list({ directory: attempt.directory }, { signal: attempt.abort.signal }),
      attempt.client.provider.auth({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
    if (this.attempt !== attempt || attempt.abort.signal.aborted || this.generation !== generation) {
      throw new Error("OpenCode provider state changed.")
    }
    return providerConnections(providers.data, methods.data)
  }

  async listMcpConnections(directory: string): Promise<McpSummary[]> {
    const attempt = await this.ensureStarted(directory)
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const generation = this.generation
    const response = await attempt.client.mcp.status(
      { directory: attempt.directory },
      { signal: attempt.abort.signal },
    )
    if (!this.currentAttempt(attempt, generation)) throw new Error("OpenCode MCP state changed.")
    return mcpSummaries(response.data)
  }

  toggleMcp(directory: string, name: string): Promise<McpSummary | undefined> {
    return this.mutate(async () => {
      const attempt = await this.ensureStarted(directory)
      if (!attempt.client) return false
      const generation = this.generation
      const before = await attempt.client.mcp.status(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      const target = mcpSummaries(before.data).find((item) => item.name === name)
      if (!target || !this.currentAttempt(attempt, generation)) return false
      const response = target.status === "connected"
        ? await attempt.client.mcp.disconnect(
            { name: target.name, directory: attempt.directory },
            { signal: attempt.abort.signal },
          )
        : await attempt.client.mcp.connect(
            { name: target.name, directory: attempt.directory },
            { signal: attempt.abort.signal },
          )
      if (response.data !== true || !this.currentAttempt(attempt, generation)) return false
      const after = await attempt.client.mcp.status(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      if (!this.currentAttempt(attempt, generation)) return false
      return mcpSummaries(after.data).find((item) => item.name === target.name) ?? false
    }).then((result) => result || undefined)
  }

  async listSystemStatus(directory: string): Promise<SystemStatusItem[]> {
    const attempt = await this.ensureStarted(directory)
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const generation = this.generation
    const [mcp, lsp, formatter] = await Promise.all([
      attempt.client.mcp.status({ directory: attempt.directory }, { signal: attempt.abort.signal }),
      attempt.client.lsp.status({ directory: attempt.directory }, { signal: attempt.abort.signal }),
      attempt.client.formatter.status({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
    if (!this.currentAttempt(attempt, generation)) throw new Error("OpenCode system status changed.")
    return systemStatusItems(mcp.data, lsp.data, formatter.data)
  }

  async listConsoleOrganizations(directory: string): Promise<ConsoleOrganization[]> {
    const attempt = await this.ensureStarted(directory)
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const generation = this.generation
    const response = await attempt.client.experimental.console.listOrgs(
      { directory: attempt.directory },
      { signal: attempt.abort.signal },
    )
    if (!this.currentAttempt(attempt, generation)) throw new Error("OpenCode Console organization state changed.")
    return projectConsoleOrganizations(response.data)
  }

  switchConsoleOrganization(directory: string, accountID: string, orgID: string) {
    return this.mutate(async () => {
      const attempt = await this.ensureStarted(directory)
      if (!attempt.client) return false
      const generation = this.generation
      const fresh = await attempt.client.experimental.console.listOrgs(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      const target = projectConsoleOrganizations(fresh.data).find((org) =>
        org.accountID === accountID && org.orgID === orgID
      )
      if (!target || !this.currentAttempt(attempt, generation)) return false
      if (target.active) return true
      const response = await attempt.client.experimental.console.switchOrg(
        { directory: attempt.directory, accountID: target.accountID, orgID: target.orgID },
        { signal: attempt.abort.signal },
      )
      if (response.data !== true || !this.currentAttempt(attempt, generation)) return false
      return this.reloadProviderCatalog(attempt, generation)
    }, "Wait for the current OpenCode response before switching organizations.")
  }

  connectProviderKey(
    directory: string,
    providerID: string,
    methodIndex: number,
    values: Record<string, string>,
    key: string,
  ) {
    return this.mutate(async () => {
      const attempt = await this.ensureStarted(directory)
      if (!attempt.client || !boundedSecret(key)) return false
      const generation = this.generation
      const method = await this.providerMethod(attempt, providerID, methodIndex)
      const metadata = method?.type === "api" ? providerInputs(method, values) : undefined
      if (!method || method.type !== "api" || !metadata || !this.currentAttempt(attempt, generation)) return false
      const response = await attempt.client.auth.set(
        { providerID, auth: { type: "api", key, ...(Object.keys(metadata).length ? { metadata } : {}) } },
        { signal: attempt.abort.signal },
      )
      if (response.data !== true || !this.currentAttempt(attempt, generation)) return false
      return this.reloadProviderCatalog(attempt, generation)
    })
  }

  authorizeProvider(
    directory: string,
    providerID: string,
    methodIndex: number,
    values: Record<string, string>,
  ): Promise<ProviderAuthorization | undefined> {
    return this.mutate(async () => {
      const attempt = await this.ensureStarted(directory)
      if (!attempt.client) return false
      const generation = this.generation
      const method = await this.providerMethod(attempt, providerID, methodIndex)
      const inputs = method?.type === "oauth" ? providerInputs(method, values) : undefined
      if (!method || method.type !== "oauth" || !inputs || !this.currentAttempt(attempt, generation)) return false
      const response = await attempt.client.provider.oauth.authorize(
        { providerID, directory: attempt.directory, method: methodIndex, ...(Object.keys(inputs).length ? { inputs } : {}) },
        { signal: attempt.abort.signal },
      )
      if (!this.currentAttempt(attempt, generation)) return false
      return providerAuthorization(response.data) ?? false
    }).then((result) => result || undefined)
  }

  completeProviderOAuth(directory: string, providerID: string, methodIndex: number, code?: string) {
    return this.mutate(async () => {
      const attempt = await this.ensureStarted(directory)
      if (!attempt.client || (code !== undefined && !boundedSecret(code))) return false
      const generation = this.generation
      const method = await this.providerMethod(attempt, providerID, methodIndex)
      if (!method || method.type !== "oauth" || !this.currentAttempt(attempt, generation)) return false
      const response = await attempt.client.provider.oauth.callback(
        { providerID, directory: attempt.directory, method: methodIndex, ...(code !== undefined ? { code } : {}) },
        { signal: attempt.abort.signal },
      )
      if (!response.data || !this.currentAttempt(attempt, generation)) return false
      return this.reloadProviderCatalog(attempt, generation)
    })
  }

  renameCurrentSession(value: string) {
    const title = proposedSessionTitle(value)
    if (!title) {
      this.update({ error: "Chat titles must be 1–120 characters and cannot contain control characters." })
      return Promise.resolve(false)
    }
    return this.mutate(async () => {
      const attempt = this.attempt
      const sessionID = attempt?.sessionID
      if (!attempt?.client || !sessionID) return false
      const generation = this.generation
      const [current, statuses] = await Promise.all([
        attempt.client.session.get({ sessionID, directory: attempt.directory }, { signal: attempt.abort.signal }),
        attempt.client.session.status({ directory: attempt.directory }, { signal: attempt.abort.signal }),
      ])
      const session = parseSession(current.data)
      if (!session || session.id !== sessionID || session.directory !== attempt.directory ||
        sessionIsActive(statuses.data, sessionID) || !this.currentAttempt(attempt, generation)) return false
      const response = await attempt.client.session.update(
        { sessionID, directory: attempt.directory, title },
        { signal: attempt.abort.signal },
      )
      const updated = parseSession(response.data)
      if (!updated || updated.id !== sessionID || updated.title !== title || !this.currentAttempt(attempt, generation)) return false
      this.update({ error: undefined })
      return true
    })
  }

  async compact() {
    if (this.mutationBusy || this.promptBusy || this.submitting || this.transitioning) return false
    const attempt = this.attempt
    const sessionID = attempt?.sessionID
    const selection = this.state.selection
    if (!attempt?.client || !sessionID || !selection.model || !attempt.catalog ||
      !acceptsSelection(attempt.catalog, selection)) return false
    const generation = this.generation
    this.mutationBusy = true
    this.promptBusy = true
    this.update({ phase: "loading", error: undefined })
    try {
      const response = await attempt.client.session.summarize(
        {
          sessionID,
          directory: attempt.directory,
          providerID: selection.model.providerID,
          modelID: selection.model.modelID,
        },
        { signal: attempt.abort.signal },
      )
      if (response.data !== true || !this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) {
        throw new Error("stale")
      }
      return true
    } catch {
      if (this.currentAttempt(attempt, generation)) {
        this.promptBusy = false
        this.update({ phase: "ready", error: "OpenCode could not compact this chat." })
      }
      return false
    } finally {
      this.mutationBusy = false
    }
  }

  shareCurrentSession(): Promise<string | undefined> {
    return this.mutate(async () => {
      const attempt = this.attempt
      const sessionID = attempt?.sessionID
      if (!attempt?.client || !sessionID) return false
      const generation = this.generation
      const response = await attempt.client.session.share(
        { sessionID, directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      if (!this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) return false
      const updated = matchingSessionResponse(response.data, sessionID, attempt.directory)
      return projectedShareURL(updated) ?? false
    }, "Wait for the current OpenCode response before sharing this chat.").then((result) => result || undefined)
  }

  unshareCurrentSession() {
    return this.mutate(async () => {
      const attempt = this.attempt
      const sessionID = attempt?.sessionID
      if (!attempt?.client || !sessionID) return false
      const generation = this.generation
      const response = await attempt.client.session.unshare(
        { sessionID, directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      if (!this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) return false
      const updated = matchingSessionResponse(response.data, sessionID, attempt.directory)
      if (!updated) return false
      return !Object.prototype.hasOwnProperty.call(updated, "share") || updated.share === undefined
    }, "Wait for the current OpenCode response before removing this chat's share link.")
  }

  forkCurrentSession(messageID?: string) {
    return this.mutate(async () => {
      const attempt = this.attempt
      const sessionID = attempt?.sessionID
      if (!attempt?.client || !attempt.catalog || !sessionID) return false
      if (messageID && !this.transcript.snapshot().some((message) => message.id === messageID)) return false
      const generation = this.generation
      const response = await attempt.client.session.fork(
        { sessionID, directory: attempt.directory, ...(messageID ? { messageID } : {}) },
        { signal: attempt.abort.signal },
      )
      const target = parseSession(response.data)
      if (!target || target.id === sessionID || target.directory !== attempt.directory ||
        !this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) return false
      const hydrated = await this.loadStableSession(attempt, target.id)
      if (!this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID || hydrated.session.id !== target.id) {
        return false
      }
      this.generation++
      attempt.sessionID = target.id
      attempt.reviewMessageID = undefined
      this.submissionTracker.clear()
      this.reviewEpoch++
      this.transcript = hydrated.transcript
      attempt.revertMessageID = hydrated.session.revert?.messageID
      attempt.sessionUsage = hydrated.session.usage
      this.permissions.clear()
      this.questions.clear()
      this.state = {
        ...this.state,
        selection: resolveSelection(attempt.catalog, selectionForSession(hydrated.session, this.state.selection)),
      }
      this.flushRender()
      this.update({ phase: "ready", error: undefined })
      return true
    }, "Wait for the current OpenCode response before forking this chat.")
  }

  undoCurrentSession() {
    return this.mutate(async () => {
      const attempt = this.attempt
      const sessionID = attempt?.sessionID
      const messageID = this.transcript.latestUserID()
      if (!attempt?.client || !sessionID || !messageID) return false
      const generation = this.generation
      const response = await attempt.client.session.revert(
        { sessionID, directory: attempt.directory, messageID },
        { signal: attempt.abort.signal },
      )
      const reverted = parseSession(response.data)
      if (!reverted?.revert || reverted.id !== sessionID ||
        !this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) return false
      return this.reloadAfterHistoryMutation(attempt, sessionID, generation)
    }, "Wait for the current OpenCode response before undoing a turn.")
  }

  hasUndoneTurns() {
    return this.attempt?.revertMessageID !== undefined
  }

  redoCurrentSession() {
    return this.mutate(async () => {
      const attempt = this.attempt
      const sessionID = attempt?.sessionID
      if (!attempt?.client || !sessionID) return false
      const generation = this.generation
      const current = await attempt.client.session.get(
        { sessionID, directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      const revert = parseSession(current.data)?.revert
      if (!revert ||
        !this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) return false
      const messages = await attempt.client.session.messages(
        { sessionID, directory: attempt.directory, limit: MAX_TRANSCRIPT_MESSAGES },
        { signal: attempt.abort.signal },
      )
      if (!this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) return false
      const all = messages.data ?? []
      const revertedAt = all.findIndex((message) => message.info.id === revert.messageID)
      if (revertedAt < 0) return false
      const next = all.slice(revertedAt + 1).find((message) => message.info.role === "user")
      const response = next
        ? await attempt.client.session.revert(
            { sessionID, directory: attempt.directory, messageID: next.info.id },
            { signal: attempt.abort.signal },
          )
        : await attempt.client.session.unrevert(
            { sessionID, directory: attempt.directory },
            { signal: attempt.abort.signal },
          )
      const restored = parseSession(response.data)
      if (!restored || (next ? restored.revert?.messageID !== next.info.id : !!restored.revert) || restored.id !== sessionID ||
        !this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID) return false
      return this.reloadAfterHistoryMutation(attempt, sessionID, generation)
    }, "Wait for the current OpenCode response before restoring an undone turn.")
  }

  newChat() {
    if (this.promptBusy || this.mutationBusy) return false
    const attempt = this.attempt
    if (attempt) {
      attempt.sessionID = undefined
      attempt.revertMessageID = undefined
      attempt.sessionUsage = undefined
      attempt.reconciliationError = undefined
      attempt.reviewMessageID = undefined
    }
    this.generation++
    this.submissionTracker.clear()
    this.transcript = new Transcript(attempt?.directory)
    this.flushRender()
    this.update({ phase: attempt?.client ? "ready" : "idle", error: undefined })
    return true
  }

  async listHistory(directory: string): Promise<HistorySession[]> {
    const attempt = await this.ensureStarted(directory)
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    attempt.history ??= new SessionHistory(attempt.directory)
    const [sessions, statuses] = await Promise.all([
      attempt.client.session.list(
        { directory: attempt.directory, roots: true, limit: 200 },
        { signal: attempt.abort.signal },
      ),
      attempt.client.session.status({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
    return attempt.history.replace(sessions.data, statuses.data, attempt.sessionID)
  }

  sessionTitle(key: string) {
    return this.attempt?.history?.displayTitle(key)
  }

  renameSession(key: string, value: string) {
    const title = proposedSessionTitle(value)
    if (!title) {
      this.update({ error: "Chat titles must be 1–120 characters and cannot contain control characters." })
      return Promise.resolve(false)
    }
    return this.mutate(async () => {
      const target = await this.mutableSession(key)
      if (!target) return false
      const attempt = this.attempt!
      try {
        const updated = await attempt.client!.session.update(
          { sessionID: target.id, directory: attempt.directory, title },
          { signal: attempt.abort.signal },
        )
        const session = parseSession(updated.data)
        if (!session || !attempt.history!.accepts(session) || session.title !== title) {
          throw new Error("OpenCode did not confirm the renamed chat.")
        }
        this.update({ error: undefined })
        return true
      } catch {
        this.update({ error: "OpenCode could not rename that chat. Its previous title was kept." })
        return false
      }
    })
  }

  deleteSession(key: string) {
    return this.mutate(async () => {
      const target = await this.mutableSession(key)
      if (!target) return false
      const attempt = this.attempt!
      const current = attempt.sessionID === target.id
      try {
        const deleted = await attempt.client!.session.delete(
          { sessionID: target.id, directory: attempt.directory },
          { signal: attempt.abort.signal },
        )
        if (deleted.data !== true) throw new Error("OpenCode did not confirm the deleted chat.")
        if (current) this.resetToNewChat(attempt)
        this.update({ error: undefined })
        return true
      } catch {
        this.update({ error: "OpenCode could not delete that chat. No local history was changed." })
        return false
      }
    })
  }

  switchSession(key: string) {
    if (this.promptBusy || this.submitting || this.mutationBusy) {
      this.update({ error: "Wait for the current OpenCode response before switching chats." })
      return Promise.resolve(false)
    }
    const attempt = this.attempt
    const target = attempt?.history?.resolve(key)
    if (!attempt?.client || !target) {
      this.update({ error: "That OpenCode chat is no longer available." })
      return Promise.resolve(false)
    }
    const generation = ++this.generation
    const previousPhase = this.state.phase
    this.update({ phase: "syncing", error: undefined })
    const transitioning = this.loadStableSession(attempt, target.id)
      .then((hydrated) => {
        if (
          this.attempt !== attempt ||
          attempt.abort.signal.aborted ||
          this.generation !== generation ||
          attempt.pendingEvents?.generation !== generation ||
          attempt.pendingEvents?.overflow ||
          sessionInvalidated(attempt.pendingEvents?.events ?? [], target.id)
        ) throw new Error("OpenCode session changed while it was loading.")
        replayEvents(hydrated.transcript, attempt.pendingEvents?.events ?? [], target.id)
        const selection = resolveSelection(attempt.catalog!, selectionForSession(hydrated.session, this.state.selection))
        attempt.sessionID = target.id
        attempt.revertMessageID = hydrated.session.revert?.messageID
        attempt.sessionUsage = sessionUsageAfterEvents(
          attempt.pendingEvents?.events ?? [], target.id, hydrated.session.usage,
        )
        attempt.reviewMessageID = undefined
        this.submissionTracker.clear()
        this.reviewEpoch++
        this.transcript = hydrated.transcript
        this.permissions.clear()
        this.questions.clear()
        this.state = { ...this.state, selection }
        this.flushRender()
        this.update({ phase: "ready", error: undefined })
        return true
      })
      .catch((error) => {
        if (this.attempt === attempt && !attempt.abort.signal.aborted && this.generation === generation) {
          this.update({ phase: previousPhase, error: safeTransitionError(error) })
        }
        return false
      })
      .finally(() => {
        if (attempt.pendingEvents?.sessionID === target.id && attempt.pendingEvents.generation === generation) {
          attempt.pendingEvents = undefined
        }
        if (this.transitioning === transitioning) this.transitioning = undefined
      })
    attempt.pendingEvents = { sessionID: target.id, generation, events: [], overflow: false }
    this.transitioning = transitioning
    return transitioning
  }

  refresh() {
    if (this.transitioning) {
      this.update({ error: "Wait for the current OpenCode chat change before refreshing." })
      return Promise.resolve(false)
    }
    const attempt = this.attempt
    if (!attempt?.client || !attempt.sessionID) return Promise.resolve(true)
    if (this.promptBusy || this.submitting || this.mutationBusy || attempt.reconciling) {
      this.update({ error: "Wait for the current OpenCode response before refreshing." })
      return Promise.resolve(false)
    }
    const sessionID = attempt.sessionID
    const generation = ++this.generation
    const previousPhase = this.state.phase
    this.update({ phase: "syncing", error: undefined })
    const transitioning = Promise.all([
      this.loadStableSession(attempt, sessionID),
      this.loadCatalog(attempt),
      attempt.client.command.list({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
      .then(([hydrated, catalog, availableCommands]) => {
        if (
          this.attempt !== attempt ||
          attempt.abort.signal.aborted ||
          attempt.sessionID !== sessionID ||
          this.generation !== generation ||
          attempt.pendingEvents?.generation !== generation ||
          attempt.pendingEvents?.overflow ||
          sessionInvalidated(attempt.pendingEvents?.events ?? [], sessionID)
        ) throw new Error("OpenCode session changed while it was refreshing.")
        replayEvents(hydrated.transcript, attempt.pendingEvents?.events ?? [], sessionID)
        const selection = resolveSelection(catalog, selectionForSession(hydrated.session, this.state.selection))
        attempt.catalog = catalog
        this.commands.replace(availableCommands.data)
        this.reviewEpoch++
        this.transcript = hydrated.transcript
        attempt.revertMessageID = hydrated.session.revert?.messageID
        attempt.sessionUsage = sessionUsageAfterEvents(
          attempt.pendingEvents?.events ?? [], sessionID, hydrated.session.usage,
        )
        this.permissions.clear()
        this.questions.clear()
        this.state = {
          ...this.state,
          commands: this.commands.snapshot(),
          agents: catalog.agents,
          providers: catalog.providers,
          models: catalog.models,
          selection,
        }
        this.flushRender()
        this.update({ phase: "ready", error: undefined })
        return true
      })
      .catch((error) => {
        if (this.attempt === attempt && !attempt.abort.signal.aborted && this.generation === generation) {
          if (sessionEndsActive(attempt.pendingEvents?.events ?? [], sessionID)) {
            this.promptBusy = true
            this.update({
              phase: "loading",
              error: "This OpenCode chat became active in another client. Wait for it to finish, then refresh again.",
            })
          } else {
            this.update({ phase: previousPhase, error: safeTransitionError(error) })
          }
        }
        return false
      })
      .finally(() => {
        if (attempt.pendingEvents?.sessionID === sessionID && attempt.pendingEvents.generation === generation) {
          attempt.pendingEvents = undefined
        }
        if (this.transitioning === transitioning) this.transitioning = undefined
      })
    attempt.pendingEvents = { sessionID, generation, events: [], overflow: false }
    this.transitioning = transitioning
    return transitioning
  }

  async stop() {
    const attempt = this.attempt
    if (!this.promptBusy || !attempt?.client || !attempt.sessionID) return
    this.update({ phase: "stopping", error: undefined })
    const stopped = await attempt.client.session
      .abort({ sessionID: attempt.sessionID })
      .then((result) => result.data === true)
      .catch(() => false)
    if (!stopped && this.attempt === attempt && this.promptBusy) {
      this.update({ phase: "loading", error: "OpenCode did not accept the stop request. Try again." })
    }
  }

  send(requestID: string, directory: string, text: string, files: PromptFilePart[] = []) {
    if (this.promptBusy || this.submitting || this.transitioning || this.mutationBusy) {
      this.submissionTracker.rejectRequest(requestID, "OpenCode is already responding.")
      return Promise.resolve(false)
    }
    if (this.disposed || (this.attempt?.client && !this.attempt.connected)) {
      this.submissionTracker.rejectRequest(requestID, "OpenCode session is unavailable.")
      return Promise.resolve(false)
    }
    this.promptBusy = true
    this.update({ phase: this.attempt?.sessionID ? "loading" : "starting", error: undefined })
    const submitting = this.submit(requestID, directory, text, files).finally(() => {
      if (this.submitting === submitting) this.submitting = undefined
    })
    this.submitting = submitting
    return submitting
  }

  runCommand(
    requestID: string,
    directory: string,
    key: string,
    argumentsValue: string,
    files: PromptFilePart[] = [],
  ) {
    if (this.promptBusy || this.submitting || this.transitioning || this.mutationBusy) {
      this.submissionTracker.rejectRequest(requestID, "OpenCode is already responding.")
      return Promise.resolve(false)
    }
    if (this.disposed || (this.attempt?.client && !this.attempt.connected)) {
      this.submissionTracker.rejectRequest(requestID, "OpenCode session is unavailable.")
      return Promise.resolve(false)
    }
    this.promptBusy = true
    this.update({ phase: this.attempt?.sessionID ? "loading" : "starting", error: undefined })
    const submitting = this.submitCommand(requestID, directory, key, argumentsValue, files).finally(() => {
      if (this.submitting === submitting) this.submitting = undefined
    })
    this.submitting = submitting
    return submitting
  }

  private async submit(requestID: string, directory: string, text: string, files: PromptFilePart[]) {
    const messageID = createMessageID()
    this.submissionTracker.start(requestID, messageID)
    try {
      const attempt = await this.ensureStarted(directory)
      await this.ensureSession(attempt)
      if (
        this.disposed ||
        attempt.abort.signal.aborted ||
        this.attempt !== attempt ||
        !attempt.client ||
        !attempt.sessionID
      ) {
        throw new Error("OpenCode session is unavailable.")
      }

      this.update({ phase: "loading", error: undefined })
      const selection = this.state.selection
      if (!attempt.catalog || !acceptsSelection(attempt.catalog, selection)) {
        throw new Error("The selected OpenCode agent or model is no longer available.")
      }
      const unsupported = files.find((file) => !supportsFileInput(attempt.catalog!, selection, file.mime))
      if (unsupported) {
        throw new Error(`The selected model does not support ${unsupported.mime} input.`)
      }
      const started = performance.now()
      this.firstTextPending = true
      this.firstTextStarted = started
      attempt.reviewMessageID = messageID
      await attempt.client.session.promptAsync(
        {
          sessionID: attempt.sessionID,
          messageID,
          agent: selection.agent,
          model: selection.model
            ? { providerID: selection.model.providerID, modelID: selection.model.modelID }
            : undefined,
          variant: selection.variant,
          parts: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...files,
          ],
        },
        { signal: attempt.abort.signal },
      )
      this.timing(`prompt admitted in ${duration(started)}`)
      this.submissionTracker.accept(messageID)
      return true
    } catch (error) {
      this.promptBusy = false
      this.firstTextPending = false
      this.firstTextStarted = undefined
      const message = safeError(error)
      this.submissionTracker.reject(messageID, message)
      this.update({ phase: "error", error: message })
      return false
    }
  }

  private async submitCommand(
    requestID: string,
    directory: string,
    key: string,
    argumentsValue: string,
    files: PromptFilePart[],
  ) {
    const messageID = createMessageID()
    this.submissionTracker.start(requestID, messageID)
    try {
      const attempt = await this.ensureStarted(directory)
      const target = this.commands.resolve(key)
      if (!attempt.client || !target) throw new Error("That OpenCode command is no longer available.")
      const generation = this.generation
      const available = await attempt.client.command.list(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      if (
        !this.commands.matches(key, available.data) || this.attempt !== attempt ||
        attempt.abort.signal.aborted || this.generation !== generation
      ) throw new Error("That OpenCode command is no longer available.")
      this.commands.replace(available.data)
      this.update({ commands: this.commands.snapshot() })
      await this.ensureSession(attempt)
      const selection = this.state.selection
      const sessionID = attempt.sessionID
      if (
        !sessionID || !attempt.catalog || !acceptsSelection(attempt.catalog, selection) ||
        this.attempt !== attempt || attempt.abort.signal.aborted || this.generation !== generation
      ) throw new Error("The selected OpenCode agent or model is no longer available.")
      const unsupported = files.find((file) => !supportsFileInput(attempt.catalog!, selection, file.mime))
      if (unsupported) {
        throw new Error(`The selected model does not support ${unsupported.mime} input.`)
      }
      attempt.reviewMessageID = messageID
      await attempt.client.session.command(
        {
          sessionID,
          directory: attempt.directory,
          messageID,
          command: target.name,
          arguments: argumentsValue,
          agent: selection.agent,
          model: selection.model ? `${selection.model.providerID}/${selection.model.modelID}` : undefined,
          variant: selection.variant,
          parts: files,
        },
        { signal: attempt.abort.signal },
      )
      if (
        this.attempt !== attempt || attempt.abort.signal.aborted || attempt.sessionID !== sessionID ||
        this.generation !== generation
      ) {
        throw new Error("OpenCode session changed while the command was running.")
      }
      this.submissionTracker.accept(messageID)
      return true
    } catch (error) {
      this.promptBusy = false
      const message = safeError(error)
      this.submissionTracker.reject(messageID, message)
      this.update({ phase: "error", error: message })
      return false
    }
  }

  dispose() {
    if (this.disposing) return this.disposing
    this.disposed = true
    this.generation++
    this.promptBusy = true
    if (this.renderTimer) clearTimeout(this.renderTimer)
    const attempt = this.attempt
    const starting = this.starting
    const submitting = this.submitting
    const transitioning = this.transitioning
    this.disposing = Promise.allSettled([this.cleanupAttempt(attempt), starting, submitting, transitioning]).then(() => {
      this.listeners.clear()
      this.submissionListeners.clear()
      this.submissionTracker.clear()
    })
    return this.disposing
  }

  private ensureStarted(directory: string) {
    if (this.disposed) return Promise.reject(new Error("OpenCode startup was cancelled."))
    if (this.attempt?.directory && this.attempt.directory !== directory) {
      return Promise.reject(new Error("This OpenCode session is already bound to another workspace folder."))
    }
    if (this.attempt?.client) return Promise.resolve(this.attempt)
    if (this.starting && this.attempt) return this.starting.then(() => this.attempt!)

    const attempt: Attempt = {
      directory,
      abort: new AbortController(),
      connected: false,
    }
    this.attempt = attempt
    this.update({ phase: "starting", error: undefined })
    const starting = this.start(attempt)
      .catch(async (error) => {
        await this.cleanupAttempt(attempt)
        throw error
      })
      .finally(() => {
        if (this.starting === starting) this.starting = undefined
      })
    this.starting = starting
    return starting.then(() => attempt)
  }

  private async start(attempt: Attempt) {
    const serverStarted = performance.now()
    const server = await startServer(attempt.directory, attempt.abort.signal)
    this.timing(`watchdog and server ready in ${duration(serverStarted)}`)
    if (attempt.abort.signal.aborted || this.attempt !== attempt) {
      await server.close()
      throw new Error("OpenCode startup was cancelled.")
    }
    attempt.server = server
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2/client")
    if (attempt.abort.signal.aborted || this.attempt !== attempt) throw new Error("OpenCode startup was cancelled.")
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: attempt.directory,
      headers: { Authorization: server.authorization },
      throwOnError: true,
    })
    attempt.client = client

    const catalogStarted = performance.now()
    const [catalog, availableCommands] = await Promise.all([
      this.loadCatalog(attempt),
      client.command.list({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
    attempt.catalog = catalog
    this.commands.replace(availableCommands.data)
    const selection = resolveSelection(attempt.catalog, this.state.selection)
    this.state = {
      ...this.state,
      commands: this.commands.snapshot(),
      agents: attempt.catalog.agents,
      providers: attempt.catalog.providers,
      models: attempt.catalog.models,
      selection,
    }
    this.timing(`catalog loaded in ${duration(catalogStarted)}`)

    const eventAbort = linkedAbort(attempt.abort.signal)
    const events = await client.global.event({ signal: eventAbort.signal })
    if (attempt.abort.signal.aborted || this.attempt !== attempt) {
      eventAbort.abort()
      throw new Error("OpenCode startup was cancelled.")
    }
    attempt.eventAbort = eventAbort
    attempt.connected = true
    attempt.events = this.consumeEvents(attempt, events.stream, eventAbort.signal)
    if (!attempt.connected) throw new Error("Connection to OpenCode was interrupted.")
    this.update({ phase: "ready", error: undefined })
  }

  private async loadCatalog(attempt: Attempt): Promise<Catalog> {
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const [providers, agents] = await Promise.all([
      attempt.client.provider.list({ directory: attempt.directory }, { signal: attempt.abort.signal }),
      attempt.client.app.agents({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
    if (!providers.data || !agents.data) throw new Error("OpenCode catalogs are unavailable.")
    return projectCatalog(providers.data, agents.data)
  }

  private async ensureSession(attempt: Attempt) {
    if (attempt.sessionID) return
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const started = performance.now()
    const selection = this.state.selection
    if (!attempt.catalog || !acceptsSelection(attempt.catalog, selection)) {
      throw new Error("The selected OpenCode agent or model is no longer available.")
    }
    const created = await attempt.client.session.create(
      {
        directory: attempt.directory,
        agent: selection.agent,
        model: selection.model
          ? { providerID: selection.model.providerID, id: selection.model.modelID, variant: selection.variant }
          : undefined,
      },
      { signal: attempt.abort.signal },
    )
    const session = parseSession(created.data)
    if (!session) throw new Error("OpenCode did not create a session.")
    attempt.sessionID = session.id
    attempt.revertMessageID = undefined
    attempt.sessionUsage = session.usage
    attempt.reviewMessageID = undefined
    this.timing(`session created in ${duration(started)}`)
    this.reviewEpoch++
    this.transcript = new Transcript(attempt.directory)
    this.permissions.clear()
    this.questions.clear()
    this.flushRender()
  }

  private async consumeEvents(attempt: Attempt, stream: AsyncIterable<GlobalEvent>, eventSignal = attempt.abort.signal) {
    try {
      for await (const event of stream) {
        if (eventSignal.aborted || attempt.abort.signal.aborted || this.attempt !== attempt) return
        const pending = attempt.pendingEvents
        if (pending && eventAffectsSession(event, pending.sessionID)) {
          if (pending.events.length >= 2_000 || eventTooLarge(event)) pending.overflow = true
          else pending.events.push(event)
          if (pending.sessionID === attempt.sessionID) continue
        }
        this.applyEvent(attempt, event)
      }
    } catch {
      if (eventSignal.aborted || attempt.abort.signal.aborted) return
    }

    if (eventSignal.aborted || attempt.abort.signal.aborted || this.attempt !== attempt) return
    attempt.connected = false
    this.promptBusy = false
    this.permissions.clear()
    this.questions.clear()
    this.flushRender()
    this.update({ phase: "error", error: "Connection to OpenCode was interrupted. Reload the window to retry." })
  }

  private applyEvent(attempt: Attempt, event: GlobalEvent) {
    const payload = event.payload
    if (payload.type === "session.updated") {
      const session = parseSession(payload.properties.info)
      attempt.history ??= new SessionHistory(attempt.directory)
      if (!session || session.id !== attempt.sessionID || !attempt.history.accepts(session)) return
      const revertChanged = attempt.revertMessageID !== session.revert?.messageID
      attempt.revertMessageID = session.revert?.messageID
      attempt.sessionUsage = session.usage
      if (revertChanged) {
        this.reviewEpoch++
        attempt.reconcileRequested = true
        if (!this.mutationBusy) void this.reconcile(attempt)
      } else this.renderSoon()
      return
    }
    if (payload.type === "message.updated") {
      if (payload.properties.info.sessionID !== attempt.sessionID) return
      if (payload.properties.info.role === "user") attempt.reviewMessageID = payload.properties.info.id
      this.reviewEpoch++
      this.upsertMessage(payload.properties.info)
      return
    }
    if (payload.type === "message.part.updated") {
      const part = payload.properties.part
      if (part.sessionID !== attempt.sessionID) return
      if (part.type === "file") this.transcript.setFile(part)
      if (part.type === "tool") this.transcript.setTool(part)
      if (part.type === "reasoning") this.transcript.setReasoning(part)
      if (part.type === "step-finish") this.transcript.setStepFinish(part)
      if (part.type === "text" && !part.synthetic && !part.ignored) {
        this.transcript.setPart(part)
        this.recordFirstText(part.messageID)
      }
      if (part.type === "text" && (part.synthetic || part.ignored)) this.transcript.hidePart(part.messageID, part.id)
      this.renderSoon()
      return
    }
    if (payload.type === "message.part.delta") {
      const properties = payload.properties
      if (properties.sessionID !== attempt.sessionID || properties.field !== "text") return
      if (!this.transcript.appendReasoning(properties.messageID, properties.partID, properties.delta)) {
        this.transcript.appendPart(properties.messageID, properties.partID, properties.delta)
      }
      this.recordFirstText(properties.messageID)
      this.renderSoon()
      return
    }
    if (payload.type === "message.removed") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      this.transcript.removeMessage(payload.properties.messageID)
      this.renderSoon()
      return
    }
    if (payload.type === "message.part.removed") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      this.transcript.removePart(payload.properties.messageID, payload.properties.partID)
      this.renderSoon()
      return
    }
    if (payload.type === "session.status") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      if (payload.properties.status.type === "retry") {
        this.transcript.setRetry({ attempt: payload.properties.status.attempt, next: payload.properties.status.next })
        this.promptBusy = true
        this.flushRender()
        this.update({ phase: "loading", error: undefined })
        return
      }
      if (payload.properties.status.type !== "busy") return
      this.transcript.setRetry()
      this.promptBusy = true
      this.update({ phase: "loading", error: undefined })
      return
    }
    if (payload.type === "session.idle") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      this.transcript.setRetry()
      this.permissions.clear()
      this.flushRender()
      void this.reconcile(attempt, attempt.reviewMessageID ?? this.transcript.latestUserID())
      return
    }
    if (payload.type === "permission.asked") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      this.permissions.upsert(payload.properties as PermissionRequest, attempt.sessionID, attempt.directory)
      this.flushRender()
      return
    }
    if (payload.type === "permission.replied") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      this.permissions.remove(payload.properties.requestID)
      this.flushRender()
      return
    }
    if (payload.type === "question.asked") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      this.questions.upsert(payload.properties as QuestionRequest, attempt.sessionID)
      this.flushRender()
      return
    }
    if (payload.type === "question.replied" || payload.type === "question.rejected") {
      if (payload.properties.sessionID !== attempt.sessionID) return
      this.questions.remove(payload.properties.requestID)
      this.flushRender()
      return
    }
    if (payload.type === "session.error") {
      if (payload.properties.sessionID && payload.properties.sessionID !== attempt.sessionID) return
      const error = "OpenCode could not complete the request. Check your provider configuration in OpenCode."
      this.promptBusy = true
      this.firstTextPending = false
      this.firstTextStarted = undefined
      this.permissions.clear()
      this.questions.clear()
      this.flushRender()
      attempt.reconciliationError = error
      this.submissionTracker.fail(error)
      this.update({ phase: "error", error })
      void this.reconcile(attempt)
      return
    }
    if (payload.type === "session.deleted" && payload.properties.sessionID === attempt.sessionID) {
      this.resetToNewChat(attempt)
    }
  }

  private upsertMessage(info: Message) {
    this.transcript.upsertMessage(info)
    if (this.submissionTracker.observe(info.id)) this.timing("user message observed by transcript sync")
    this.recordFirstText(info.id)
    this.renderSoon()
  }

  private async loadTranscript(attempt: Attempt, sessionID: string) {
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const response = await attempt.client.session.messages(
      { sessionID, directory: attempt.directory, limit: MAX_TRANSCRIPT_MESSAGES },
      { signal: attempt.abort.signal },
    )
    const transcript = new Transcript(attempt.directory)
    transcript.replace(projectMessages(response.data, attempt.revertMessageID))
    return transcript
  }

  private async loadSessionUsage(attempt: Attempt, sessionID: string) {
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    const response = await attempt.client.session.get(
      { sessionID, directory: attempt.directory },
      { signal: attempt.abort.signal },
    )
    const session = parseSession(response.data)
    attempt.history ??= new SessionHistory(attempt.directory)
    if (!session || session.id !== sessionID || !attempt.history.accepts(session)) {
      throw new Error("That OpenCode chat is outside this workspace.")
    }
    return session.usage
  }

  private async loadStableSession(attempt: Attempt, sessionID: string, retry = true): Promise<HydratedSession> {
    if (!attempt.client) throw new Error("OpenCode session is unavailable.")
    attempt.history ??= new SessionHistory(attempt.directory)
    const [beforeResponse, beforeStatuses] = await Promise.all([
      attempt.client.session.get(
        { sessionID, directory: attempt.directory },
        { signal: attempt.abort.signal },
      ),
      attempt.client.session.status(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      ),
    ])
    const before = parseSession(beforeResponse.data)
    if (!before || !attempt.history.accepts(before)) throw new Error("That OpenCode chat is outside this workspace.")
    if (sessionIsActive(beforeStatuses.data, sessionID)) throw new Error("That OpenCode chat is active in another client.")
    const messages = await attempt.client.session.messages(
      { sessionID, directory: attempt.directory, limit: MAX_TRANSCRIPT_MESSAGES },
      { signal: attempt.abort.signal },
    )
    const [afterResponse, afterStatuses] = await Promise.all([
      attempt.client.session.get(
        { sessionID, directory: attempt.directory },
        { signal: attempt.abort.signal },
      ),
      attempt.client.session.status(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      ),
    ])
    const after = parseSession(afterResponse.data)
    if (!after || !attempt.history.accepts(after)) throw new Error("That OpenCode chat is outside this workspace.")
    if (sessionIsActive(afterStatuses.data, sessionID)) throw new Error("That OpenCode chat is active in another client.")
    if (!sameSessionVersion(before, after)) {
      if (retry) return this.loadStableSession(attempt, sessionID, false)
      throw new Error("That OpenCode chat changed while it was loading.")
    }
    const transcript = new Transcript(attempt.directory)
    transcript.replace(projectMessages(messages.data, after.revert?.messageID))
    return { session: after, transcript }
  }

  private reconcile(attempt: Attempt, reviewMessageID?: string) {
    if (attempt.reconciling) return attempt.reconciling
    const sessionID = attempt.sessionID
    if (!sessionID) return Promise.resolve()
    attempt.reconcileRequested = false
    const generation = this.generation
    const started = performance.now()
    const reconciling = Promise.all([
      this.loadTranscript(attempt, sessionID),
      this.loadSessionUsage(attempt, sessionID).catch(() => undefined),
    ])
      .then(async ([transcript, sessionUsage]) => {
        if (this.submitting) await this.submitting
        if (
          this.attempt !== attempt ||
          attempt.abort.signal.aborted ||
          attempt.sessionID !== sessionID ||
          this.generation !== generation
        ) return
        this.reviewEpoch++
        this.transcript = transcript
        attempt.sessionUsage = sessionUsage
        transcript.snapshot().forEach((message) => {
          if (this.submissionTracker.observe(message.id)) this.timing("user message observed by transcript sync")
        })
        this.flushRender()
        this.timing(`transcript reconciled in ${duration(started)}`)
        if (reviewMessageID) await this.loadReview(attempt, sessionID, generation, transcript, reviewMessageID)
        this.promptBusy = false
        this.firstTextPending = false
        this.firstTextStarted = undefined
        const error = attempt.reconciliationError
        attempt.reconciliationError = undefined
        if (error) this.submissionTracker.fail(error)
        this.update({ phase: error ? "error" : "ready", error })
      })
      .catch(() => {
        if (
          this.attempt !== attempt ||
          attempt.abort.signal.aborted ||
          attempt.sessionID !== sessionID ||
          this.generation !== generation
        ) return
        this.promptBusy = false
        this.firstTextPending = false
        this.firstTextStarted = undefined
        const error = attempt.reconciliationError ?? "OpenCode finished, but the transcript could not be refreshed."
        attempt.reconciliationError = undefined
        this.submissionTracker.fail(error)
        this.update({ phase: "error", error })
      })
      .finally(() => {
        if (attempt.reconciling !== reconciling) return
        attempt.reconciling = undefined
        if (attempt.reconcileRequested && this.attempt === attempt && !attempt.abort.signal.aborted && attempt.sessionID) {
          void this.reconcile(attempt)
        }
      })
    attempt.reconciling = reconciling
    return reconciling
  }

  private async loadReview(
    attempt: Attempt,
    sessionID: string,
    generation: number,
    transcript: Transcript,
    messageID: string,
  ) {
    if (!attempt.client || transcript.role(messageID) !== "user") return
    let receivedOfficialResponse = false
    let diffs: FileDiff[] = []
    for (const index of Array.from({ length: REVIEW_DIFF_ATTEMPTS }, (_, value) => value)) {
      if (!this.reviewIsCurrent(attempt, sessionID, generation, transcript)) return
      const response = await attempt.client.session.diff(
        { sessionID, directory: attempt.directory, messageID },
        { signal: attempt.abort.signal },
      ).catch(() => undefined)
      if (!this.reviewIsCurrent(attempt, sessionID, generation, transcript)) return
      if (Array.isArray(response?.data)) {
        receivedOfficialResponse = true
        diffs = response.data
        if (diffs.length) break
      }
      if (index < REVIEW_DIFF_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, REVIEW_DIFF_RETRY_MS))
    }
    if (!this.reviewIsCurrent(attempt, sessionID, generation, transcript)) return
    if (receivedOfficialResponse || !transcript.hasReview(messageID)) {
      this.reviewEpoch++
      transcript.setReview(messageID, diffs, diffs.length === 0, true)
      this.flushRender()
    }
    if (attempt.reviewMessageID === messageID) attempt.reviewMessageID = undefined
  }

  private async providerMethod(attempt: Attempt, providerID: string, methodIndex: number): Promise<ProviderMethod | undefined> {
    if (!attempt.client || !Number.isSafeInteger(methodIndex) || methodIndex < 0 || methodIndex >= 10) return
    const [providers, methods] = await Promise.all([
      attempt.client.provider.list({ directory: attempt.directory }, { signal: attempt.abort.signal }),
      attempt.client.provider.auth({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
    return providerConnections(providers.data, methods.data)
      .find((provider) => provider.id === providerID)?.methods.find((method) => method.index === methodIndex)
  }

  private async reloadProviderCatalog(attempt: Attempt, generation: number) {
    if (!attempt.client || !this.currentAttempt(attempt, generation)) return false
    attempt.eventAbort?.abort()
    await attempt.events?.catch(() => undefined)
    if (!this.currentAttempt(attempt, generation)) return false
    attempt.connected = false
    try {
      await attempt.client.instance.dispose(
        { directory: attempt.directory },
        { signal: attempt.abort.signal },
      )
      if (!this.currentAttempt(attempt, generation)) return false
      return await this.bootstrapProviderCatalog(attempt, generation)
    } catch (error) {
      if (this.currentAttempt(attempt, generation)) {
        const recovered = await this.bootstrapProviderCatalog(attempt, generation).catch(() => false)
        if (!recovered && this.currentAttempt(attempt, generation)) {
          attempt.connected = false
          this.update({
            phase: "error",
            error: "OpenCode provider refresh failed and the event connection could not be restored. Reload the window to retry.",
          })
        }
      }
      throw error
    }
  }

  private async bootstrapProviderCatalog(attempt: Attempt, generation: number) {
    if (!attempt.client || !this.currentAttempt(attempt, generation)) return false
    const [catalog, availableCommands] = await Promise.all([
      this.loadCatalog(attempt),
      attempt.client.command.list({ directory: attempt.directory }, { signal: attempt.abort.signal }),
    ])
    if (!this.currentAttempt(attempt, generation)) return false
    const eventAbort = linkedAbort(attempt.abort.signal)
    const events = await attempt.client.global.event({ signal: eventAbort.signal }).catch((error) => {
      eventAbort.abort()
      throw error
    })
    if (!this.currentAttempt(attempt, generation)) {
      eventAbort.abort()
      return false
    }
    attempt.catalog = catalog
    attempt.eventAbort = eventAbort
    attempt.connected = true
    attempt.events = this.consumeEvents(attempt, events.stream, eventAbort.signal)
    this.commands.replace(availableCommands.data)
    this.state = {
      ...this.state,
      commands: this.commands.snapshot(),
      agents: catalog.agents,
      providers: catalog.providers,
      models: catalog.models,
      selection: resolveSelection(catalog, this.state.selection),
    }
    this.update({ phase: "ready", error: undefined })
    return true
  }

  private currentAttempt(attempt: Attempt, generation: number) {
    return this.attempt === attempt && !attempt.abort.signal.aborted && this.generation === generation
  }

  private reviewIsCurrent(attempt: Attempt, sessionID: string, generation: number, transcript: Transcript) {
    return this.attempt === attempt &&
      !attempt.abort.signal.aborted &&
      attempt.sessionID === sessionID &&
      this.generation === generation &&
      this.transcript === transcript
  }

  private renderSoon() {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => this.flushRender(), 32)
  }

  private flushRender() {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = undefined
    this.update({
      messages: this.transcript.snapshot(),
      commands: this.commands.snapshot(),
      reviews: this.transcript.reviewSnapshot(),
      permissions: this.permissions.snapshot(),
      questions: this.questions.snapshot(),
      activities: this.transcript.activitySnapshot(),
      turnUsage: this.transcript.turnUsageSnapshot(),
      sessionUsage: this.attempt?.sessionUsage ?? {},
    })
  }

  private cleanupAttempt(attempt?: Attempt) {
    if (!attempt) return Promise.resolve()
    if (attempt.cleanup) return attempt.cleanup
    attempt.abort.abort()
    attempt.cleanup = Promise.allSettled([attempt.events, attempt.server?.close()]).then((results) => {
      if (this.attempt === attempt) {
        this.attempt = undefined
        this.transcript.clear()
        this.permissions.clear()
        this.questions.clear()
        this.commands.clear()
        this.flushRender()
      }
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("OpenCode process did not exit after termination.")
      }
    })
    return attempt.cleanup
  }

  private update(next: Partial<SessionState>) {
    this.state = { ...this.state, ...next }
    this.listeners.forEach((listener) => listener(this.state))
  }

  private firstTextPending = false
  private firstTextStarted?: number

  private recordFirstText(messageID: string) {
    if (!this.firstTextPending || this.transcript.role(messageID) !== "assistant" || !this.transcript.hasText(messageID)) return
    this.firstTextPending = false
    if (this.firstTextStarted !== undefined) this.timing(`first assistant text in ${duration(this.firstTextStarted)}`)
    this.firstTextStarted = undefined
  }

  private setSelection(selection: Selection) {
    this.update({ selection, error: undefined })
  }

  private async mutableSession(key: string) {
    const attempt = this.attempt
    const target = attempt?.history?.resolve(key)
    if (!attempt?.client || !target) {
      this.update({ error: "That OpenCode chat is no longer available." })
      return
    }
    if (this.promptBusy || this.submitting || this.transitioning) {
      this.update({ error: "Wait for active OpenCode work to finish before changing that chat." })
      return
    }
    try {
      const [response, statuses] = await Promise.all([
        attempt.client.session.get(
          { sessionID: target.id, directory: attempt.directory },
          { signal: attempt.abort.signal },
        ),
        attempt.client.session.status({ directory: attempt.directory }, { signal: attempt.abort.signal }),
      ])
      const session = parseSession(response.data)
      if (!session || !attempt.history?.accepts(session) || session.id !== target.id) {
        throw new Error("That OpenCode chat is outside this workspace.")
      }
      if (sessionIsActive(statuses.data, session.id)) {
        this.update({ error: "Wait for active OpenCode work to finish before changing that chat." })
        return
      }
      return session
    } catch {
      this.update({ error: "That OpenCode chat is no longer available." })
    }
  }

  private async mutate<Value>(
    operation: () => Promise<Value>,
    busyMessage = "Wait for the current chat change to finish.",
  ): Promise<Value | false> {
    if (this.mutationBusy || this.promptBusy || this.submitting || this.transitioning) {
      this.update({ error: busyMessage })
      return false
    }
    this.mutationBusy = true
    this.reviewEpoch++
    try {
      return await operation()
    } finally {
      this.mutationBusy = false
      const attempt = this.attempt
      if (attempt?.reconcileRequested && !attempt.reconciling && attempt.sessionID && !attempt.abort.signal.aborted) {
        void this.reconcile(attempt)
      }
    }
  }

  private resetToNewChat(attempt: Attempt) {
    if (this.attempt !== attempt) return
    attempt.sessionID = undefined
    attempt.revertMessageID = undefined
    attempt.sessionUsage = undefined
    attempt.reviewMessageID = undefined
    this.generation++
    this.promptBusy = false
    attempt.reconciliationError = undefined
    this.submissionTracker.clear()
    this.transcript.clear()
    this.permissions.clear()
    this.questions.clear()
    this.flushRender()
    this.update({ phase: attempt.client ? "ready" : "idle", error: undefined })
  }

  private async reloadAfterHistoryMutation(attempt: Attempt, sessionID: string, generation: number) {
    const hydrated = await this.loadStableSession(attempt, sessionID)
    if (!this.currentAttempt(attempt, generation) || attempt.sessionID !== sessionID || hydrated.session.id !== sessionID) {
      return false
    }
    this.transcript = hydrated.transcript
    attempt.revertMessageID = hydrated.session.revert?.messageID
    attempt.sessionUsage = hydrated.session.usage
    this.permissions.clear()
    this.questions.clear()
    this.flushRender()
    this.update({ phase: "ready", error: undefined })
    return true
  }
}

function safeError(error: unknown) {
  if (!(error instanceof Error)) return "OpenCode request failed."
  if (/^The selected model does not support (?:application\/pdf|image\/(?:png|jpeg|gif|webp)|audio\/(?:mp4|mpeg|wav|ogg|flac|webm)|video\/(?:mp4|quicktime|webm|ogg|x-msvideo|mpeg)) input\.$/.test(error.message)) {
    return error.message
  }
  if (
    error.message === "OpenCode CLI executable was not found on the extension host PATH." ||
    error.message === "The configured OpenCode CLI executable is not an executable file." ||
    error.message === "OpenCode did not start within 15 seconds." ||
    error.message === "OpenCode exited before the server was ready." ||
    error.message === "OpenCode did not bind to the expected loopback address." ||
    error.message === "OpenCode process did not exit after termination." ||
    error.message === "No connected OpenCode model is available." ||
    error.message === "The selected OpenCode agent or model is no longer available." ||
    error.message === "The selected model does not support image input." ||
    error.message === "That OpenCode command is no longer available." ||
    error.message === "This OpenCode session is already bound to another workspace folder."
  ) {
    return error.message
  }
  return "OpenCode request failed. Check your OpenCode provider configuration and try again."
}

function boundedSecret(value: string) {
  return value.length > 0 && value.length <= 100_000
}

function projectedShareURL(value: unknown) {
  const item = record(value)
  if (!item || !Object.prototype.hasOwnProperty.call(item, "share")) return
  const url = record(item.share)?.url
  if (typeof url !== "string" || url.length > 2_048) return
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return
    if (parsed.protocol === "https:") return parsed.toString()
    if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return
    return parsed.toString()
  } catch {
    return
  }
}

function matchingSessionResponse(value: unknown, sessionID: string, directory: string) {
  const item = record(value)
  const session = parseSession(value)
  return item && session?.id === sessionID && session.directory === directory ? item : undefined
}

function projectConsoleOrganizations(value: unknown): ConsoleOrganization[] {
  const seen = new Set<string>()
  return (Array.isArray(record(value)?.orgs) ? record(value)!.orgs as unknown[] : [])
    .slice(0, 100)
    .flatMap((entry) => {
      const item = record(entry)
      if (!item || !boundedDisplay(item.accountID, 512) || !boundedDisplay(item.orgID, 512) ||
        !boundedDisplay(item.orgName, 120) || !boundedDisplay(item.accountEmail, 254) || typeof item.active !== "boolean") return []
      const identity = `${item.accountID}\0${item.orgID}`
      if (seen.has(identity)) return []
      seen.add(identity)
      return [{
        accountID: item.accountID,
        orgID: item.orgID,
        name: item.orgName,
        email: item.accountEmail,
        active: item.active,
      }]
    })
}

function boundedDisplay(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function linkedAbort(parent: AbortSignal) {
  const controller = new AbortController()
  if (parent.aborted) controller.abort()
  else {
    const abort = () => controller.abort()
    parent.addEventListener("abort", abort, { once: true })
    controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", abort), { once: true })
  }
  return controller
}

function safeTransitionError(error: unknown) {
  if (!(error instanceof Error)) return "OpenCode chat could not be loaded."
  if (
    error.message === "That OpenCode chat is outside this workspace." ||
    error.message === "That OpenCode chat is active in another client." ||
    error.message === "That OpenCode chat changed while it was loading."
  ) return error.message
  return "OpenCode chat could not be loaded. The current chat was kept unchanged."
}

function selectionForSession(session: SessionInfo, fallback: Selection): Selection {
  return {
    agent: session.agent ?? fallback.agent,
    model: session.model
      ? { providerID: session.model.providerID, modelID: session.model.id }
      : fallback.model,
    variant: session.model?.variant,
  }
}

function projectMessages(messages: Array<{ info: Message; parts: Part[] }> | undefined, revertMessageID?: string) {
  const all = messages ?? []
  const index = revertMessageID ? all.findIndex((message) => message.info.id === revertMessageID) : -1
  const visible = revertMessageID ? (index < 0 ? [] : all.slice(0, index)) : all
  return visible.slice(-MAX_TRANSCRIPT_MESSAGES).map((message) => ({
    info: message.info,
    parts: message.parts.slice(0, 1_000).filter((part) =>
      part.type === "file" || part.type === "tool" || part.type === "reasoning" ||
      part.type === "step-finish" ||
      (part.type === "text" && !part.synthetic && !part.ignored),
    ),
  }))
}

function sessionIsActive(value: unknown, sessionID: string) {
  const status = record(value)?.[sessionID]
  return record(status)?.type === "busy" || record(status)?.type === "retry"
}

function eventSessionID(event: GlobalEvent) {
  if (event.payload.type === "session.updated") return event.payload.properties.info.id
  if (event.payload.type === "message.updated") return event.payload.properties.info.sessionID
  if (event.payload.type === "message.part.updated") return event.payload.properties.part.sessionID
  const properties = record(record(event.payload)?.properties)
  return typeof properties?.sessionID === "string" ? properties.sessionID : undefined
}

function eventAffectsSession(event: GlobalEvent, sessionID: string) {
  return eventSessionID(event) === sessionID || (event.payload.type === "session.error" && !eventSessionID(event))
}

function eventTooLarge(event: GlobalEvent) {
  if (event.payload.type === "session.updated") {
    return JSON.stringify(event.payload.properties.info).length > MAX_QUEUED_MESSAGE_EVENT_CHARS
  }
  if (event.payload.type === "message.updated") {
    return JSON.stringify(event.payload.properties.info).length > MAX_QUEUED_MESSAGE_EVENT_CHARS
  }
  if (event.payload.type === "message.part.delta") {
    return event.payload.properties.delta.length > MAX_TRANSCRIPT_DELTA_CHARS
  }
  if (event.payload.type === "message.part.updated" && event.payload.properties.part.type === "text") {
    return event.payload.properties.part.text.length > MAX_TRANSCRIPT_MESSAGE_CHARS
  }
  if (event.payload.type === "message.part.updated" &&
    (event.payload.properties.part.type === "tool" || event.payload.properties.part.type === "step-finish")) {
    return JSON.stringify(event.payload.properties.part).length > 64_000
  }
  return false
}

function normalizedDiffPath(value: string | undefined) {
  return value?.replaceAll("\\", "/").trim()
}

function replayEvents(transcript: Transcript, events: GlobalEvent[], sessionID: string) {
  events.forEach((event) => {
    const payload = event.payload
    if (eventSessionID(event) !== sessionID) return
    if (payload.type === "message.updated") {
      transcript.upsertMessage(payload.properties.info)
      return
    }
    if (payload.type === "message.part.updated") {
      const part = payload.properties.part
      if (part.type === "text" && !part.synthetic && !part.ignored) transcript.setPart(part)
      if (part.type === "text" && (part.synthetic || part.ignored)) transcript.hidePart(part.messageID, part.id)
      if (part.type === "file") transcript.setFile(part)
      if (part.type === "tool") transcript.setTool(part)
      if (part.type === "reasoning") transcript.setReasoning(part)
      if (part.type === "step-finish") transcript.setStepFinish(part)
      return
    }
    if (payload.type === "message.part.delta" && payload.properties.field === "text") {
      if (!transcript.appendReasoning(payload.properties.messageID, payload.properties.partID, payload.properties.delta)) {
        transcript.appendPart(payload.properties.messageID, payload.properties.partID, payload.properties.delta)
      }
      return
    }
    if (payload.type === "message.removed") {
      transcript.removeMessage(payload.properties.messageID)
      return
    }
    if (payload.type === "message.part.removed") {
      transcript.removePart(payload.properties.messageID, payload.properties.partID)
    }
  })
}

function sessionEndsActive(events: GlobalEvent[], sessionID: string) {
  return events.reduce<boolean | undefined>((active, event) => {
    if (eventSessionID(event) !== sessionID) return active
    if (event.payload.type === "session.status") return event.payload.properties.status.type !== "idle"
    if (event.payload.type === "session.idle") return false
    return active
  }, undefined) === true
}

function sessionInvalidated(events: GlobalEvent[], sessionID: string) {
  return sessionEndsActive(events, sessionID) || events.some((event) =>
    eventAffectsSession(event, sessionID) &&
    (event.payload.type === "session.updated" || event.payload.type === "session.deleted" || event.payload.type === "session.error"),
  )
}

function sessionUsageAfterEvents(events: GlobalEvent[], sessionID: string, fallback?: UsageTotals) {
  return events.reduce<UsageTotals | undefined>((usage, event) => {
    if (event.payload.type !== "session.updated") return usage
    const session = parseSession(event.payload.properties.info)
    return session?.id === sessionID ? session.usage : usage
  }, fallback)
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function duration(started: number) {
  return `${Math.round(performance.now() - started)}ms`
}

function createMessageID() {
  return `msg_${Date.now().toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`
}
