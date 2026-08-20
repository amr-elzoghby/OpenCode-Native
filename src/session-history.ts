import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { MAX_HISTORY_SESSIONS, type HistorySession } from "./protocol"
import { projectUsage, type UsageTotals } from "./usage"

const MAX_HISTORY_SCAN = 1_000
const MAX_RAW_TITLE = 10_000
const MAX_DIRECTORY = 4_096

export type SessionInfo = {
  id: string
  directory: string
  title: string
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  revert?: { messageID: string }
  usage?: UsageTotals
  time: { created: number; updated: number; archived?: number }
}

export class SessionHistory {
  private sessions = new Map<string, SessionInfo>()
  private directory: string

  constructor(directory: string, private createKey: () => string = () => randomBytes(18).toString("base64url")) {
    this.directory = normalizeDirectory(directory)
  }

  replace(value: unknown, statuses: unknown, currentID?: string) {
    const statusMap = record(statuses)
    const next = new Map<string, SessionInfo>()
    const candidates = array(value)
      .slice(0, MAX_HISTORY_SCAN)
      .flatMap((item) => {
        const session = parseSession(item)
        if (!session || !this.accepts(session)) return []
        return [{ session, status: historyStatus(record(statusMap?.[session.id])?.type) }]
      })
      .sort((a, b) => b.session.time.updated - a.session.time.updated)
      .slice(0, MAX_HISTORY_SESSIONS)
    const projected = candidates.map(({ session, status }) => {
      const key = uniqueKey(next, this.createKey)
      next.set(key, session)
      return {
          key,
          title: safeSessionTitle(redactDirectory(session.title, session.directory, this.directory)),
          updated: session.time.updated,
          current: session.id === currentID,
          status,
        } satisfies HistorySession
    })
    this.sessions = next
    return projected
  }

  resolve(key: string) {
    return this.sessions.get(key)
  }

  displayTitle(key: string) {
    const session = this.sessions.get(key)
    return session ? safeSessionTitle(redactDirectory(session.title, session.directory, this.directory)) : undefined
  }

  accepts(session: SessionInfo) {
    return !session.parentID && session.time.archived === undefined &&
      normalizeDirectory(session.directory) === this.directory
  }
}

export class RequestGeneration {
  private generation = 0

  begin() {
    return ++this.generation
  }

  accepts(generation: number) {
    return generation === this.generation
  }

  invalidate() {
    this.generation++
  }
}

export function parseSession(value: unknown): SessionInfo | undefined {
  const session = record(value)
  const time = record(session?.time)
  if (
    !session ||
    !safeRecordID(session.id) ||
    !safeDirectory(session.directory) ||
    typeof session.title !== "string" || session.title.length > MAX_RAW_TITLE ||
    !time ||
    !safeTime(time.created) ||
    !safeTime(time.updated) ||
    (time.archived !== undefined && !safeTime(time.archived)) ||
    (session.parentID !== undefined && !safeRecordID(session.parentID)) ||
    (session.agent !== undefined && !safeRecordID(session.agent))
  ) return
  const model = record(session.model)
  const revert = record(session.revert)
  const usage = projectUsage(session.cost, session.tokens)
  if (session.revert !== undefined && (!revert || !safeRecordID(revert.messageID))) return
  if (session.model !== undefined && (!model || !safeRecordID(model.id) || !safeRecordID(model.providerID) ||
    (model.variant !== undefined && !safeRecordID(model.variant)))) return
  return {
    id: session.id,
    directory: session.directory,
    title: session.title,
    parentID: session.parentID as string | undefined,
    agent: session.agent as string | undefined,
    model: model
      ? {
        id: model.id as string,
        providerID: model.providerID as string,
        variant: model.variant as string | undefined,
      }
      : undefined,
    revert: revert ? { messageID: revert.messageID as string } : undefined,
    ...(usage.cost === undefined && !usage.tokens ? {} : { usage }),
    time: {
      created: time.created,
      updated: time.updated,
      archived: time.archived as number | undefined,
    },
  }
}

export function sameSessionVersion(first: SessionInfo, second: SessionInfo) {
  return first.id === second.id && first.time.updated === second.time.updated
}

function safeRecordID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function safeDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_DIRECTORY &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000
}

function historyStatus(value: unknown): HistorySession["status"] {
  return value === "idle" || value === "busy" || value === "retry" ? value : undefined
}

export function normalizeDirectory(value: string) {
  const normalized = resolve(value)
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized
}

export function safeSessionTitle(value: string) {
  const title = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
  return title || "Untitled chat"
}

export function proposedSessionTitle(value: string) {
  if (value.length > 120 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) return
  const title = value.replace(/\s+/g, " ").trim()
  if (!title) return
  return title
}

function redactDirectory(value: string, raw: string, normalized: string) {
  return [raw, normalized]
    .filter((directory, index, directories) => directory.length > 0 && directories.indexOf(directory) === index)
    .reduce((title, directory) => title.replace(
      new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), process.platform === "win32" ? "gi" : "g"),
      "<workspace>",
    ), value)
}

function uniqueKey(sessions: Map<string, SessionInfo>, createKey: () => string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = createKey()
    if (/^[A-Za-z0-9_-]{16,128}$/.test(key) && !sessions.has(key)) return key
  }
  throw new Error("OpenCode could not create a safe session selection key.")
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}
