import { createPicker } from "./webview-picker"
import { createCommandMenu } from "./webview-command-menu"
import { createHistory } from "./webview-history"
import { createTimeline } from "./webview-timeline"
import { createTranscript } from "./webview-transcript"
import { createAttachments } from "./webview-attachments"
import { createPermissions } from "./webview-permissions"
import { createQuestions } from "./webview-questions"
import { createProviderConnect } from "./webview-connect"
import { createUsage } from "./webview-usage"
import { createRollbackDock } from "./webview-rollback"
import { parseActionMessage, parseComposerMessage, parseRollbackResultMessage, parseStateMessage, parseSubmissionMessage, type NativeAction, type ViewState } from "./protocol"

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

const vscode = acquireVsCodeApi()
const composer = required<HTMLFormElement>("#composer")
const prompt = required<HTMLTextAreaElement>("#prompt")
const transcript = required<HTMLElement>("#transcript")
const transcriptShell = required<HTMLElement>(".transcript-shell")
const stickyPrompt = required<HTMLButtonElement>("#sticky-prompt")
const commandRoot = required<HTMLElement>("#command-menu")
const historyRoot = required<HTMLElement>("#history")
const timelineRoot = required<HTMLElement>("#timeline")
const attachmentStrip = required<HTMLElement>("#attachment-strip")
const attachmentTrigger = required<HTMLButtonElement>("#add-context")
const attachmentMenu = required<HTMLElement>("#attachment-menu")
const emptyBrand = required<HTMLElement>("#empty-brand")
const permissionRoot = required<HTMLElement>("#permission-dock")
const questionRoot = required<HTMLElement>("#question-dock")
const rollbackRoot = required<HTMLElement>("#rollback-dock")
const providerConnectRoot = required<HTMLElement>("#provider-connect")
const status = required<HTMLElement>("#status")
const announcer = required<HTMLElement>("#announcer")
const send = required<HTMLButtonElement>("#send")
const agentRoot = required<HTMLElement>("#agent-picker")
const modelRoot = required<HTMLElement>("#model-picker")
const usageRoot = required<HTMLElement>("#usage")
const variantRoot = required<HTMLElement>("#variant-picker")
let current: ViewState | undefined
let previousPhase: ViewState["phase"] | undefined
let pending: {
  requestID: string
  text: string
  status: "submitted" | "accepted" | "rejected" | "observed"
  messageID?: string
  error?: string
  attachments: ViewState["attachments"]
} | undefined

const agent = createPicker(agentRoot, false, (id) => vscode.postMessage({ type: "selectAgent", id }))
const model = createPicker(modelRoot, true, (value) => {
  const selected = parseModelKey(value)
  if (selected) vscode.postMessage({ type: "selectModel", ...selected })
})
const variant = createPicker(variantRoot, false, (id) => vscode.postMessage({ type: "selectVariant", id: id || undefined }))
const usage = createUsage(usageRoot)
const transcriptView = createTranscript(transcript, stickyPrompt, (reviewKey, fileKey) => {
  vscode.postMessage({ type: "openReview", reviewKey, fileKey })
})
const commands = createCommandMenu(commandRoot, prompt, invokeAction, runDynamicCommand, (name, note) => {
  status.classList.add("error")
  status.textContent = `/${name} is not available in Native: ${note}`
  announcer.textContent = `/${name} is unavailable in OpenCode Native.`
})
const history = createHistory(historyRoot, {
  select: (key) => vscode.postMessage({ type: "selectSession", key }),
  rename: (key, title) => vscode.postMessage({ type: "renameSession", key, title }),
  delete: (key) => vscode.postMessage({ type: "deleteSession", key }),
}, [transcriptShell, composer, rollbackRoot])
const timeline = createTimeline(
  timelineRoot,
  (turnID) => transcriptView.scrollToTurn(turnID),
  [transcriptShell, composer, permissionRoot, questionRoot, rollbackRoot],
)
const attachments = createAttachments(
  attachmentStrip,
  attachmentTrigger,
  attachmentMenu,
  (action) => vscode.postMessage({ type: "attachmentAction", action }),
  (file) => vscode.postMessage({ type: "uploadFile", ...file }),
  (message) => {
    status.classList.add("error")
    status.textContent = message
    announcer.textContent = message
  },
  (id) => vscode.postMessage({ type: "removeAttachment", id }),
)
const permissions = createPermissions(permissionRoot, (key, decision) => {
  vscode.postMessage({ type: "replyPermission", key, decision })
}, (reviewKey, fileKey) => {
  vscode.postMessage({ type: "openReview", reviewKey, fileKey })
})
const questions = createQuestions(
  questionRoot,
  (key, answers) => vscode.postMessage({ type: "replyQuestion", key, answers }),
  (key) => vscode.postMessage({ type: "rejectQuestion", key }),
)
const rollback = createRollbackDock(
  rollbackRoot,
  (key) => vscode.postMessage({ type: "restoreRolledBack", key }),
  (message) => { announcer.textContent = message },
  () => prompt.focus(),
)
const providerConnect = createProviderConnect(providerConnectRoot, {
  activate: () => {
    history.close()
    timeline.close()
  },
  close: () => vscode.postMessage({ type: "providerConnectClose" }),
  provider: (key) => vscode.postMessage({ type: "selectProviderConnection", key }),
  method: (key) => vscode.postMessage({ type: "selectProviderMethod", key }),
}, [transcriptShell, composer, permissionRoot, questionRoot, rollbackRoot])

composer.addEventListener("submit", (event) => {
  event.preventDefault()
  if (commands.executeExact(prompt.value)) return
  if (pending && pending.status !== "rejected" && pending.status !== "observed") return
  if (!current || current.phase === "loading" || current.phase === "stopping") return
  const text = prompt.value.trim()
  const attachmentIDs = attachments.ids()
  if ((!text && !attachmentIDs.length) || text.length > prompt.maxLength || send.disabled) return
  const requestID = crypto.randomUUID().replaceAll("-", "")
  pending = {
    requestID,
    text,
    status: "submitted",
    attachments: current.attachments.filter((item) => attachmentIDs.includes(item.id)),
  }
  vscode.postMessage({ type: "sendPrompt", requestID, text, attachmentIDs })
  render(current)
})

prompt.addEventListener("keydown", (event) => {
  if (commands.handleKeydown(event)) return
  if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
    if (cycleAgent(event.shiftKey ? -1 : 1)) event.preventDefault()
    return
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  composer.requestSubmit()
})
composer.addEventListener("focusin", () => vscode.postMessage({ type: "composerFocus", focused: true }))
composer.addEventListener("focusout", (event) => {
  if (event.relatedTarget instanceof Node && composer.contains(event.relatedTarget)) return
  vscode.postMessage({ type: "composerFocus", focused: false })
})
window.addEventListener("focus", () => vscode.postMessage({ type: "sidebarFocus", focused: true }))
window.addEventListener("blur", () => vscode.postMessage({ type: "sidebarFocus", focused: false }))
prompt.addEventListener("input", () => {
  resizePrompt()
  commands.sync()
})

window.addEventListener("message", (event) => {
  if (history.apply(event.data)) return
  if (providerConnect.apply(event.data)) return
  const action = parseActionMessage(event.data)
  if (action) {
    applyAction(action.action)
    return
  }
  const composerMessage = parseComposerMessage(event.data)
  if (composerMessage) {
    prompt.value = composerMessage.text
    resizePrompt()
    commands.sync()
    prompt.focus()
    return
  }
  const rollbackResult = parseRollbackResultMessage(event.data)
  if (rollbackResult) {
    rollback.resolve(rollbackResult.key, rollbackResult.status)
    return
  }
  const submission = parseSubmissionMessage(event.data)
  if (submission) {
    if (!pending || pending.requestID !== submission.requestID) return
    if (submission.status === "submitted") pending.status = submission.status
    if (submission.status === "accepted") {
      pending.status = submission.status
      if (prompt.value.trim() === pending.text) {
        prompt.value = ""
        resizePrompt()
        commands.sync()
      }
    }
    if (submission.status === "rejected") {
      pending.status = submission.status
      pending.error = submission.error
      if (!prompt.value) {
        prompt.value = pending.text
        resizePrompt()
        commands.sync()
      }
    }
    if (submission.status === "observed") {
      pending.status = submission.status
      pending.messageID = submission.messageID
    }
    if (current) render(current)
    return
  }
  const message = parseStateMessage(event.data)
  if (!message) return
  current = message.state
  if (pending?.messageID && message.state.messages.some((item) => item.id === pending?.messageID)) pending = undefined
  render(message.state)
  vscode.postMessage({ type: "rendered", id: message.id })
})

vscode.postMessage({ type: "ready" })
vscode.postMessage({ type: "sidebarFocus", focused: document.hasFocus() })

function invokeAction(action: NativeAction) {
  vscode.postMessage({ type: "invokeAction", action })
}

function runDynamicCommand(key: string, name: string, argumentsValue: string) {
  if (pending && pending.status !== "rejected" && pending.status !== "observed") return
  if (!current || current.phase !== "ready" || !current.selection.model) return
  if (!current.commands.some((command) => command.key === key && command.name === name)) return
  const attachmentIDs = attachments.ids()
  const requestID = crypto.randomUUID().replaceAll("-", "")
  const text = `/${name}${argumentsValue ? ` ${argumentsValue}` : ""}`
  pending = {
    requestID,
    text,
    status: "submitted",
    attachments: current.attachments.filter((item) => attachmentIDs.includes(item.id)),
  }
  vscode.postMessage({ type: "runCommand", requestID, key, arguments: argumentsValue, attachmentIDs })
  render(current)
}

function applyAction(action: NativeAction) {
  if (action === "new") {
    pending = undefined
    prompt.value = ""
    resizePrompt()
    commands.sync()
    prompt.focus()
    return
  }
  if (action === "sessions" || action === "models" || action === "agents" || action === "variants" || action === "skills" || action === "timeline") {
    providerConnect.close()
  }
  if (action !== "timeline") timeline.close()
  if (action === "sessions") history.open()
  if (action === "models") model.open()
  if (action === "agents") agent.open()
  if (action === "variants") variant.open()
  if (action === "skills") commands.openSource("skill")
  if (action === "timeline" && current) {
    history.close()
    timeline.open(current.messages)
  }
  if (action === "thinking") {
    const expanded = transcriptView.toggleActivities()
    announcer.textContent = expanded ? "OpenCode activity details expanded." : "OpenCode activity details collapsed."
  }
  if (action === "timestamps") {
    const visible = transcriptView.toggleTimestamps()
    announcer.textContent = visible ? "OpenCode message timestamps shown." : "OpenCode message timestamps hidden."
  }
}

function render(state: ViewState) {
  if ((previousPhase === "loading" || previousPhase === "stopping") && state.phase === "ready") {
    announcer.textContent = "OpenCode response complete."
  }
  previousPhase = state.phase
  composer.dataset.phase = state.phase

  const generating = state.phase === "loading" || state.phase === "stopping"
  commands.update(state.commands)
  const backendUnavailable = !state.trusted || !state.workspace
  const controlsDisabled = backendUnavailable || state.phase === "starting" || state.phase === "syncing" || generating
  const selectedModel = state.models.find(
    (item) => item.providerID === state.selection.model?.providerID && item.id === state.selection.model.modelID,
  )
  attachments.update(
    state.attachments,
    backendUnavailable || generating || state.phase === "syncing",
    !!selectedModel,
  )
  permissions.update(state.permissions)
  questions.update(state.questions)
  rollback.update(state.rolledBack, controlsDisabled)
  send.disabled = backendUnavailable || state.phase === "starting" || state.phase === "syncing" || state.phase === "stopping" || (!generating && !state.selection.model)
  send.classList.toggle("stop", generating)
  send.textContent = generating ? "■" : "↑"
  send.type = generating ? "button" : "submit"
  send.ariaLabel = generating ? "Stop" : "Send"
  send.title = generating ? "Stop" : "Send"
  send.onclick = generating ? () => current?.phase === "loading" && vscode.postMessage({ type: "stop" }) : null
  const providers = new Map(state.providers.map((item) => [item.id, item.name]))
  agent.update(
    state.agents.map((item) => ({ value: item.id, label: item.name })),
    state.selection.agent,
    state.phase === "starting" ? "Loading…" : "Agent",
    controlsDisabled,
  )
  model.update(
    state.models.map((item) => ({
      value: modelKey(item.providerID, item.id),
      label: item.name,
      group: providers.get(item.providerID) ?? item.providerID,
    })),
    state.selection.model ? modelKey(state.selection.model.providerID, state.selection.model.modelID) : undefined,
    state.phase === "starting" ? "Loading models…" : "Model",
    controlsDisabled,
  )
  const variants = selectedModel?.variants ?? []
  variant.hide(variants.length === 0)
  variant.update(
    [{ value: "", label: "Default" }, ...variants.map((id) => ({ value: id, label: id }))],
    state.selection.variant ?? "",
    "Default",
    controlsDisabled,
  )
  status.classList.toggle("error", state.phase === "error" || !!state.error || pending?.status === "rejected")
  status.textContent = pending?.error ?? state.error ??
    (!state.selection.model && state.phase === "ready" ? "Connect a provider with /connect." : phaseLabel(state.phase, state.trusted))

  const optimistic = pending
  const messages = optimistic && optimistic.status !== "rejected" && !state.messages.some((item) => item.id === optimistic.messageID)
    ? [...state.messages, {
      id: `pending-${optimistic.requestID}`,
      turnID: `pending-${optimistic.requestID}`,
      role: "user" as const,
      text: optimistic.text,
      attachments: optimistic.attachments.map((item) => item.range
        ? `${item.label}:${item.range.start}-${item.range.end}`
        : item.label),
    }]
    : state.messages
  emptyBrand.hidden = messages.length > 0
  usage.update(messages, state.models, state.providers, state.sessionUsage)
  transcriptView.render(messages, state.reviews, state.activities, {
    agents: state.agents,
    providers: state.providers,
    models: state.models,
    turnUsage: state.turnUsage,
  })
}

function cycleAgent(offset: number) {
  if (
    !current ||
    current.phase === "starting" ||
    current.phase === "loading" ||
    current.phase === "stopping" ||
    current.phase === "syncing"
  ) return false
  if (commands.isOpen() || attachments.isOpen() || agent.isOpen() || model.isOpen() || variant.isOpen() || current.agents.length < 2) return false
  const index = current.agents.findIndex((item) => item.id === current?.selection.agent)
  const start = index >= 0 ? index : offset > 0 ? -1 : 0
  const selected = current.agents[(start + offset + current.agents.length) % current.agents.length]
  if (!selected) return false
  vscode.postMessage({ type: "selectAgent", id: selected.id })
  return true
}

function phaseLabel(phase: ViewState["phase"], trusted: boolean) {
  if (!trusted) return "Trust this workspace to start OpenCode."
  if (phase === "starting") return "Starting OpenCode…"
  if (phase === "loading") return "OpenCode is responding…"
  if (phase === "stopping") return "Stopping…"
  if (phase === "syncing") return "Syncing OpenCode chat…"
  return ""
}

function modelKey(providerID: string, modelID: string) {
  return JSON.stringify([providerID, modelID])
}

function parseModelKey(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((item) => safeString(item))) return
    return { providerID: parsed[0], modelID: parsed[1] }
  } catch {}
}

function resizePrompt() {
  prompt.style.height = "auto"
  prompt.style.height = `${Math.min(prompt.scrollHeight, 144)}px`
}

function safeString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length <= maximum
}

function required<Target extends Element>(selector: string) {
  const element = document.querySelector<Target>(selector)
  if (!element) throw new Error("OpenCode Webview failed to initialize.")
  return element
}
