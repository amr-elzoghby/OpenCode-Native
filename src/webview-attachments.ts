import { MAX_LOCAL_FILE_BYTES, type AttachmentAction, type AttachmentChip } from "./protocol"

export type LocalFileUpload = { name: string; mime: string; data: string }

export function createAttachments(
  strip: HTMLElement,
  trigger: HTMLButtonElement,
  menu: HTMLElement,
  add: (action: AttachmentAction) => void,
  upload: (file: LocalFileUpload) => void,
  reportError: (message: string) => void,
  remove: (id: string) => void,
) {
  const actions: Array<{ action: AttachmentAction; label: string }> = [
    { action: "workspaceFiles", label: "Workspace files…" },
    { action: "currentFile", label: "Current file" },
    { action: "currentSelection", label: "Current selection" },
  ]
  const fileInput = document.createElement("input")
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
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.item(0)
    if (!file) return
    try {
      upload(await encodeLocalFile(file))
    } catch (error) {
      reportError(error instanceof Error ? error.message : "OpenCode could not read that local file.")
    }
  })
  menu.append(localFile, fileInput)
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
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      trigger.focus()
      return
    }
    const next = event.key === "ArrowDown" ? current + 1
      : event.key === "ArrowUp" ? current - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : undefined
    if (next === undefined || !items.length) return
    event.preventDefault()
    items[(next + items.length) % items.length]?.focus()
  })

  return {
    update(items: AttachmentChip[], disabled: boolean, localFiles: boolean) {
      strip.replaceChildren(...items.map((item) => chip(item, remove)))
      strip.hidden = items.length === 0
      menu.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
        button.disabled = disabled || (button.dataset.localFile === "true" && !localFiles)
        if (button.dataset.localFile === "true") {
          button.title = localFiles ? "Add a file from this device" : "Select a model before adding a local file"
        }
      })
      if (disabled) close()
      trigger.disabled = disabled
    },
    ids() {
      return Array.from(strip.querySelectorAll<HTMLElement>("[data-attachment-id]"))
        .map((item) => item.dataset.attachmentId)
        .filter((id): id is string => !!id)
    },
    isOpen() {
      return !menu.hidden
    },
  }

  function close() {
    menu.hidden = true
    trigger.setAttribute("aria-expanded", "false")
  }
}

export async function encodeLocalFile(file: Pick<File, "name" | "type" | "size" | "arrayBuffer">): Promise<LocalFileUpload> {
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
  return { name: file.name, mime: file.type || "application/octet-stream", data: btoa(binary) }
}

function chip(item: AttachmentChip, remove: (id: string) => void) {
  const chip = document.createElement("span")
  chip.className = "attachment-chip"
  chip.dataset.attachmentId = item.id
  const label = document.createElement("bdi")
  label.dir = "ltr"
  label.textContent = item.range ? `${item.label}:${item.range.start}-${item.range.end}` : item.label
  const button = document.createElement("button")
  button.type = "button"
  button.className = "attachment-remove"
  button.textContent = "×"
  button.ariaLabel = `Remove ${label.textContent}`
  button.title = button.ariaLabel
  button.addEventListener("click", () => remove(item.id))
  chip.append(document.createTextNode(item.kind === "image" ? "▧ " : "@ "), label, button)
  return chip
}
