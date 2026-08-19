import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { MAX_LOCAL_FILE_BYTES } from "./protocol"

export const MAX_ATTACHMENT_BYTES = 256 * 1024
export const MAX_ATTACHMENT_TOTAL_BYTES = 1024 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_MEDIA_TOTAL_BYTES = 50 * 1024 * 1024
export const MAX_IMAGES = 4
export const MAX_ATTACHMENTS = 20

export type AttachmentChip = {
  id: string
  kind: "file" | "selection" | "image"
  label: string
  range?: { start: number; end: number }
}

export type PromptFilePart = {
  type: "file"
  mime: string
  filename: string
  url: string
}

type AttachmentRecord = AttachmentChip & {
  path?: string
  canonical?: string
  content: string | Buffer
  mime: string
  bytes: number
}

type AttachmentStoreOptions = {
  createID?: () => string
  afterOpen?: (path: string) => Promise<void>
}

export class AttachmentError extends Error {}

export class AttachmentStore {
  private attachments = new Map<string, AttachmentRecord>()
  private directory: string
  private generation = 0
  private mutation: Promise<void> = Promise.resolve()

  constructor(directory: string, private options: AttachmentStoreOptions = {}) {
    this.directory = resolve(directory)
  }

  boundDirectory() {
    return this.directory
  }

  snapshot(): AttachmentChip[] {
    return [...this.attachments.values()].map((item) => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      range: item.range,
    }))
  }

  async addFiles(paths: string[]) {
    const generation = this.generation
    return this.serialize(async () => {
      if (!paths.length || generation !== this.generation) return this.snapshot()
      if (paths.length > MAX_ATTACHMENTS - this.attachments.size) {
        throw new AttachmentError(`OpenCode supports up to ${MAX_ATTACHMENTS} context attachments.`)
      }
      const records = await Promise.all(paths.map((path) => this.read(path, "file")))
      if (generation !== this.generation) return this.snapshot()
      const unique = records.filter((record, index) =>
        records.findIndex((item) => item.canonical === record.canonical) === index &&
        ![...this.attachments.values()].some((item) => item.canonical === record.canonical && item.kind === "file"),
      )
      if (new Set(unique.map((record) => record.id)).size !== unique.length) {
        throw new AttachmentError("OpenCode could not create a safe attachment reference.")
      }
      this.requireCapacity(unique)
      unique.forEach((record) => this.attachments.set(record.id, record))
      return this.snapshot()
    })
  }

  async addImages(paths: string[]) {
    const generation = this.generation
    return this.serialize(async () => {
      if (!paths.length || generation !== this.generation) return this.snapshot()
      if (paths.length > MAX_IMAGES) throw new AttachmentError(`OpenCode supports up to ${MAX_IMAGES} images.`)
      const records = await Promise.all(paths.map((path) => this.readImage(path)))
      if (generation !== this.generation) return this.snapshot()
      const unique = records.filter((record, index) =>
        records.findIndex((item) => item.canonical === record.canonical) === index &&
        ![...this.attachments.values()].some((item) => item.canonical === record.canonical && item.kind === "image"),
      )
      if (new Set(unique.map((record) => record.id)).size !== unique.length) {
        throw new AttachmentError("OpenCode could not create a safe image reference.")
      }
      this.requireCapacity(unique)
      unique.forEach((record) => this.attachments.set(record.id, record))
      return this.snapshot()
    })
  }

  async addLocalUpload(name: string, requestedMime: string, data: string) {
    const generation = this.generation
    return this.serialize(async () => {
      if (generation !== this.generation) return this.snapshot()
      if (this.attachments.size >= MAX_ATTACHMENTS) {
        throw new AttachmentError(`OpenCode supports up to ${MAX_ATTACHMENTS} context attachments.`)
      }
      const content = decodeUpload(data)
      const mime = localUploadMime(name, requestedMime, content)
      if (mime === "text/plain" && content.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentError("That text file is larger than 256 KiB.")
      }
      if (mime.startsWith("image/") && content.byteLength > MAX_IMAGE_BYTES) {
        throw new AttachmentError("That image is larger than 5 MiB.")
      }
      if (content.byteLength > MAX_LOCAL_FILE_BYTES) {
        throw new AttachmentError("That file is larger than 25 MiB.")
      }
      const id = this.createID()
      const record: AttachmentRecord = {
        id,
        kind: mime.startsWith("image/") ? "image" : "file",
        label: uploadLabel(name),
        content,
        mime,
        bytes: content.byteLength,
      }
      this.requireCapacity([record])
      if (generation !== this.generation) return this.snapshot()
      this.attachments.set(id, record)
      return this.snapshot()
    })
  }

  async addSnapshot(
    path: string,
    content: string,
    kind: Exclude<AttachmentChip["kind"], "image">,
    range?: AttachmentChip["range"],
  ) {
    const generation = this.generation
    return this.serialize(async () => {
      if (generation !== this.generation) return this.snapshot()
      const file = await this.requireFile(path)
      const bytes = Buffer.byteLength(content)
      if (bytes > MAX_ATTACHMENT_BYTES) throw new AttachmentError("That context item is larger than 256 KiB.")
      const record = this.record(file.path, file.canonical, content, bytes, kind, "text/plain", range)
      if (generation !== this.generation) return this.snapshot()
      this.requireCapacity([record])
      this.attachments.set(record.id, record)
      return this.snapshot()
    })
  }

  remove(id: string) {
    const removed = this.attachments.delete(id)
    if (removed) this.generation++
    return removed
  }

  removeMany(ids: string[]) {
    const removed = ids.map((id) => this.attachments.delete(id)).some(Boolean)
    if (removed) this.generation++
  }

  clear() {
    this.generation++
    this.attachments.clear()
  }

  async resolve(ids: string[], imageInput = false): Promise<PromptFilePart[]> {
    const generation = this.generation
    return this.serialize(async () => {
      if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) {
        throw new AttachmentError("The attachment selection is invalid.")
      }
      const records = ids.map((id) => this.attachments.get(id))
      if (records.some((item) => !item)) throw new AttachmentError("A context attachment is no longer available.")
      const attachments = records.filter((item): item is AttachmentRecord => !!item)
      if (!imageInput && attachments.some((item) => item.kind === "image")) {
        throw new AttachmentError("The selected model does not support image input.")
      }
      const files = await Promise.all(attachments.map((item) => item.path ? this.requireFile(item.path) : undefined))
      if (generation !== this.generation || attachments.some((item) => this.attachments.get(item.id) !== item)) {
        throw new AttachmentError("The context attachments changed before the prompt was sent.")
      }
      if (files.some((file, index) => file && file.size > (attachments[index]?.kind === "image" ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES))) {
        throw new AttachmentError("A context attachment is now larger than its allowed limit.")
      }
      this.requireTotals(attachments)
      return attachments.map((item) => ({
        type: "file" as const,
        mime: item.mime,
        filename: item.range ? `${item.label}:${item.range.start}-${item.range.end}` : item.label,
        url: `data:${item.mime};base64,${Buffer.from(item.content).toString("base64")}`,
      }))
    })
  }

  private async read(path: string, kind: Exclude<AttachmentChip["kind"], "image">) {
    const file = await this.requireFile(path)
    if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("That file is larger than 256 KiB.")
    const handle = await open(file.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW))
      .catch(() => { throw new AttachmentError("That context file changed while OpenCode was reading it.") })
    const content = await this.readOpenFile(handle, file, MAX_ATTACHMENT_BYTES).finally(() => handle.close())
    if (content.includes(0)) throw new AttachmentError("Only UTF-8 text files can be attached in this milestone.")
    const text = decodeText(content)
    return this.record(file.path, file.canonical, text, content.byteLength, kind, "text/plain")
  }

  private async readImage(path: string) {
    const file = await this.requireFile(path)
    if (file.size > MAX_IMAGE_BYTES) throw new AttachmentError("That image is larger than 5 MiB.")
    const handle = await open(file.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW))
      .catch(() => { throw new AttachmentError("That image changed while OpenCode was reading it.") })
    const content = await this.readOpenFile(handle, file, MAX_IMAGE_BYTES).finally(() => handle.close())
    const mime = imageMime(content)
    if (!mime) throw new AttachmentError("Only PNG, JPEG, GIF, and WebP images are supported.")
    return this.record(file.path, file.canonical, content, content.byteLength, "image", mime)
  }

  private async readOpenFile(
    handle: FileHandle,
    file: Awaited<ReturnType<AttachmentStore["requireFile"]>>,
    maximum: number,
  ) {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(file, opened)) throw new AttachmentError("That context file changed while OpenCode was reading it.")
    const content = await readBounded(handle, maximum)
    await this.options.afterOpen?.(file.path)
    const confirmed = await readBounded(handle, maximum)
    const current = await this.requireFile(file.path)
    const final = await handle.stat()
    if (!content.equals(confirmed) || current.canonical !== file.canonical || !sameFile(opened, current) || !sameFile(opened, final)) {
      throw new AttachmentError("That context file changed while OpenCode was reading it.")
    }
    return content
  }

  private record(
    path: string,
    canonical: string,
    content: string | Buffer,
    bytes: number,
    kind: AttachmentChip["kind"],
    mime: string,
    range?: AttachmentChip["range"],
  ): AttachmentRecord {
    const id = this.createID()
    return {
      id,
      kind,
      label: safeLabel(relative(this.directory, path)),
      range,
      path,
      canonical,
      content,
      mime,
      bytes,
    }
  }

  private createID() {
    const id = (this.options.createID ?? (() => randomBytes(18).toString("base64url")))()
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id) || this.attachments.has(id)) {
      throw new AttachmentError("OpenCode could not create a safe attachment reference.")
    }
    return id
  }

  private async requireFile(path: string) {
    const candidate = resolve(path)
    if (!contains(this.directory, candidate)) throw new AttachmentError("Only files inside the current workspace can be attached.")
    await rejectSymlinks(this.directory, candidate)
    const [root, canonical, metadata] = await Promise.all([realpath(this.directory), realpath(candidate), stat(candidate)])
    if (!contains(root, canonical)) throw new AttachmentError("Only files inside the current workspace can be attached.")
    if (!metadata.isFile()) throw new AttachmentError("Only regular workspace files can be attached.")
    return {
      path: candidate,
      canonical,
      size: metadata.size,
      dev: metadata.dev,
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    }
  }

  private requireCapacity(records: AttachmentRecord[]) {
    if (this.attachments.size + records.length > MAX_ATTACHMENTS) {
      throw new AttachmentError(`OpenCode supports up to ${MAX_ATTACHMENTS} context attachments.`)
    }
    const images = [...this.attachments.values(), ...records].filter((item) => item.kind === "image").length
    if (images > MAX_IMAGES) throw new AttachmentError(`OpenCode supports up to ${MAX_IMAGES} images.`)
    this.requireTotals([...this.attachments.values(), ...records])
  }

  private requireTotals(records: AttachmentRecord[]) {
    const text = records.filter((item) => item.mime === "text/plain").reduce((total, item) => total + item.bytes, 0)
    const images = records.filter((item) => item.kind === "image").reduce((total, item) => total + item.bytes, 0)
    const media = records.filter((item) => item.mime !== "text/plain").reduce((total, item) => total + item.bytes, 0)
    if (text > MAX_ATTACHMENT_TOTAL_BYTES) throw new AttachmentError("Context attachments exceed the 1 MiB total limit.")
    if (images > MAX_IMAGE_TOTAL_BYTES) throw new AttachmentError("Image attachments exceed the 10 MiB total limit.")
    if (media > MAX_MEDIA_TOTAL_BYTES) throw new AttachmentError("Media attachments exceed the 50 MiB total limit.")
  }

  private serialize<T>(operation: () => Promise<T>) {
    const pending = this.mutation.then(operation)
    this.mutation = pending.then(() => undefined, () => undefined)
    return pending
  }
}

export function safeLabel(value: string) {
  const label = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�")
    .replaceAll("\\", "/")
    .trim()
  return label.slice(0, 240) || "file"
}

function uploadLabel(value: string) {
  const normalized = value.replaceAll("\\", "/")
  return safeLabel(normalized.split("/").at(-1) ?? "file")
}

function decodeUpload(data: string) {
  if (!data.length || data.length > Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4 || data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new AttachmentError("That local file payload is invalid.")
  }
  const content = Buffer.from(data, "base64")
  if (content.toString("base64") !== data) throw new AttachmentError("That local file payload is invalid.")
  return content
}

function localUploadMime(name: string, requestedMime: string, content: Buffer) {
  const image = imageMime(content)
  if (image) return image
  if (content.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf"
  const extension = name.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().match(/\.[a-z0-9]+$/)?.[0]
  if (extension && TEXT_EXTENSIONS.has(extension)) {
    if (content.includes(0)) throw new AttachmentError("That text file contains binary data.")
    decodeText(content)
    return "text/plain"
  }
  const mime = requestedMime.toLowerCase().split(";", 1)[0]?.trim() ?? ""
  const media = mediaMime(content, mime)
  if (media) return media
  throw new AttachmentError("OpenCode supports local text files, PDF, images, audio, and common video formats.")
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonc", ".js", ".jsx", ".ts", ".tsx", ".css", ".html", ".xml",
  ".yaml", ".yml", ".toml", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".sh", ".sql", ".env", ".ini", ".cfg", ".log", ".csv",
])

function mediaMime(value: Buffer, requested: string) {
  const ascii = (start: number, end: number) => value.subarray(start, end).toString("ascii")
  if ((requested === "video/mp4" || requested === "video/quicktime" || requested === "audio/mp4") && ascii(4, 8) === "ftyp") return requested
  if ((requested === "video/webm" || requested === "audio/webm") && value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return requested
  if ((requested === "video/ogg" || requested === "audio/ogg") && ascii(0, 4) === "OggS") return requested
  if ((requested === "audio/wav" || requested === "audio/x-wav") && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav"
  if (requested === "video/x-msvideo" && ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return requested
  if (requested === "audio/flac" && ascii(0, 4) === "fLaC") return requested
  if (requested === "audio/mpeg" && (ascii(0, 3) === "ID3" || (value[0] === 0xff && (value[1] ?? 0) >= 0xe0))) return requested
  if (requested === "video/mpeg" && value[0] === 0x00 && value[1] === 0x00 && value[2] === 0x01) return requested
}

function contains(directory: string, path: string) {
  const result = relative(directory, path)
  return result.length > 0 && !result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result)
}

async function rejectSymlinks(directory: string, path: string) {
  const result = relative(directory, path)
  const components = result.split(sep).filter(Boolean)
  await Promise.all(components.map(async (_, index) => {
    const component = resolve(directory, ...components.slice(0, index + 1))
    if ((await lstat(component)).isSymbolicLink()) throw new AttachmentError("Symlinked files cannot be attached in this milestone.")
  }))
}

function decodeText(value: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    throw new AttachmentError("Only UTF-8 text files can be attached in this milestone.")
  }
}

async function readBounded(handle: FileHandle, maximum: number) {
  const content = Buffer.alloc(maximum + 1)
  let offset = 0
  while (offset < content.length) {
    const result = await handle.read(content, offset, content.length - offset, offset)
    if (!result.bytesRead) break
    offset += result.bytesRead
  }
  if (offset > maximum) {
    throw new AttachmentError(maximum === MAX_IMAGE_BYTES ? "That image is larger than 5 MiB." : "That file is larger than 256 KiB.")
  }
  return content.subarray(0, offset)
}

function imageMime(value: Buffer) {
  if (value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "image/jpeg"
  if (value.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif"
  if (value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number; ctimeMs: number },
  right: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number; ctimeMs: number },
) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
