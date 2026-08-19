import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import type { HistorySession } from "./protocol"

export type SessionInfo = {
  id: string
  directory: string
  title: string
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  revert?: { messageID: string }
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
    const projected = array(value)
      .flatMap((item) => {
        const session = parseSession(item)
        if (!session || !this.accepts(session)) return []
        const key = uniqueKey(next, this.createKey)
        next.set(key, session)
        const status = record(statusMap?.[session.id])?.type
        return [{
          key,
          title: safeSessionTitle(redactDirectory(session.title, session.directory, this.directory)),
          updated: session.time.updated,
          current: session.id === currentID,
          status: status === "idle" || status === "busy" || status === "retry" ? status : undefined,
        } satisfies HistorySession]
      })
      .sort((a, b) => b.updated - a.updated)
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
    typeof session.id !== "string" ||
    typeof session.directory !== "string" ||
    typeof session.title !== "string" ||
    !time ||
    typeof time.created !== "number" ||
    typeof time.updated !== "number"
  ) return
  const model = record(session.model)
  const revert = record(session.revert)
  if (session.revert !== undefined && (!revert || !safeRecordID(revert.messageID))) return
  return {
    id: session.id,
    directory: session.directory,
    title: session.title,
    parentID: typeof session.parentID === "string" ? session.parentID : undefined,
    agent: typeof session.agent === "string" ? session.agent : undefined,
    model: model && typeof model.id === "string" && typeof model.providerID === "string"
      ? {
        id: model.id,
        providerID: model.providerID,
        variant: typeof model.variant === "string" ? model.variant : undefined,
      }
      : undefined,
    revert: revert ? { messageID: revert.messageID as string } : undefined,
    time: {
      created: time.created,
      updated: time.updated,
      archived: typeof time.archived === "number" ? time.archived : undefined,
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
