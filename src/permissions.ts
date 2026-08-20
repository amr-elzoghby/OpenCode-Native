import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { redactCommand } from "./redaction"
import { reviewDocument } from "./review"

const MAX_REQUESTS = 20
const MAX_PATTERNS = 10

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  always: string[]
  metadata?: Record<string, unknown>
  tool?: { messageID: string; callID: string }
}

export type PermissionPrompt = {
  key: string
  title: string
  details: string[]
  files: Array<{ key: string; path: string }>
}

type StoredPermission = PermissionPrompt & {
  requestID: string
  sessionID: string
  fingerprint: string
  directory?: string
  documents: Map<string, { path: string; before: string; after: string }>
}

export class PermissionStore {
  private records = new Map<string, StoredPermission>()

  constructor(private createKey: () => string = () => randomBytes(18).toString("base64url")) {}

  clear() {
    this.records.clear()
  }

  upsert(request: PermissionRequest, sessionID: string, directory?: string) {
    if (request.sessionID !== sessionID || !safeID(request.id)) return
    const permission = safeText(request.permission, 120)
    if (!permission || !safeList(request.patterns) || !safeList(request.always)) return
    const context = permissionContext(permission, request, directory)
    const metadataHash = permissionMetadataHash(permission, request)
    if (!metadataHash) return
    const existing = this.records.get(request.id)
    const requestFingerprint = fingerprint(request, context, metadataHash)
    if (existing?.fingerprint === requestFingerprint) return
    const documents = permissionDocuments(permission, request, this.createKey)
    this.records.set(request.id, {
      key: this.createKey(),
      requestID: request.id,
      sessionID,
      title: context.title,
      details: context.details,
      files: [...documents.values()].map(({ key, document }) => ({ key, path: document.path })),
      fingerprint: requestFingerprint,
      directory,
      documents: new Map([...documents.values()].map(({ key, document }) => [key, document])),
    })
    while (this.records.size > MAX_REQUESTS) this.records.delete(this.records.keys().next().value!)
  }

  remove(requestID: string) {
    this.records.delete(requestID)
  }

  snapshot(): PermissionPrompt[] {
    return [...this.records.values()].map((item) => ({
      key: item.key,
      title: item.title,
      details: [...item.details],
      files: item.files.map((file) => ({ ...file })),
    }))
  }

  resolve(key: string) {
    const item = [...this.records.values()].find((record) => record.key === key)
    return item ? { requestID: item.requestID, sessionID: item.sessionID, fingerprint: item.fingerprint } : undefined
  }

  matches(key: string, request: PermissionRequest) {
    const item = [...this.records.values()].find((record) => record.key === key)
    const permission = safeText(request.permission, 120)
    const metadataHash = permission ? permissionMetadataHash(permission, request) : undefined
    return !!item && !!permission && item.requestID === request.id && item.sessionID === request.sessionID &&
      !!metadataHash && item.fingerprint === fingerprint(request, permissionContext(permission, request, item.directory), metadataHash)
  }

  resolveReview(reviewKey: string, fileKey: string) {
    const item = [...this.records.values()].find((record) => record.key === reviewKey)
    const document = item?.documents.get(fileKey)
    return document ? { ...document } : undefined
  }
}

function permissionDocuments(permission: string, request: PermissionRequest, createKey: () => string) {
  const result = new Map<string, { key: string; document: { path: string; before: string; after: string } }>()
  if (!["edit", "write", "apply_patch"].includes(permission)) return result
  const metadata = record(request.metadata)
  const files = Array.isArray(metadata.files) ? metadata.files.slice(0, 20).map(record) : []
  if (!files.length && typeof metadata.diff === "string") files.push({ filePath: metadata.filepath, relativePath: metadata.filepath, patch: metadata.diff })
  files.forEach((file) => {
    const candidate = safeRelativePath(file.relativePath ?? file.filePath)
    if (!candidate || result.has(candidate) || typeof file.patch !== "string") return
    const document = reviewDocument({ file: candidate, patch: file.patch, additions: 0, deletions: 0 }, candidate)
    if (!document) return
    result.set(candidate, { key: createKey(), document })
  })
  return result
}

function permissionContext(permission: string, request: PermissionRequest, directory?: string) {
  const metadata = record(request.metadata)
  const input = { ...metadata, ...record(metadata.input) }
  const patterns = request.patterns.slice(0, 4)
  if (permission === "bash" || permission === "shell") {
    const command = safeCommand(input.command)
    return { title: "Run command", details: command ? [command] : [] }
  }
  if (permission === "external_directory") {
    const target = safePath(input.parentDir ?? input.filepath ?? patterns[0], directory)
    const scopes = patterns.flatMap((value) => safePath(value, directory) ? [`Scope: ${safePath(value, directory)}`] : [])
    return { title: "Access external directory", details: [...(target ? [target] : []), ...scopes] }
  }
  if (["edit", "write", "apply_patch"].includes(permission)) {
    return { title: "Edit files", details: patterns.flatMap((value) => safePath(value, directory) ? [safePath(value, directory)!] : []) }
  }
  if (permission === "read" || permission === "list") {
    const target = safePath(input.filePath ?? input.path ?? patterns[0], directory)
    return { title: permission === "read" ? "Read path" : "List directory", details: target ? [target] : [] }
  }
  if (permission === "glob" || permission === "grep") {
    const pattern = safeTextValue(input.pattern ?? patterns[0], 1_000)
    return { title: permission === "glob" ? "Search files" : "Search text", details: pattern ? [`Pattern: ${pattern}`] : [] }
  }
  if (permission === "webfetch") {
    const url = safeURL(input.url)
    return { title: "Fetch URL", details: url ? [url] : [] }
  }
  if (permission === "websearch") {
    const query = safeTextValue(input.query, 1_000)
    return { title: "Search the web", details: query ? [`Query: ${query}`] : [] }
  }
  if (permission === "task") {
    const type = safeTextValue(input.subagent_type, 120)
    const description = safeTextValue(input.description, 1_000)
    return { title: type ? `Start ${type} subagent` : "Start a subagent", details: description ? [description] : [] }
  }
  if (permission === "lsp") {
    const operation = safeTextValue(input.operation, 120)
    const file = safePath(input.filePath, directory)
    return { title: "Use language service", details: [...(operation ? [`Operation: ${operation}`] : []), ...(file ? [file] : [])] }
  }
  if (permission === "doom_loop") return { title: "Continue after repeated failures", details: ["This keeps the session running despite repeated failures."] }
  return { title: `Use ${permission}`, details: [] }
}

function fingerprint(request: PermissionRequest, context: { title: string; details: string[] }, metadataHash: string) {
  return JSON.stringify([request.id, request.sessionID, request.permission, request.patterns, request.always, request.tool, context, metadataHash])
}

function permissionMetadataHash(permission: string, request: PermissionRequest) {
  const metadata = record(request.metadata)
  const input = { ...metadata, ...record(metadata.input) }
  const selected: Record<string, unknown> = {}
  const keys = ["command", "parentDir", "filepath", "filePath", "path", "pattern", "url", "query", "subagent_type", "description", "operation", "line", "character"]
  keys.forEach((key) => { if (key in input) selected[key] = input[key] })
  if (["edit", "write", "apply_patch"].includes(permission)) {
    selected.diff = metadata.diff
    selected.files = Array.isArray(metadata.files) ? metadata.files.slice(0, 20).map((value) => {
      const file = record(value)
      return { relativePath: file.relativePath, filePath: file.filePath, movePath: file.movePath, type: file.type, patch: file.patch }
    }) : undefined
  }
  let value: string
  try {
    value = JSON.stringify(selected)
  } catch {
    return
  }
  if (value.length > 2_000_000) return
  return createHash("sha256").update(value).digest("base64url")
}

function safeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PATTERNS && value.every((item) => typeof item === "string" && item.length <= 2_000)
}

function safeText(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length > maximum * 4) return
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�").trim().slice(0, maximum)
  return text || undefined
}

function safeTextValue(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum * 4 ? safeText(value, maximum) : undefined
}

function safePath(value: unknown, directory?: string) {
  const text = safeTextValue(value, 1_000)?.replaceAll("\\", "/")
  if (!text) return
  if (!directory || !path.isAbsolute(text)) return text
  const relative = path.relative(directory, text).replaceAll("\\", "/")
  return relative && !relative.startsWith("../") && relative !== ".." ? relative : text
}

function safeRelativePath(value: unknown) {
  const text = safeTextValue(value, 512)?.replaceAll("\\", "/")
  if (!text || path.isAbsolute(text) || /^[A-Za-z]:\//.test(text)) return
  const parts = text.split("/")
  return parts.some((part) => !part || part === "." || part === "..") ? undefined : text
}

function safeURL(value: unknown) {
  const text = safeTextValue(value, 2_000)
  if (!text) return
  try {
    const url = new URL(text)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return
  }
}

function safeCommand(value: unknown) {
  const command = safeTextValue(value, 2_000)
  if (!command) return
  return redactCommand(command, "[redacted]")
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function safeID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}
