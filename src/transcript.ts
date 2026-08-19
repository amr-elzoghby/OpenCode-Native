import {
  MAX_TRANSCRIPT_DELTA_CHARS,
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_TOTAL_CHARS,
} from "./protocol"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { ReviewStore, type FileDiff, type ReviewSummary } from "./review"
import {
  addCosts,
  addUsageTokens,
  projectUsage,
  type ResponseMetadata,
  type TurnUsage,
  type UsageTotals,
} from "./usage"

const MAX_TRANSCRIPT_PARTS = 2_000
const MAX_TRANSCRIPT_FILES = 200
const MAX_ACTIVITY_ITEMS = 500
const MAX_ACTIVITY_ITEMS_PER_PHASE = 100
const MAX_ACTIVITY_PHASES = 200
const MAX_REASONING_CHARS = 32_000
const MAX_REASONING_TURN_CHARS = 128_000
const MAX_REASONING_TOTAL_CHARS = 512_000
const MAX_USAGE_PARTS = 2_000

export type TranscriptMessage = {
  id: string
  turnID: string
  role: "user" | "assistant"
  text: string
  createdAt?: number
  attachments?: string[]
  response?: ResponseMetadata
}

export type ActivityItem = {
  key: string
  kind: "reasoning" | "command" | "read" | "search" | "web" | "edit" | "task" | "question" | "todo" | "tool"
  status: "waiting" | "running" | "completed" | "failed" | "denied"
  title: string
  detail?: string
  startedAt?: number
  endedAt?: number
  files?: Array<{ key: string; path: string; additions?: number; deletions?: number }>
}

export type TurnActivity = {
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
  items: ActivityItem[]
}

type MessageInfo = {
  id: string
  parentID?: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  agent?: unknown
  providerID?: unknown
  modelID?: unknown
  variant?: unknown
  cost?: unknown
  tokens?: unknown
  error?: { name?: string }
  summary?: boolean | {
    diffs: Array<{
      file?: string
      patch?: string
      additions: number
      deletions: number
      status?: "added" | "deleted" | "modified"
    }>
  }
}

type StoredMessage = {
  id: string
  parentID?: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  error?: { name?: string }
  response?: ResponseMetadata
}

type TextPart = {
  id: string
  messageID: string
  text: string
}

type FilePart = {
  id: string
  messageID: string
  filename?: string
}

type ToolPart = {
  id: string
  messageID: string
  tool: string
  state: { status: "pending" | "running" | "completed" | "error"; [key: string]: unknown }
}

type ReasoningPart = {
  id: string
  messageID: string
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
}

type StepFinishPart = {
  id: string
  messageID: string
  type: "step-finish"
  cost: unknown
  tokens: unknown
}

type PartRecord = {
  text: string
  snapshot: boolean
}

export class Transcript {
  private messages = new Map<string, StoredMessage>()
  private parts = new Map<string, Map<string, PartRecord>>()
  private files = new Map<string, Map<string, string>>()
  private hidden = new Map<string, Set<string>>()
  private activities = new Map<string, { key: string; items: Map<string, ActivityItem>; truncated: boolean }>()
  private turnKeys = new Map<string, string>()
  private retry?: { attempt: number; nextAt: number }
  private reasoning = new Map<string, Map<string, { text: string; time: ReasoningPart["time"] }>>()
  private usage = new Map<string, Map<string, UsageTotals>>()
  private textLength = 0
  private partCount = 0
  private fileCount = 0
  private hiddenCount = 0
  private activityCount = 0
  private usagePartCount = 0
  private deltasDisabled = false
  private reviews = new ReviewStore()

  constructor(private directory?: string) {}

  clear() {
    this.messages.clear()
    this.parts.clear()
    this.files.clear()
    this.hidden.clear()
    this.activities.clear()
    this.turnKeys.clear()
    this.retry = undefined
    this.reasoning.clear()
    this.usage.clear()
    this.textLength = 0
    this.partCount = 0
    this.fileCount = 0
    this.hiddenCount = 0
    this.activityCount = 0
    this.usagePartCount = 0
    this.deltasDisabled = false
    this.reviews.clear()
  }

  setRetry(value?: { attempt: number; next: number }) {
    if (!value || !Number.isSafeInteger(value.attempt) || value.attempt < 0 || value.attempt > 1_000_000 ||
      !Number.isFinite(value.next) || value.next < 0) {
      this.retry = undefined
      return
    }
    this.retry = { attempt: value.attempt, nextAt: value.next }
  }

  upsertMessage(info: MessageInfo) {
    if (!safeID(info.id) || (info.parentID !== undefined && !safeID(info.parentID)) ||
      !Number.isSafeInteger(info.time.created) || info.time.created < 0 || info.time.created > 8_640_000_000_000_000) return
    if (!this.messages.has(info.id) && this.messages.size >= MAX_TRANSCRIPT_MESSAGES) {
      const oldest = [...this.messages.values()].sort((a, b) => a.time.created - b.time.created)[0]
      if (oldest) this.removeMessage(oldest.id)
    }
    this.reviews.upsert(info, undefined, true)
    const completed = safeCompleted(info.time.completed, info.time.created)
    const usage = info.role === "assistant" ? projectUsage(info.cost, info.tokens) : {}
    const response = info.role === "assistant" ? compactResponse({
      completedAt: completed,
      agent: safeMetadata(info.agent, 120),
      providerID: safeMetadata(info.providerID, 512),
      modelID: safeMetadata(info.modelID, 512),
      variant: safeMetadata(info.variant, 128),
      cost: usage.cost,
      contextTokens: usage.tokens,
    }) : undefined
    this.messages.set(info.id, {
      id: info.id,
      parentID: info.parentID,
      role: info.role,
      time: { created: info.time.created, completed },
      error: info.error?.name ? { name: safeText(info.error.name, 120) } : undefined,
      response,
    })
  }

  role(messageID: string) {
    return this.messages.get(messageID)?.role
  }

  hasMessage(messageID: string) {
    return this.messages.has(messageID)
  }

  hasText(messageID: string) {
    return [...(this.parts.get(messageID)?.values() ?? [])].some((part) => part.text.length > 0)
  }

  setPart(part: TextPart) {
    if (!safeID(part.messageID) || !safeID(part.id)) return
    const parts = this.parts.get(part.messageID) ?? new Map<string, PartRecord>()
    const existing = parts.get(part.id)
    if (!existing && this.partCount >= MAX_TRANSCRIPT_PARTS) return
    const text = existing && !existing.snapshot && !part.text.endsWith(existing.text)
      ? part.text + existing.text
      : part.text
    const bounded = this.bound(part.messageID, part.id, text)
    this.textLength += bounded.length - (existing?.text.length ?? 0)
    parts.set(part.id, { text: bounded, snapshot: true })
    if (!existing) this.partCount++
    this.parts.set(part.messageID, parts)
  }

  setFile(part: FilePart) {
    if (!safeID(part.messageID) || !safeID(part.id)) return
    const filename = safeFilename(part.filename)
    if (!filename) return
    const files = this.files.get(part.messageID) ?? new Map<string, string>()
    if (!files.has(part.id) && this.fileCount >= MAX_TRANSCRIPT_FILES) return
    if (!files.has(part.id)) this.fileCount++
    files.set(part.id, filename)
    this.files.set(part.messageID, files)
  }

  setTool(part: ToolPart) {
    if (!safeID(part.messageID) || !safeID(part.id) || !safeID(part.tool)) return
    if (part.state.status !== "pending" && part.state.status !== "running" && part.state.status !== "completed" && part.state.status !== "error") return
    const item = toolActivity(part, this.directory)
    item.key = this.activityItemKey(part.messageID, part.id)
    this.setActivityItem(part.messageID, part.id, item)
  }

  setReasoning(part: ReasoningPart) {
    if (!safeID(part.messageID) || !safeID(part.id) || !Number.isFinite(part.time.start)) return
    const existing = this.reasoning.get(part.messageID)?.get(part.id)?.text.length ?? 0
    const turnUsed = [...(this.reasoning.get(part.messageID)?.values() ?? [])].reduce((total, item) => total + item.text.length, 0) - existing
    const totalUsed = [...this.reasoning.values()].reduce(
      (total, parts) => total + [...parts.values()].reduce((sum, item) => sum + item.text.length, 0),
      0,
    ) - existing
    const available = Math.max(0, Math.min(MAX_REASONING_CHARS, MAX_REASONING_TURN_CHARS - turnUsed, MAX_REASONING_TOTAL_CHARS - totalUsed))
    const content = part.text.replaceAll("[REDACTED]", "").trim().slice(0, available)
    if (!content) {
      const parts = this.reasoning.get(part.messageID)
      parts?.delete(part.id)
      if (parts?.size === 0) this.reasoning.delete(part.messageID)
      return this.removeActivityItem(part.messageID, part.id)
    }
    const parts = this.reasoning.get(part.messageID) ?? new Map()
    parts.set(part.id, { text: content, time: part.time })
    this.reasoning.set(part.messageID, parts)
    const summary = reasoningSummary(content)
    this.setActivityItem(part.messageID, part.id, {
      key: this.activityItemKey(part.messageID, part.id),
      kind: "reasoning",
      status: part.time.end === undefined ? "running" : "completed",
      title: summary.title ? `Thinking · ${summary.title}` : "Thinking",
      detail: summary.body || undefined,
      startedAt: part.time.start,
      endedAt: part.time.end,
    })
  }

  setStepFinish(part: StepFinishPart) {
    if (!safeID(part.messageID) || !safeID(part.id)) return
    const parts = this.usage.get(part.messageID) ?? new Map<string, UsageTotals>()
    const existing = parts.has(part.id)
    const projected = projectUsage(part.cost, part.tokens)
    if (projected.cost === undefined || !projected.tokens) {
      if (parts.delete(part.id)) this.usagePartCount--
      if (!parts.size) this.usage.delete(part.messageID)
      return
    }
    if (!existing && this.usagePartCount >= MAX_USAGE_PARTS) return
    parts.set(part.id, projected)
    if (!existing) this.usagePartCount++
    this.usage.set(part.messageID, parts)
  }

  appendReasoning(messageID: string, partID: string, delta: string) {
    const part = this.reasoning.get(messageID)?.get(partID)
    if (!part) return false
    this.setReasoning({
      id: partID,
      messageID,
      type: "reasoning",
      text: (part.text + delta.slice(0, MAX_TRANSCRIPT_DELTA_CHARS)).slice(0, MAX_REASONING_CHARS),
      time: part.time,
    })
    return true
  }

  appendPart(messageID: string, partID: string, delta: string) {
    if (!safeID(messageID) || !safeID(partID)) return
    if (this.hidden.get(messageID)?.has(partID)) return
    const parts = this.parts.get(messageID) ?? new Map<string, PartRecord>()
    const existing = parts.get(partID)
    if (this.deltasDisabled && !existing) return
    if (!existing && this.partCount >= MAX_TRANSCRIPT_PARTS) return
    const text = this.bound(messageID, partID, (existing?.text ?? "") + delta.slice(0, MAX_TRANSCRIPT_DELTA_CHARS))
    this.textLength += text.length - (existing?.text.length ?? 0)
    parts.set(partID, { text, snapshot: existing?.snapshot ?? false })
    if (!existing) this.partCount++
    this.parts.set(messageID, parts)
  }

  removeMessage(messageID: string) {
    const removed = this.messages.get(messageID)
    const turnID = removed?.role === "user" ? removed.id : removed?.parentID ?? removed?.id
    this.textLength = Math.max(0, this.textLength - this.messageLength(messageID))
    this.partCount -= this.parts.get(messageID)?.size ?? 0
    this.fileCount -= this.files.get(messageID)?.size ?? 0
    this.hiddenCount -= this.hidden.get(messageID)?.size ?? 0
    this.activityCount -= this.activities.get(messageID)?.items.size ?? 0
    this.messages.delete(messageID)
    this.reviews.remove(messageID)
    this.parts.delete(messageID)
    this.files.delete(messageID)
    this.hidden.delete(messageID)
    this.activities.delete(messageID)
    this.reasoning.delete(messageID)
    this.usagePartCount -= this.usage.get(messageID)?.size ?? 0
    this.usage.delete(messageID)
    this.turnKeys.delete(messageID)
    if (turnID && ![...this.messages.values()].some((message) =>
      (message.role === "user" ? message.id : message.parentID ?? message.id) === turnID
    )) this.turnKeys.delete(turnID)
  }

  removePart(messageID: string, partID: string) {
    const part = this.parts.get(messageID)?.get(partID)
    const file = this.files.get(messageID)?.has(partID) === true
    this.textLength = Math.max(0, this.textLength - (part?.text.length ?? 0))
    if (part && this.parts.get(messageID)?.delete(partID)) this.partCount--
    if (file && this.files.get(messageID)?.delete(partID)) this.fileCount--
    if (this.hidden.get(messageID)?.delete(partID)) this.hiddenCount--
    this.removeActivityItem(messageID, partID)
    this.reasoning.get(messageID)?.delete(partID)
    if (this.usage.get(messageID)?.delete(partID)) this.usagePartCount--
    if (this.usage.get(messageID)?.size === 0) this.usage.delete(messageID)
  }

  hidePart(messageID: string, partID: string) {
    if (!safeID(messageID) || !safeID(partID)) return
    const hidden = this.hidden.get(messageID) ?? new Set<string>()
    if (!hidden.has(partID)) {
      if (this.hiddenCount >= MAX_TRANSCRIPT_PARTS) {
        this.deltasDisabled = true
      } else {
        hidden.add(partID)
        this.hiddenCount++
      }
    }
    if (hidden.size) this.hidden.set(messageID, hidden)
    const part = this.parts.get(messageID)?.get(partID)
    this.textLength = Math.max(0, this.textLength - (part?.text.length ?? 0))
    if (part && this.parts.get(messageID)?.delete(partID)) this.partCount--
  }

  replace(messages: Array<{ info: MessageInfo; parts: Array<TextPart | FilePart | ToolPart | ReasoningPart | StepFinishPart> }>) {
    this.clear()
    const bounded = messages.slice(-MAX_TRANSCRIPT_MESSAGES)
    bounded.forEach((message) => {
      this.upsertMessage(message.info)
      message.parts.forEach((part) => {
        if ("type" in part && part.type === "reasoning") this.setReasoning(part)
        else if ("type" in part && part.type === "step-finish") this.setStepFinish(part)
        else if ("text" in part) this.setPart(part)
        else if ("tool" in part) this.setTool(part)
        else this.setFile(part)
      })
    })
    bounded.forEach((message) => {
      if (message.info.role === "user" && typeof message.info.summary === "object") {
        this.setReview(message.info.id, message.info.summary.diffs, false, true)
      }
    })
  }

  snapshot(): TranscriptMessage[] {
    const retryMessageID = this.retry
      ? [...this.messages.values()]
        .filter((message) => message.role === "assistant")
        .sort((a, b) => a.time.created - b.time.created)
        .at(-1)?.id
      : undefined
    return [...this.messages.values()]
      .sort((a, b) => a.time.created - b.time.created)
      .map((message) => {
        const attachments = [...(this.files.get(message.id)?.values() ?? [])]
        return {
          id: message.id,
          turnID: message.role === "user" ? message.id : message.parentID ?? message.id,
          role: message.role,
          createdAt: message.time.created,
          text: [...(this.parts.get(message.id)?.values() ?? [])]
            .map((part) => part.text)
            .join("\n\n")
            .slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS),
          ...(attachments.length ? { attachments } : {}),
          ...(message.response ? { response: message.response } : {}),
        }
      })
      .filter((message) => message.text.length > 0 || !!message.attachments?.length ||
        (message.role === "assistant" && (
          !!message.response || this.activities.get(message.id)?.items.size || message.id === retryMessageID
        )))
  }

  turnUsageSnapshot(): TurnUsage[] {
    const visibleTurns = new Set(this.snapshot().map((message) => message.turnID))
    const totals = new Map<string, UsageTotals[]>()
    ;[...this.messages.values()]
      .filter((message) => message.role === "assistant" && visibleTurns.has(message.parentID ?? message.id))
      .sort((a, b) => a.time.created - b.time.created)
      .forEach((message) => {
        const steps = [...(this.usage.get(message.id)?.values() ?? [])]
        if (!steps.length) return
        const turnID = message.parentID ?? message.id
        totals.set(turnID, [...(totals.get(turnID) ?? []), ...steps])
      })
    return [...totals].flatMap(([turnID, steps]) => {
      const cost = addCosts(steps.flatMap((step) => step.cost === undefined ? [] : [step.cost]))
      const tokens = addUsageTokens(steps.flatMap((step) => step.tokens ? [step.tokens] : []))
      if (cost === undefined && !tokens) return []
      return [{ turnID, ...(cost === undefined ? {} : { cost }), ...(tokens ? { tokens } : {}) }]
    })
  }

  reviewSnapshot(): ReviewSummary[] {
    return this.reviews.snapshot()
  }

  hasReview(messageID: string) {
    return this.reviews.has(messageID)
  }

  latestUserID() {
    return [...this.messages.values()]
      .filter((message) => message.role === "user")
      .sort((a, b) => b.time.created - a.time.created)[0]?.id
  }

  setReview(messageID: string, diffs: FileDiff[], includeTouchedWithoutDiff = false, patchesAuthoritative = true) {
    const message = this.messages.get(messageID)
    if (!message || message.role !== "user") return
    const touched = this.toolTouchedPaths(messageID)
    this.reviews.upsert(
      { ...message, summary: { diffs } },
      diffs.length || includeTouchedWithoutDiff ? touched : [],
      patchesAuthoritative,
    )
  }

  private toolTouchedPaths(turnID: string) {
    const paths = new Set<string>()
    ;[...this.messages.values()]
      .filter((message) => message.role === "assistant" && message.parentID === turnID)
      .forEach((message) => {
        this.activities.get(message.id)?.items.forEach((item) => {
          if (item.kind !== "edit" || item.status !== "completed") return
          item.files?.forEach((file) => paths.add(file.path))
        })
      })
    return [...paths]
  }

  activitySnapshot(): TurnActivity[] {
    const assistants = [...this.messages.values()].filter((message) => message.role === "assistant").sort((a, b) => a.time.created - b.time.created)
    const retryMessageID = this.retry ? assistants.at(-1)?.id : undefined
    return assistants.flatMap((message) => {
      const activity = this.activities.get(message.id)
      if (!activity?.items.size && message.id !== retryMessageID) return []
      const items = [...(activity?.items.values() ?? [])]
      const turnID = message.parentID ?? message.id
      const startedAt = Math.min(message.time.created, ...items.flatMap((item) => item.startedAt === undefined ? [] : [item.startedAt]))
      const failed = !!message.error?.name && message.error.name !== "MessageAbortedError"
      const interrupted = message.error?.name === "MessageAbortedError"
      const working = !message.time.completed && !failed && !interrupted
      const endedAt = working ? undefined : message.time.completed
      const files = new Set(items.flatMap((item) => item.files?.map((file) => file.path) ?? []))
      const retry = message.id === retryMessageID ? this.retry : undefined
      const status = retry ? "retrying" : working ? "working" : interrupted ? "interrupted" : failed ? "failed" : "completed"
      const key = activity?.key ?? this.turnKeys.get(message.id) ?? opaqueKey()
      this.turnKeys.set(message.id, key)
      return [{
        key,
        turnID,
        messageID: message.id,
        status,
        ...(retry ? { retry } : {}),
        startedAt,
        endedAt,
        actionCount: items.length,
        changedFileCount: files.size,
        truncated: activity?.truncated ?? false,
        items,
      } satisfies TurnActivity]
    }).slice(-MAX_ACTIVITY_PHASES)
  }

  resolveReview(reviewKey: string, fileKey: string) {
    return this.reviews.resolve(reviewKey, fileKey)
  }

  private bound(messageID: string, partID: string, value: string) {
    const existing = this.parts.get(messageID)?.get(partID)?.text.length ?? 0
    const messageAvailable = Math.max(0, MAX_TRANSCRIPT_MESSAGE_CHARS - (this.messageLength(messageID) - existing))
    const totalAvailable = Math.max(0, MAX_TRANSCRIPT_TOTAL_CHARS - (this.textLength - existing))
    return value.slice(0, Math.min(messageAvailable, totalAvailable))
  }

  private messageLength(messageID: string) {
    return [...(this.parts.get(messageID)?.values() ?? [])].reduce((total, part) => total + part.text.length, 0)
  }

  private setActivityItem(messageID: string, partID: string, item: ActivityItem) {
    const activity = this.activities.get(messageID) ?? {
      key: this.turnKeys.get(messageID) ?? opaqueKey(),
      items: new Map<string, ActivityItem>(),
      truncated: false,
    }
    const existing = activity.items.has(partID)
    if (!existing && activity.items.size >= MAX_ACTIVITY_ITEMS_PER_PHASE) {
      const removable = [...activity.items.entries()].find(([, value]) => value.status === "completed")
      if (removable) {
        activity.items.delete(removable[0])
        this.activityCount--
      } else {
        activity.truncated = true
        this.activities.set(messageID, activity)
        return
      }
      activity.truncated = true
    }
    if (!existing && this.activityCount >= MAX_ACTIVITY_ITEMS) {
      const removable = [...this.activities.values()].flatMap((value) =>
        [...value.items.entries()].map(([key, item]) => ({ value, key, item })),
      ).find((entry) => entry.item.status === "completed")
      if (!removable) {
        activity.truncated = true
        this.activities.set(messageID, activity)
        return
      }
      removable.value.items.delete(removable.key)
      removable.value.truncated = true
      this.activityCount--
    }
    activity.items.set(partID, item)
    if (!existing) this.activityCount++
    this.activities.set(messageID, activity)
  }

  private removeActivityItem(messageID: string, partID: string) {
    const activity = this.activities.get(messageID)
    if (!activity?.items.delete(partID)) return
    this.activityCount--
    if (!activity.items.size && !activity.truncated) this.activities.delete(messageID)
  }

  private activityItemKey(messageID: string, partID: string) {
    return this.activities.get(messageID)?.items.get(partID)?.key ?? opaqueKey()
  }
}

function safeFilename(value: string | undefined) {
  if (!value) return
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�")
    .replaceAll("\\", "/")
    .trim()
  const filename = (/^(?:\/|[A-Za-z]:\/)/.test(normalized) || normalized.split("/").includes("..")
    ? normalized.split("/").filter(Boolean).at(-1) ?? "file"
    : normalized).slice(0, 240)
  return filename || undefined
}

function safeID(value: string) {
  return value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function toolActivity(part: ToolPart, directory?: string): ActivityItem {
  const state = record(part.state) ?? {}
  const input = record(state.input) ?? {}
  const metadata = record(state.metadata) ?? {}
  const status = activityStatus(part.state.status, typeof state.error === "string" ? state.error : undefined)
  const time = record(state.time) ?? {}
  const base = {
    key: opaqueKey(),
    status,
    startedAt: finiteNumber(time.start),
    endedAt: finiteNumber(time.end),
  }
  if (part.tool === "bash" || part.tool === "shell") return {
    ...base, kind: "command", title: "Ran command", detail: safeCommand(input.command),
  }
  if (part.tool === "read") return {
    ...base, kind: "read", title: `Read ${safePath(input.filePath, directory) ?? "a file"}`,
  }
  if (part.tool === "glob" || part.tool === "grep" || part.tool === "list") {
    const pattern = safeText(input.pattern, 240)
    const location = safePath(input.path, directory)
    const count = finiteCount(metadata[part.tool === "grep" ? "matches" : "count"])
    return {
      ...base,
      kind: "search",
      title: pattern ? `Searched “${pattern}”${location ? ` in ${location}` : ""}` : "Searched the workspace",
      detail: count === undefined ? undefined : `${count} ${count === 1 ? "match" : "matches"}`,
    }
  }
  if (part.tool === "webfetch" || part.tool === "websearch") return {
    ...base,
    kind: "web",
    title: part.tool === "webfetch" ? "Fetched from the web" : "Searched the web",
    detail: part.tool === "webfetch" ? safeURL(input.url) : safeText(input.query, 500),
  }
  if (part.tool === "edit" || part.tool === "write") {
    const filePath = safePath(input.filePath, directory)
    const filediff = record(metadata.filediff)
    const file = filePath ? activityFile(filePath, filediff) : undefined
    return { ...base, kind: "edit", title: `${part.tool === "write" ? "Wrote" : "Edited"} ${filePath ?? "a file"}`, files: file ? [file] : undefined }
  }
  if (part.tool === "apply_patch") {
    const files = Array.isArray(metadata.files) ? metadata.files.slice(0, 20).flatMap((value) => {
      const file = record(value)
      const filePath = safePath(file?.relativePath, directory)
      return filePath ? [activityFile(filePath, file)] : []
    }) : []
    return { ...base, kind: "edit", title: files.length === 1 ? `Patched ${files[0]!.path}` : `Patched ${files.length || "workspace"} files`, files: files.length ? files : undefined }
  }
  if (part.tool === "task") return {
    ...base, kind: "task", title: "Ran a subagent", detail: safeText(input.description, 500),
  }
  if (part.tool === "question") return { ...base, kind: "question", title: "Asked a question" }
  if (part.tool === "todowrite" || part.tool === "todoread") return { ...base, kind: "todo", title: "Updated tasks" }
  const name = safeText(part.tool, 80)
  return { ...base, kind: "tool", title: name ? `Used ${name}` : "Used a tool", detail: safeText(state.title, 500) }
}

function activityStatus(status: ToolPart["state"]["status"], error?: string): ActivityItem["status"] {
  if (status === "pending") return "waiting"
  if (status === "running") return "running"
  if (status === "completed") return "completed"
  if (error?.includes("rejected permission") || error?.includes("QuestionRejectedError") || error?.includes("user dismissed")) return "denied"
  return "failed"
}

function activityFile(path: string, value?: Record<string, unknown>) {
  const additions = finiteCount(value?.additions)
  const deletions = finiteCount(value?.deletions)
  return { key: opaqueKey(), path, additions, deletions }
}

function reasoningSummary(value: string) {
  const match = value.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: undefined, body: value }
  return { title: safeText(match[1], 120), body: value.slice(match[0].length).trimEnd() }
}

function compactResponse(value: ResponseMetadata) {
  const response: ResponseMetadata = {}
  if (value.completedAt !== undefined) response.completedAt = value.completedAt
  if (value.agent !== undefined) response.agent = value.agent
  if (value.providerID !== undefined) response.providerID = value.providerID
  if (value.modelID !== undefined) response.modelID = value.modelID
  if (value.variant !== undefined) response.variant = value.variant
  if (value.cost !== undefined) response.cost = value.cost
  if (value.contextTokens !== undefined) response.contextTokens = value.contextTokens
  return Object.keys(response).length ? response : undefined
}

function safeCompleted(value: unknown, created: number) {
  return Number.isSafeInteger(value) && Number(value) >= created && Number(value) <= 8_640_000_000_000_000
    ? Number(value)
    : undefined
}

function safeMetadata(value: unknown, maximum: number) {
  return safeText(value, maximum)
}

function safePath(value: unknown, directory?: string) {
  const text = safeText(value, 512)?.replaceAll("\\", "/")
  if (!text) return
  const absolute = path.isAbsolute(text) || /^[A-Za-z]:\//.test(text)
  const normalized = absolute && directory ? path.relative(directory, text).replaceAll("\\", "/") : text
  if (absolute && !directory) return
  const parts = normalized.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) return
  return normalized
}

function safeURL(value: unknown) {
  const text = safeText(value, 1_000)
  if (!text) return
  try {
    const url = new URL(text)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {}
}

function safeCommand(value: unknown) {
  const command = safeText(value, 1_000)
  if (!command) return
  return command
    .replace(/("(?:(?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)[^"]*"/giu, '$1<redacted>"')
    .replace(/('(?:(?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)[^']*'/giu, "$1<redacted>'")
    .replace(/((?:(?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)(?:(?:basic|bearer)\s+)?[^\s"']+/giu, "$1<redacted>")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|authorization)\s*=\s*)(?:'[^']*'|"[^"]*"|[^\s]+)/giu, "$1<redacted>")
    .replace(/(\s--?(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|authorization)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s]+)/giu, "$1<redacted>")
    .replace(/(\s(?:-u|--user)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s]+)/giu, "$1<redacted>")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1<redacted>@")
}

function safeText(value: unknown, maximum: number) {
  if (typeof value !== "string") return
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�").trim().slice(0, maximum)
  return text || undefined
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function finiteCount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000 ? Number(value) : undefined
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function opaqueKey() {
  return randomBytes(18).toString("base64url")
}
