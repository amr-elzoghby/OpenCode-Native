import {
  MAX_LOCAL_FILE_BYTES,
  type AttachmentAction,
  type AttachmentChip,
  type AttachmentUploadMessage,
} from "./protocol"

export type LocalFileUpload = { name: string; mime: string; data: string }
export type AttachmentUploadRequest = LocalFileUpload & { requestID: string; context: string }

type PendingUpload = {
  requestID: string
  context: string
  label: string
  kind: "file" | "image"
  bytes: number
  imageOnly: boolean
  sent: boolean
  previewURL?: string
}

type Preview = { url: string; seen: boolean }
type RasterImageInfo = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; width: number; height: number }

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 4
const MAX_PREVIEW_DIMENSION = 160
const MAX_SOURCE_DIMENSION = 8_192
const MAX_SOURCE_PIXELS = 20_000_000
const MAX_PREVIEW_BYTES = 256 * 1024
const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export function createAttachments(
  strip: HTMLElement,
  trigger: HTMLButtonElement,
  menu: HTMLElement,
  add: (action: AttachmentAction) => void,
  upload: (file: AttachmentUploadRequest) => void,
  reportError: (message: string) => void,
  remove: (id: string) => void,
  onBusyChange: (busy: boolean) => void = () => undefined,
) {
  const actions: Array<{ action: AttachmentAction; label: string }> = [
    { action: "workspaceFiles", label: "Workspace files…" },
    { action: "currentFile", label: "Current file" },
    { action: "currentSelection", label: "Current selection" },
  ]
  const pending = new Map<string, PendingUpload>()
  const cancelled = new Map<string, string>()
  const previews = new Map<string, Preview>()
  const fileInput = document.createElement("input")
  let items: AttachmentChip[] = []
  let disabled = true
  let localFiles = false
  let context = ""
  let busy = false
  let disposed = false
  let thumbnailQueue: Promise<void> = Promise.resolve()

  fileInput.type = "file"
  fileInput.hidden = true
  fileInput.tabIndex = -1
  fileInput.setAttribute("aria-hidden", "true")
  menu.setAttribute("role", "menu")
  menu.setAttribute("aria-label", "Add context")
  if (menu.id) trigger.setAttribute("aria-controls", menu.id)
  actions.forEach((item) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "attachment-option"
    button.setAttribute("role", "menuitem")
    button.dataset.action = item.action
    button.textContent = item.label
    button.addEventListener("click", () => {
      close()
      add(item.action)
    })
    menu.append(button)
  })
  const localFile = document.createElement("button")
  localFile.type = "button"
  localFile.className = "attachment-option"
  localFile.setAttribute("role", "menuitem")
  localFile.dataset.localFile = "true"
  localFile.textContent = "Add file…"
  localFile.addEventListener("click", () => {
    close()
    fileInput.value = ""
    fileInput.click()
  })
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.item(0)
    if (file) beginUpload(file, false)
  })
  menu.append(localFile, fileInput)
  trigger.disabled = true
  trigger.addEventListener("click", () => {
    const open = menu.hidden
    menu.hidden = !open
    trigger.setAttribute("aria-expanded", String(open))
    if (open) menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
  })
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && (menu.contains(event.target) || trigger.contains(event.target))) return
    close()
  })
  menu.addEventListener("keydown", (event) => {
    const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
    const current = menuItems.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      trigger.focus()
      return
    }
    const next = event.key === "ArrowDown" ? current + 1
      : event.key === "ArrowUp" ? current - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? menuItems.length - 1
            : undefined
    if (next === undefined || !menuItems.length) return
    event.preventDefault()
    menuItems[(next + menuItems.length) % menuItems.length]?.focus()
  })

  return {
    update(nextItems: AttachmentChip[], nextDisabled: boolean, nextLocalFiles: boolean, nextContext: string) {
      if (nextContext !== context) {
        context = nextContext
        clearTransientState()
      }
      const nextIDs = new Set(nextItems.map((item) => item.id))
      previews.forEach((preview, id) => {
        if (nextIDs.has(id)) preview.seen = true
        else if (preview.seen) {
          revoke(preview.url)
          previews.delete(id)
        }
      })
      items = nextItems
      disabled = nextDisabled
      localFiles = nextLocalFiles
      render()
      updateMenu()
    },
    handleUploadResult(message: AttachmentUploadMessage) {
      if (message.context !== context) return true
      const entry = pending.get(message.requestID)
      if (!entry || entry.context !== message.context) {
        if (cancelled.get(message.requestID) === message.context) {
          cancelled.delete(message.requestID)
          if (message.status === "accepted") remove(message.attachment.id)
        }
        return true
      }
      pending.delete(message.requestID)
      if (message.status === "rejected") {
        if (entry.previewURL) revoke(entry.previewURL)
        reportError(message.error)
      } else {
        items = [...items.filter((item) => item.id !== message.attachment.id), message.attachment]
        if (entry.previewURL && message.attachment.kind === "image") {
          previews.set(message.attachment.id, { url: entry.previewURL, seen: false })
        } else if (entry.previewURL) {
          revoke(entry.previewURL)
        }
      }
      notifyBusy()
      render()
      return true
    },
    handlePaste(event: ClipboardEvent) {
      const transfer = event.clipboardData
      if (!transfer) return false
      const files = transferFiles(transfer)
      const images = files.filter(rasterCandidate)
      const target = textareaTarget(event)
      const text = transfer.getData("text/plain")
      let handled = false
      if (files.length) {
        event.preventDefault()
        handled = true
        if (images.length) {
          if (text && target) insertAndReport(target, text)
          beginImages(images)
        } else {
          reportError("Paste a PNG, JPEG, GIF, or WebP image, or use Add file… for other files.")
        }
      } else if (text && target) {
        event.preventDefault()
        insertAndReport(target, text)
        handled = true
      }
      return handled
    },
    handleDragOver(event: DragEvent) {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return false
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
      return true
    },
    handleDrop(event: DragEvent) {
      if (!event.dataTransfer) return false
      const files = transferFiles(event.dataTransfer)
      if (!files.length) return false
      event.preventDefault()
      beginImages(files.filter(rasterCandidate), files.length)
      return true
    },
    ids() {
      return items.map((item) => item.id)
    },
    isOpen() {
      return !menu.hidden
    },
    isUploading() {
      return pending.size > 0
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTransientState()
      items = []
      render()
    },
  }

  function insertAndReport(target: HTMLTextAreaElement, text: string) {
    const result = insertPastedText(target, text)
    if (result.truncated) reportError("The pasted text was shortened to fit the message limit.")
  }

  function beginImages(images: File[], supplied = images.length) {
    if (!images.length) {
      if (supplied) reportError("Drop a PNG, JPEG, GIF, or WebP image here.")
      return
    }
    if (images.length < supplied) reportError("Only PNG, JPEG, GIF, and WebP images can be pasted or dropped.")
    images.forEach((file) => beginUpload(file, true))
  }

  function beginUpload(file: File, imageOnly: boolean) {
    if (disposed) return false
    if (disabled || !context) {
      reportError("Wait for OpenCode to be ready before adding a file.")
      return false
    }
    if (!localFiles) {
      reportError("Select a model before adding a local file.")
      return false
    }
    const mime = normalizeMime(file.type)
    const image = RASTER_MIMES.has(mime) || imageOnly
    if (imageOnly && !rasterCandidate(file)) return false
    if (file.size <= 0) {
      reportError("That file is empty.")
      return false
    }
    if (file.size > (image ? MAX_IMAGE_BYTES : MAX_LOCAL_FILE_BYTES)) {
      reportError(image ? "That image is larger than 5 MiB." : "That file is larger than 25 MiB.")
      return false
    }
    if (image) {
      const imageEntries = items.filter((item) => item.kind === "image").length +
        [...pending.values()].filter((item) => item.kind === "image").length
      const imageBytes = [...pending.values()].filter((item) => item.kind === "image")
        .reduce((total, item) => total + item.bytes, 0)
      if (imageEntries >= MAX_IMAGES) {
        reportError(`OpenCode supports up to ${MAX_IMAGES} images.`)
        return false
      }
      if (imageBytes + file.size > MAX_IMAGE_TOTAL_BYTES) {
        reportError("Image attachments exceed the 10 MiB total limit.")
        return false
      }
    }
    const requestID = crypto.randomUUID().replaceAll("-", "")
    const entry: PendingUpload = {
      requestID,
      context,
      label: localLabel(file.name, mime, image),
      kind: image ? "image" : "file",
      bytes: file.size,
      imageOnly,
      sent: false,
    }
    pending.set(requestID, entry)
    notifyBusy()
    render()
    void prepareUpload(file, entry)
    return true
  }

  async function prepareUpload(file: File, entry: PendingUpload) {
    try {
      const encoded = await readLocalFile(file)
      if (disposed || pending.get(entry.requestID) !== entry || entry.context !== context) return
      const info = previewImageInfo(encoded.bytes)
      if (entry.imageOnly && !info) throw new Error("Only PNG, JPEG, GIF, and WebP images can be pasted or dropped.")
      if (info) {
        if (encoded.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("That image is larger than 5 MiB.")
        const otherImages = items.filter((item) => item.kind === "image").length +
          [...pending.values()].filter((item) => item !== entry && item.kind === "image").length
        const otherImageBytes = [...pending.values()]
          .filter((item) => item !== entry && item.kind === "image")
          .reduce((total, item) => total + item.bytes, 0)
        if (otherImages >= MAX_IMAGES) throw new Error(`OpenCode supports up to ${MAX_IMAGES} images.`)
        if (otherImageBytes + encoded.bytes.byteLength > MAX_IMAGE_TOTAL_BYTES) {
          throw new Error("Image attachments exceed the 10 MiB total limit.")
        }
        entry.kind = "image"
        entry.previewURL = await queueThumbnail(encoded.bytes, info)
      }
      if (disposed || pending.get(entry.requestID) !== entry || entry.context !== context) {
        if (entry.previewURL) revoke(entry.previewURL)
        return
      }
      entry.sent = true
      render()
      upload({
        requestID: entry.requestID,
        context: entry.context,
        ...encoded.upload,
        name: encoded.upload.name || entry.label,
      })
    } catch (error) {
      if (pending.get(entry.requestID) !== entry) return
      pending.delete(entry.requestID)
      if (entry.previewURL) revoke(entry.previewURL)
      notifyBusy()
      render()
      reportError(error instanceof Error ? error.message : "OpenCode could not read that local file.")
    }
  }

  function queueThumbnail(bytes: Uint8Array, info: RasterImageInfo) {
    let result: string | undefined
    const operation = thumbnailQueue.then(async () => {
      result = await createThumbnailURL(bytes, info)
    })
    thumbnailQueue = operation.catch(() => undefined)
    return operation.then(() => result, () => undefined)
  }

  function cancel(entry: PendingUpload) {
    if (pending.get(entry.requestID) !== entry) return
    pending.delete(entry.requestID)
    if (entry.sent) {
      cancelled.set(entry.requestID, entry.context)
      if (cancelled.size > 64) cancelled.delete(cancelled.keys().next().value as string)
    }
    if (entry.previewURL) revoke(entry.previewURL)
    notifyBusy()
    render()
  }

  function clearTransientState() {
    pending.forEach((entry) => {
      if (entry.previewURL) revoke(entry.previewURL)
    })
    previews.forEach((preview) => revoke(preview.url))
    pending.clear()
    cancelled.clear()
    previews.clear()
    notifyBusy()
  }

  function notifyBusy() {
    const next = pending.size > 0
    if (next === busy) return
    busy = next
    onBusyChange(next)
  }

  function updateMenu() {
    menu.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = disabled || (button.dataset.localFile === "true" && !localFiles)
      if (button.dataset.localFile === "true") {
        button.title = localFiles ? "Add a file from this device" : "Select a model before adding a local file"
      }
    })
    if (disabled) close()
    trigger.disabled = disabled
  }

  function render() {
    const nodes = items.map((item) => attachmentNode(item, previews.get(item.id)?.url, disabled, () => remove(item.id)))
    pending.forEach((entry) => nodes.push(pendingNode(entry, disabled, () => cancel(entry))))
    strip.replaceChildren(...nodes)
    strip.hidden = nodes.length === 0
  }

  function close() {
    menu.hidden = true
    trigger.setAttribute("aria-expanded", "false")
  }
}

export function insertPastedText(input: HTMLTextAreaElement, text: string) {
  const start = Math.max(0, Math.min(input.value.length, input.selectionStart ?? input.value.length))
  const end = Math.max(start, Math.min(input.value.length, input.selectionEnd ?? start))
  const maximum = input.maxLength >= 0 ? input.maxLength : Number.MAX_SAFE_INTEGER
  const available = Math.max(0, maximum - (input.value.length - (end - start)))
  let inserted = text.slice(0, available)
  if (inserted.length < text.length && /[\ud800-\udbff]/.test(inserted.at(-1) ?? "") &&
    /[\udc00-\udfff]/.test(text[inserted.length] ?? "")) inserted = inserted.slice(0, -1)
  if (inserted) {
    input.setRangeText(inserted, start, end, "end")
    const EventConstructor = input.ownerDocument.defaultView?.Event ?? Event
    input.dispatchEvent(new EventConstructor("input", { bubbles: true }))
  }
  return { inserted, truncated: inserted.length < text.length }
}

export async function encodeLocalFile(file: Pick<File, "name" | "type" | "size" | "arrayBuffer">): Promise<LocalFileUpload> {
  return (await readLocalFile(file)).upload
}

export function previewImageInfo(content: Uint8Array): RasterImageInfo | undefined {
  const info = rasterImageInfo(content)
  if (!info || info.width > MAX_SOURCE_DIMENSION || info.height > MAX_SOURCE_DIMENSION ||
    info.width * info.height > MAX_SOURCE_PIXELS) return
  return info
}

async function readLocalFile(file: Pick<File, "name" | "type" | "size" | "arrayBuffer">) {
  if (file.size <= 0) throw new Error("That file is empty.")
  if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error("That file is larger than 25 MiB.")
  const content = new Uint8Array(await file.arrayBuffer())
  if (content.byteLength !== file.size || content.byteLength > MAX_LOCAL_FILE_BYTES) {
    throw new Error("That file changed while OpenCode was reading it.")
  }
  let binary = ""
  for (let offset = 0; offset < content.length; offset += 32_768) {
    binary += String.fromCharCode(...content.subarray(offset, offset + 32_768))
  }
  return {
    bytes: content,
    upload: { name: file.name, mime: file.type || "application/octet-stream", data: btoa(binary) },
  }
}

async function createThumbnailURL(bytes: Uint8Array, info: RasterImageInfo) {
  if (typeof createImageBitmap !== "function") return
  const source = bytes.slice().buffer
  const bitmap = await createImageBitmap(new Blob([source], { type: info.mime }))
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width > MAX_SOURCE_DIMENSION ||
      bitmap.height > MAX_SOURCE_DIMENSION || bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) return
    const scale = Math.min(1, MAX_PREVIEW_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const drawing = canvas.getContext("2d", { alpha: true })
    if (!drawing) return
    drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const thumbnail = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!thumbnail || thumbnail.size <= 0 || thumbnail.size > MAX_PREVIEW_BYTES) return
    return URL.createObjectURL(thumbnail)
  } finally {
    bitmap.close()
  }
}

function rasterImageInfo(content: Uint8Array): RasterImageInfo | undefined {
  if (content.length >= 24 && matches(content, 0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
    ascii(content, 12, 4) === "IHDR") {
    return dimensions("image/png", uint32BE(content, 16), uint32BE(content, 20))
  }
  const gif = ascii(content, 0, 6)
  if (content.length >= 10 && (gif === "GIF87a" || gif === "GIF89a")) {
    return dimensions("image/gif", uint16LE(content, 6), uint16LE(content, 8))
  }
  if (content.length >= 12 && content[0] === 0xff && content[1] === 0xd8) {
    const size = jpegDimensions(content)
    if (size) return dimensions("image/jpeg", size.width, size.height)
  }
  if (content.length >= 30 && ascii(content, 0, 4) === "RIFF" && ascii(content, 8, 4) === "WEBP") {
    const size = webpDimensions(content)
    if (size) return dimensions("image/webp", size.width, size.height)
  }
}

function jpegDimensions(content: Uint8Array) {
  let offset = 2
  while (offset + 3 < content.length) {
    while (offset < content.length && content[offset] === 0xff) offset++
    const marker = content[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 1 >= content.length) return
    const length = uint16BE(content, offset)
    if (length < 2 || offset + length > content.length) return
    if (JPEG_SIZE_MARKERS.has(marker) && length >= 7) {
      return { height: uint16BE(content, offset + 3), width: uint16BE(content, offset + 5) }
    }
    offset += length
  }
}

const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function webpDimensions(content: Uint8Array) {
  const kind = ascii(content, 12, 4)
  if (kind === "VP8X" && content.length >= 30) {
    return { width: 1 + uint24LE(content, 24), height: 1 + uint24LE(content, 27) }
  }
  if (kind === "VP8 " && content.length >= 30 && matches(content, 23, [0x9d, 0x01, 0x2a])) {
    return { width: uint16LE(content, 26) & 0x3fff, height: uint16LE(content, 28) & 0x3fff }
  }
  if (kind === "VP8L" && content.length >= 25 && content[20] === 0x2f) {
    const first = content[21] ?? 0
    const second = content[22] ?? 0
    const third = content[23] ?? 0
    const fourth = content[24] ?? 0
    return {
      width: 1 + first + ((second & 0x3f) << 8),
      height: 1 + ((second & 0xc0) >> 6) + (third << 2) + ((fourth & 0x0f) << 10),
    }
  }
}

function dimensions(mime: RasterImageInfo["mime"], width: number, height: number): RasterImageInfo | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return
  return { mime, width, height }
}

function attachmentNode(item: AttachmentChip, previewURL: string | undefined, disabled: boolean, remove: () => void) {
  const label = item.range ? `${item.label}:${item.range.start}-${item.range.end}` : item.label
  if (item.kind === "image" && previewURL) return imageTile(label, previewURL, false, disabled, remove)
  return fileChip(item.id, label, item.kind === "image", false, disabled, remove)
}

function pendingNode(item: PendingUpload, disabled: boolean, remove: () => void) {
  if (item.kind === "image") return imageTile(item.label, item.previewURL, true, disabled, remove)
  return fileChip(undefined, item.label, false, true, disabled, remove)
}

function imageTile(labelText: string, previewURL: string | undefined, pending: boolean, disabled: boolean, remove: () => void) {
  const tile = document.createElement("span")
  tile.className = `attachment-image${pending ? " pending" : ""}`
  tile.setAttribute("role", "group")
  tile.setAttribute("aria-label", `Image attachment ${labelText}`)
  if (previewURL) {
    const image = document.createElement("img")
    image.className = "attachment-thumbnail"
    image.src = previewURL
    image.alt = ""
    image.draggable = false
    tile.append(image)
  } else {
    const placeholder = document.createElement("span")
    placeholder.className = "attachment-image-placeholder"
    placeholder.textContent = "▧"
    placeholder.setAttribute("aria-hidden", "true")
    tile.append(placeholder)
  }
  const label = document.createElement("bdi")
  label.className = "attachment-image-label"
  label.dir = "ltr"
  label.textContent = labelText
  tile.append(label, removeButton(labelText, disabled, remove))
  return tile
}

function fileChip(id: string | undefined, labelText: string, image: boolean, pending: boolean, disabled: boolean, remove: () => void) {
  const chip = document.createElement("span")
  chip.className = `attachment-chip${pending ? " pending" : ""}`
  if (id) chip.dataset.attachmentId = id
  const label = document.createElement("bdi")
  label.dir = "ltr"
  label.textContent = labelText
  chip.append(document.createTextNode(image ? "▧ " : "@ "), label, removeButton(labelText, disabled, remove))
  return chip
}

function removeButton(label: string, disabled: boolean, remove: () => void) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "attachment-remove"
  button.textContent = "×"
  button.disabled = disabled
  button.ariaLabel = `Remove ${label}`
  button.title = button.ariaLabel
  button.addEventListener("click", remove)
  return button
}

function transferFiles(transfer: DataTransfer) {
  const files = Array.from(transfer.files)
  if (files.length) return files
  Array.from(transfer.items).forEach((item) => {
    if (item.kind !== "file") return
    const file = item.getAsFile()
    if (file && !files.includes(file)) files.push(file)
  })
  return files
}

function textareaTarget(event: ClipboardEvent) {
  const target = event.currentTarget
  return target instanceof HTMLTextAreaElement ? target : undefined
}

function normalizeMime(value: string) {
  return value.toLowerCase().split(";", 1)[0]?.trim() ?? ""
}

function rasterCandidate(file: File) {
  const mime = normalizeMime(file.type)
  return RASTER_MIMES.has(mime) || !mime || mime === "application/octet-stream"
}

function localLabel(value: string, mime: string, image: boolean) {
  const normalized = value.replaceAll("\\", "/").split("/").at(-1) ?? ""
  const label = normalized
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�")
    .trim()
    .slice(0, 240)
  if (label) return label
  if (!image) return "file"
  const extension = mime === "image/jpeg" ? "jpg" : mime.startsWith("image/") ? mime.slice(6) : "png"
  return `pasted-image.${extension}`
}

function revoke(url: string) {
  URL.revokeObjectURL(url)
}

function ascii(content: Uint8Array, offset: number, length: number) {
  if (offset < 0 || offset + length > content.length) return ""
  return String.fromCharCode(...content.subarray(offset, offset + length))
}

function matches(content: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => content[offset + index] === value)
}

function uint16BE(content: Uint8Array, offset: number) {
  return ((content[offset] ?? 0) << 8) | (content[offset + 1] ?? 0)
}

function uint16LE(content: Uint8Array, offset: number) {
  return (content[offset] ?? 0) | ((content[offset + 1] ?? 0) << 8)
}

function uint24LE(content: Uint8Array, offset: number) {
  return (content[offset] ?? 0) | ((content[offset + 1] ?? 0) << 8) | ((content[offset + 2] ?? 0) << 16)
}

function uint32BE(content: Uint8Array, offset: number) {
  return (((content[offset] ?? 0) * 0x1000000) + ((content[offset + 1] ?? 0) << 16) +
    ((content[offset + 2] ?? 0) << 8) + (content[offset + 3] ?? 0)) >>> 0
}
