import { randomBytes } from "node:crypto"
import {
  Disposable,
  Uri,
  commands,
  env,
  window,
  workspace,
  type ExtensionContext,
  type Webview,
  type WebviewView,
  type WebviewViewProvider,
  type WorkspaceFolder,
} from "vscode"
import { AttachmentError, AttachmentStore } from "./attachments"
import {
  parseWebviewMessage,
  type ActionMessage,
  type AttachmentAction,
  type ComposerMessage,
  type HistoryMessage,
  type HistorySession,
  type NativeAction,
  type ProviderConnectMessage,
  type RollbackResultMessage,
  type SubmissionMessage,
  type UsageMessage,
  type ViewState,
  type WebviewMessage,
} from "./protocol"
import { SessionController } from "./session"
import { RequestGeneration } from "./session-history"
import { ReviewEditor } from "./review-editor"
import { UNAVAILABLE_TUI_SLASH_COMMANDS } from "./slash-parity"
import {
  ProviderConnectionGate,
  ProviderConnectionStore,
  providerPromptApplies,
  type ProviderConnection,
  type ProviderMethod,
} from "./provider-connection"

const VIEW_ID = "opencode.sidebar"
const MAX_PROMPT_LENGTH = 100_000
type ProviderConnectionOutcome = "connected" | "cancelled" | "failed"

export class SidebarProvider implements WebviewViewProvider, Disposable {
  static readonly viewID = VIEW_ID

  private view?: WebviewView
  private messageSubscription?: Disposable
  private disposables: Disposable[]
  private delivery = 0
  private deliveryStarted?: { id: number; time: number }
  private historySessions: HistorySession[] = []
  private historyRequests = new RequestGeneration()
  private attachments?: AttachmentStore
  private attachmentGeneration = 0
  private reviewEditor = new ReviewEditor()
  private providerConnectionGate = new ProviderConnectionGate()
  private providerConnections = new ProviderConnectionStore()
  private providerConnectionDirectory?: string
  private providerConnectionRequests = new RequestGeneration()

  constructor(
    private context: ExtensionContext,
    private session: SessionController,
    private timing: (message: string) => void,
  ) {
    this.disposables = [
      new Disposable(
        session.subscribe((state) => {
          void commands.executeCommand(
            "setContext",
            "opencode.native.generating",
            state.phase === "loading" || state.phase === "stopping",
          )
          void this.postState()
        }),
      ),
      new Disposable(
        session.subscribeSubmissions((event) => {
          void this.postSubmission({ type: "submission", ...event })
        }),
      ),
      window.onDidChangeActiveTextEditor(() => void this.postState()),
      window.onDidChangeTextEditorSelection(() => void this.postState()),
      workspace.onDidChangeWorkspaceFolders(() => {
        this.closeProviderConnection()
        void this.postState()
      }),
      workspace.onDidGrantWorkspaceTrust(() => void this.postState()),
      this.reviewEditor,
    ]
  }

  resolveWebviewView(view: WebviewView) {
    this.view = view
    this.deliveryStarted = undefined
    const root = Uri.joinPath(this.context.extensionUri, "dist")
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [root],
    }
    view.webview.html = html(view.webview, Uri.joinPath(root, "webview.js"), env.language)
    this.messageSubscription?.dispose()
    this.messageSubscription = view.webview.onDidReceiveMessage((message) => {
      const parsed = parseWebviewMessage(message)
      if (!parsed) {
        this.timing("Rejected an invalid Webview message")
        return
      }
      void this.handleMessage(parsed)
    })
    view.onDidDispose(() => {
      if (this.view !== view) return
      this.view = undefined
      this.deliveryStarted = undefined
      this.providerConnections.clear()
      this.providerConnectionDirectory = undefined
      this.providerConnectionRequests.invalidate()
      this.providerConnectionGate.cancel()
      void commands.executeCommand("setContext", "opencode.native.sidebarFocused", false)
      void commands.executeCommand("setContext", "opencode.native.composerFocused", false)
    })
  }

  dispose() {
    this.providerConnectionRequests.invalidate()
    this.providerConnectionGate.cancel()
    this.providerConnections.clear()
    this.providerConnectionDirectory = undefined
    void commands.executeCommand("setContext", "opencode.native.sidebarFocused", false)
    void commands.executeCommand("setContext", "opencode.native.composerFocused", false)
    void commands.executeCommand("setContext", "opencode.native.generating", false)
    this.messageSubscription?.dispose()
    this.disposables.forEach((disposable) => disposable.dispose())
  }

  async invokeAction(action: NativeAction) {
    if (action === "new") {
      if (!this.session.newChat()) return
      this.historyRequests.invalidate()
      this.attachmentGeneration++
      this.attachments?.clear()
      this.closeProviderConnection()
      await this.postHistory({ type: "history", status: "closed", sessions: [] })
      await this.postAction({ type: "action", action })
      await this.postState()
      return
    }
    if (action === "sessions" || action === "refresh") {
      const folder = this.workspaceFolder()
      if (!workspace.isTrusted || folder?.uri.scheme !== "file") {
        this.session.reportError("Trust and open a local workspace before using OpenCode.")
        return
      }
      if (action === "refresh") {
        await this.session.refresh()
        await this.postAction({ type: "action", action })
        return
      }
      await this.postAction({ type: "action", action })
      await this.loadHistory(folder)
      return
    }
    if (action === "themes") {
      await commands.executeCommand("workbench.action.selectTheme")
      return
    }
    if (action === "exit") {
      await commands.executeCommand("workbench.action.closeAuxiliaryBar")
      return
    }
    if (action === "help") {
      await this.showCommandHelp()
      return
    }
    if (action === "skills") {
      if (!this.session.snapshot().commands.some((command) => command.source === "skill")) {
        this.session.reportError("No OpenCode skills are available in this workspace.")
        return
      }
      await this.postAction({ type: "action", action })
      return
    }
    if (action === "thinking" || action === "timeline" || action === "timestamps") {
      await this.postAction({ type: "action", action })
      return
    }
    if (
      action === "connect" || action === "org" || action === "mcps" || action === "status" || action === "compact" ||
      action === "rename" || action === "copy" || action === "export" || action === "share" ||
      action === "unshare" || action === "fork" || action === "undo" || action === "redo" ||
      action === "diff" || action === "debug"
    ) {
      const folder = this.workspaceFolder()
      if (!workspace.isTrusted || folder?.uri.scheme !== "file") {
        this.session.reportError("Trust and open a local workspace before using OpenCode.")
        return
      }
      if (action === "connect") await this.runProviderConnection(() => this.openProviderConnection(folder))
      if (action === "org") await this.switchConsoleOrganization(folder)
      if (action === "mcps") await this.manageMcps(folder)
      if (action === "status") await this.showSystemStatus(folder)
      if (action === "compact" && !(await this.session.compact())) {
        this.session.reportError("Start an idle OpenCode chat before compacting it.")
      }
      if (action === "rename") {
        const title = await window.showInputBox({
          title: "Rename OpenCode chat",
          prompt: "Enter a new title for the current chat",
          ignoreFocusOut: true,
          validateInput: (value) => value.trim().length > 120 ? "Use 120 characters or fewer." : undefined,
        })
        if (title !== undefined && !(await this.session.renameCurrentSession(title))) {
          this.session.reportError("OpenCode could not rename the current chat.")
        }
      }
      if (action === "copy") await this.copyTranscript()
      if (action === "export") await this.exportTranscript(folder)
      if (action === "share") await this.shareCurrentSession()
      if (action === "unshare") await this.unshareCurrentSession()
      if (action === "fork") await this.forkCurrentSession(folder)
      if (action === "undo") await this.mutateHistory("undo")
      if (action === "redo") await this.mutateHistory("redo")
      if (action === "diff") await this.openLatestReview()
      if (action === "debug") await this.showDebugInfo(folder)
      await this.postState()
      return
    }
    await this.postAction({ type: "action", action })
  }

  async openUsage() {
    await commands.executeCommand(`${VIEW_ID}.focus`)
    return this.view?.webview.postMessage({ type: "usage", action: "open" } satisfies UsageMessage) ?? false
  }

  async addExplorerFiles(resources: Uri[]) {
    if (!workspace.isTrusted) {
      this.session.reportError("Trust this workspace before adding files to OpenCode.")
      return
    }
    if (!resources.length || resources.some((resource) => resource.scheme !== "file")) {
      this.session.reportError("Select regular files from the current workspace.")
      return
    }
    if (attachmentBusy(this.session.snapshot().phase)) {
      this.session.reportError("Wait for the current OpenCode operation before adding context.")
      return
    }
    const folder = this.workspaceFolder()
    if (!folder || folder.uri.scheme !== "file" || resources.some((resource) =>
      workspace.getWorkspaceFolder(resource)?.uri.toString() !== folder.uri.toString()
    )) {
      this.session.reportError("Only files from the active OpenCode workspace can be added.")
      return
    }
    const generation = this.attachmentGeneration
    try {
      await this.attachmentStore(folder).addFiles(resources.map((resource) => resource.fsPath))
      if (generation !== this.attachmentGeneration) return
      await commands.executeCommand(`${VIEW_ID}.focus`)
      await this.postState()
    } catch (error) {
      this.session.reportError(attachmentError(error))
    }
  }

  private async handleMessage(message: WebviewMessage) {
    if (message.type === "ready") {
      await this.postState()
      const folder = this.workspaceFolder()
      if (workspace.isTrusted && folder?.uri.scheme === "file") void this.session.prepare(folder.uri.fsPath)
      return
    }
    if (message.type === "rendered") {
      if (this.deliveryStarted?.id === message.id) {
        this.timing(`Webview rendered state in ${Math.round(performance.now() - this.deliveryStarted.time)}ms`)
        this.deliveryStarted = undefined
      }
      return
    }
    if (message.type === "sidebarFocus") {
      await commands.executeCommand("setContext", "opencode.native.sidebarFocused", message.focused)
      return
    }
    if (message.type === "composerFocus") {
      await commands.executeCommand("setContext", "opencode.native.composerFocused", message.focused)
      return
    }
    if (message.type === "providerConnectClose") {
      this.closeProviderConnection()
      return
    }
    if (message.type === "invokeAction") {
      await this.invokeAction(message.action)
      return
    }

    if (!workspace.isTrusted) {
      this.reject(message, "Trust this workspace before starting OpenCode or enabling tools.")
      return
    }

    const folder = this.workspaceFolder()
    if (!folder) {
      this.reject(message, "Open a local workspace folder before starting OpenCode.")
      return
    }
    if (folder.uri.scheme !== "file") {
      this.reject(message, "This PoC requires a filesystem-backed workspace folder.")
      return
    }

    if (message.type === "selectProviderConnection") {
      await this.runProviderConnection(() => this.selectProviderConnection(folder, message.key))
      return
    }
    if (message.type === "selectProviderMethod") {
      await this.runProviderConnection(() => this.selectProviderMethod(folder, message.key))
      return
    }

    if (message.type === "stop") {
      await this.session.stop()
      return
    }
    if (message.type === "restoreRolledBack") {
      let status: RollbackResultMessage["status"] = "rejected"
      try {
        const changed = await this.session.restoreRolledBackMessage(message.key)
        if (changed) status = "restored"
        if (!changed && !this.session.snapshot().error) {
          this.session.reportError("That rolled-back message changed before it could be restored. Refresh and try again.")
        }
      } catch {
        this.session.reportError("OpenCode could not restore that rolled-back message safely. Refresh and try again.")
      }
      await this.postRollbackResult({ type: "rollbackResult", key: message.key, status })
      await this.postState()
      return
    }
    if (message.type === "selectSession") {
      this.attachmentGeneration++
      this.attachments?.clear()
      this.closeProviderConnection()
      if (await this.session.switchSession(message.key)) {
        this.historyRequests.invalidate()
        await this.postHistory({ type: "history", status: "closed", sessions: [] })
      } else {
        await this.postHistory({
          type: "history",
          status: "error",
          sessions: this.historySessions,
          error: "OpenCode chat could not be opened. The current chat was kept unchanged.",
        })
      }
      return
    }
    if (message.type === "renameSession") {
      if (await this.session.renameSession(message.key, message.title)) await this.loadHistory(folder, false)
      else await this.historyError("OpenCode could not rename that chat. Its previous title was kept.")
      return
    }
    if (message.type === "deleteSession") {
      const title = this.session.sessionTitle(message.key)
      if (!title) {
        await this.historyError("That OpenCode chat is no longer available.")
        return
      }
      const confirmed = await window.showWarningMessage(
        `Delete “${title}”? This permanently removes the OpenCode session and any child sessions.`,
        { modal: true },
        "Delete",
      )
      if (confirmed !== "Delete") return
      if (this.historySessions.find((session) => session.key === message.key)?.current) {
        this.attachmentGeneration++
        this.attachments?.clear()
      }
      if (await this.session.deleteSession(message.key)) await this.loadHistory(folder, false)
      else await this.historyError("OpenCode could not delete that chat. No history was changed.")
      return
    }
    if (message.type === "attachmentAction") {
      if (attachmentBusy(this.session.snapshot().phase)) return
      await this.addAttachment(folder, message.action)
      return
    }
    if (message.type === "uploadFile") {
      if (attachmentBusy(this.session.snapshot().phase)) return
      const generation = this.attachmentGeneration
      try {
        await this.attachmentStore(folder).addLocalUpload(message.name, message.mime, message.data)
        if (generation !== this.attachmentGeneration) return
        await this.postState()
      } catch (error) {
        this.session.reportError(attachmentError(error))
      }
      return
    }
    if (message.type === "removeAttachment") {
      if (attachmentBusy(this.session.snapshot().phase)) return
      const store = this.attachmentStore(folder)
      if (!store.remove(message.id)) this.session.reportError("That context attachment is no longer available.")
      await this.postState()
      return
    }
    if (message.type === "openReview") {
      try {
        await this.reviewEditor.open(await this.session.review(message.reviewKey, message.fileKey))
      } catch {
        this.session.reportError("OpenCode could not open that file review. Refresh the chat and try again.")
      }
      return
    }
    if (message.type === "replyPermission") {
      await this.session.replyPermission(message.key, message.decision)
      return
    }
    if (message.type === "replyQuestion") {
      await this.session.replyQuestion(message.key, message.answers)
      return
    }
    if (message.type === "rejectQuestion") {
      await this.session.replyQuestion(message.key)
      return
    }
    if (message.type === "selectAgent") {
      if (!this.session.selectAgent(message.id)) this.session.reportError("That OpenCode agent is unavailable.")
      return
    }
    if (message.type === "selectModel") {
      if (!this.session.selectModel({ providerID: message.providerID, modelID: message.modelID })) {
        this.session.reportError("That OpenCode model is unavailable.")
      }
      return
    }
    if (message.type === "selectVariant") {
      if (!this.session.selectVariant(message.id)) this.session.reportError("That model variant is unavailable.")
      return
    }

    const store = this.attachmentStore(folder)
    const generation = this.attachmentGeneration
    let files
    try {
      files = await store.resolve(message.attachmentIDs, this.session.supportsImageInput())
    } catch (error) {
      const messageText = attachmentError(error)
      await this.postSubmission({ type: "submission", requestID: message.requestID, status: "rejected", error: messageText })
      this.session.reportError(messageText)
      return
    }
    if (generation !== this.attachmentGeneration) {
      await this.postSubmission({
        type: "submission",
        requestID: message.requestID,
        status: "rejected",
        error: "The OpenCode chat changed before the prompt was sent.",
      })
      return
    }
    await this.postSubmission({ type: "submission", requestID: message.requestID, status: "submitted" })
    this.timing("Prompt received from Webview")
    const sent = message.type === "runCommand"
      ? await this.session.runCommand(message.requestID, folder.uri.fsPath, message.key, message.arguments, files)
      : await this.session.send(message.requestID, folder.uri.fsPath, message.text, files)
    if (sent) {
      store.removeMany(message.attachmentIDs)
      await this.postState()
    }
  }

  private reject(message: WebviewMessage, error: string) {
    if (message.type === "sendPrompt" || message.type === "runCommand") {
      void this.postSubmission({ type: "submission", requestID: message.requestID, status: "rejected", error })
    }
    this.session.reportError(error)
  }

  private postSubmission(message: SubmissionMessage) {
    return this.view?.webview.postMessage(message)
  }

  private postAction(message: ActionMessage) {
    return this.view?.webview.postMessage(message)
  }

  private postComposer(message: ComposerMessage) {
    return this.view?.webview.postMessage(message)
  }

  private postRollbackResult(message: RollbackResultMessage) {
    return this.view?.webview.postMessage(message)
  }

  private postHistory(message: HistoryMessage) {
    return this.view?.webview.postMessage(message)
  }

  private postProviderConnect(message: ProviderConnectMessage) {
    return this.view?.webview.postMessage(message)
  }

  private postState() {
    const view = this.view
    if (!view) return
    const folder = this.workspaceFolder()
    const id = ++this.delivery
    if (!this.deliveryStarted) this.deliveryStarted = { id, time: performance.now() }
    const snapshot = this.session.snapshot()
    const state = {
      phase: snapshot.phase,
      messages: snapshot.messages,
      commands: snapshot.commands,
      agents: snapshot.agents.map((agent) => ({ id: agent.id, name: agent.name })),
      providers: snapshot.providers.map((provider) => ({ id: provider.id, name: provider.name })),
      models: snapshot.models.map((model) => ({
        providerID: model.providerID,
        id: model.id,
        name: model.name,
        variants: model.variants,
        ...(model.contextLimit === undefined ? {} : { contextLimit: model.contextLimit }),
        audio: model.audio === true,
        image: model.image,
        video: model.video === true,
        pdf: model.pdf === true,
      })),
      selection: snapshot.selection,
      error: snapshot.error,
      workspace: !!folder,
      trusted: workspace.isTrusted,
      attachments: folder ? this.attachmentStore(folder).snapshot() : [],
      reviews: snapshot.reviews,
      permissions: snapshot.permissions,
      questions: snapshot.questions,
      activities: snapshot.activities,
      turnUsage: snapshot.turnUsage,
      sessionUsage: snapshot.sessionUsage,
      rolledBack: snapshot.rolledBack,
    } satisfies ViewState
    return view.webview.postMessage({
      type: "state",
      id,
      state,
    })
  }

  private workspaceFolder() {
    const directory = this.session.boundDirectory()
    if (!directory) return currentWorkspaceFolder()
    return workspace.workspaceFolders?.find((folder) => folder.uri.fsPath === directory)
  }

  private attachmentStore(folder: WorkspaceFolder) {
    if (!this.attachments || this.attachments.boundDirectory() !== folder.uri.fsPath) {
      this.attachments = new AttachmentStore(folder.uri.fsPath)
    }
    return this.attachments
  }

  private async addAttachment(folder: WorkspaceFolder, action: AttachmentAction) {
    const store = this.attachmentStore(folder)
    const generation = this.attachmentGeneration
    try {
      if (action === "workspaceFiles") {
        const selected = await window.showOpenDialog({
          defaultUri: folder.uri,
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: "Add context",
        })
        if (!selected?.length) return
        if (generation !== this.attachmentGeneration) return
        if (selected.some((uri) => uri.scheme !== "file")) throw new AttachmentError("Only local workspace files can be attached.")
        await store.addFiles(selected.map((uri) => uri.fsPath))
      } else {
        const editor = window.activeTextEditor
        if (!editor || editor.document.uri.scheme !== "file" ||
          workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() !== folder.uri.toString()) {
          throw new AttachmentError("Open a file in the current workspace first.")
        }
        if (action === "currentFile") {
          await store.addSnapshot(editor.document.uri.fsPath, editor.document.getText(), "file")
        } else {
          if (editor.selection.isEmpty) throw new AttachmentError("Select text in the current editor first.")
          await store.addSnapshot(editor.document.uri.fsPath, editor.document.getText(editor.selection), "selection", {
            start: editor.selection.start.line + 1,
            end: editor.selection.end.line + 1,
          })
        }
      }
      if (generation !== this.attachmentGeneration) return
      await this.postState()
    } catch (error) {
      this.session.reportError(attachmentError(error))
    }
  }

  private async openProviderConnection(folder: WorkspaceFolder, refresh = true) {
    const generation = this.providerConnectionRequests.begin()
    this.providerConnections.clear()
    this.providerConnectionDirectory = folder.uri.fsPath
    await this.postProviderConnect({ type: "providerConnect", status: "loading", message: "Loading providers…" })
    try {
      const providers = refresh
        ? await this.session.refreshProviderConnections(folder.uri.fsPath)
        : await this.session.listProviderConnections(folder.uri.fsPath)
      if (!this.providerConnectionIsCurrent(folder, generation)) return
      if (!providers) {
        await this.providerConnectionError(
          "Wait for the current OpenCode response to finish before connecting a provider.",
        )
        return
      }
      await this.postProviderConnect({
        type: "providerConnect",
        status: "providers",
        providers: this.providerConnections.replace(providers),
      })
    } catch {
      if (!this.providerConnectionIsCurrent(folder, generation)) return
      const sessionError = this.session.snapshot().error
      await this.providerConnectionError(
        sessionError?.includes("event connection could not be restored")
          ? sessionError
          : "OpenCode could not load providers. Check the Core connection and try again.",
      )
    }
  }

  private async selectProviderConnection(folder: WorkspaceFolder, key: string) {
    if (!this.providerConnectionIsCurrent(folder)) return
    const generation = this.providerConnectionRequests.begin()
    try {
      const fresh = await this.session.listProviderConnections(folder.uri.fsPath)
      if (!this.providerConnectionIsCurrent(folder, generation)) return
      const selected = this.providerConnections.selectProvider(key, fresh)
      if (!selected) return this.openProviderConnection(folder, false)
      if (selected.methods.length === 1) {
        await this.selectProviderMethod(folder, selected.methods[0]!.key)
        return
      }
      await this.postProviderConnect({
        type: "providerConnect",
        status: "methods",
        provider: selected.name,
        methods: selected.methods,
      })
    } catch {
      if (!this.providerConnectionIsCurrent(folder, generation)) return
      await this.providerConnectionError("OpenCode could not load sign-in methods. Choose the provider again.")
    }
  }

  private async selectProviderMethod(folder: WorkspaceFolder, key: string) {
    if (!this.providerConnectionIsCurrent(folder)) return
    const generation = this.providerConnectionRequests.begin()
    try {
      const fresh = await this.session.listProviderConnections(folder.uri.fsPath)
      if (!this.providerConnectionIsCurrent(folder, generation)) return
      const selected = this.providerConnections.resolveMethod(key, fresh)
      if (!selected) return this.openProviderConnection(folder, false)
      await this.postProviderConnect({
        type: "providerConnect",
        status: "busy",
        message: `Starting ${selected.method.label}…`,
      })
      const outcome = await this.completeProviderConnection(folder, selected.provider, selected.method, generation)
      if (outcome !== "connected") {
        if (!this.providerConnectionIsCurrent(folder, generation)) return
        if (outcome === "cancelled") await this.openProviderConnection(folder, false)
        else await this.providerConnectionError("OpenCode could not complete that sign-in. Check the credential and try again.")
        return
      }
      if (!this.providerConnectionIsCurrent(folder, generation)) return
      this.providerConnections.clear()
      this.providerConnectionDirectory = undefined
      this.providerConnectionRequests.invalidate()
      await this.postProviderConnect({ type: "providerConnect", status: "closed" })
      await this.postState()
      await this.postAction({ type: "action", action: "models" })
    } catch {
      if (!this.providerConnectionIsCurrent(folder, generation)) return
      await this.providerConnectionError("OpenCode could not connect that provider. Check the credential and try again.")
    }
  }

  private async completeProviderConnection(
    folder: WorkspaceFolder,
    provider: ProviderConnection,
    method: ProviderMethod,
    generation: number,
  ): Promise<ProviderConnectionOutcome> {
    const values = await this.providerPromptValues(method)
    if (!values || !this.providerConnectionIsCurrent(folder, generation)) return "cancelled"
    if (method.type === "api") {
      const key = await window.showInputBox({
        title: method.label,
        prompt: `Enter the API key for ${provider.name}`,
        password: true,
        ignoreFocusOut: true,
      })
      if (!key || !this.providerConnectionIsCurrent(folder, generation)) return "cancelled"
      const connected = await this.session.connectProviderKey(folder.uri.fsPath, provider.id, method.index, values, key)
      if (!this.providerConnectionIsCurrent(folder, generation)) return "cancelled"
      return connected ? "connected" : "failed"
    }
    const authorization = await this.session.authorizeProvider(
      folder.uri.fsPath,
      provider.id,
      method.index,
      values,
    )
    if (!this.providerConnectionIsCurrent(folder, generation)) return "cancelled"
    if (!authorization) return "failed"
    const open = await window.showInformationMessage(
      `${authorization.instructions}\n\nDestination: ${authorization.origin}`,
      { modal: true },
      "Open Browser",
    )
    if (open !== "Open Browser") return "cancelled"
    if (!(await env.openExternal(Uri.parse(authorization.url)))) return "failed"
    if (!this.providerConnectionIsCurrent(folder, generation)) return "cancelled"
    const code = authorization.method === "code" ? await window.showInputBox({
      title: method.label,
      prompt: "Enter the authorization code",
      password: true,
      ignoreFocusOut: true,
    }) : undefined
    if ((authorization.method === "code" && !code) || !this.providerConnectionIsCurrent(folder, generation)) {
      return "cancelled"
    }
    const connected = await this.session.completeProviderOAuth(folder.uri.fsPath, provider.id, method.index, code)
    if (!this.providerConnectionIsCurrent(folder, generation)) return "cancelled"
    return connected ? "connected" : "failed"
  }

  private async providerPromptValues(method: ProviderMethod) {
    const values = Object.create(null) as Record<string, string>
    for (const prompt of method.prompts) {
      if (!providerPromptApplies(prompt, values)) continue
      if (prompt.type === "select") {
        const selected = await window.showQuickPick(
          (prompt.options ?? []).map((option) => ({
            label: option.label,
            description: option.hint,
            value: option.value,
          })),
          { title: method.label, placeHolder: prompt.message },
        )
        if (!selected) return
        values[prompt.key] = selected.value
        continue
      }
      const value = await window.showInputBox({
        title: method.label,
        prompt: prompt.message,
        placeHolder: prompt.placeholder,
        password: true,
        ignoreFocusOut: true,
      })
      if (!value) return
      values[prompt.key] = value
    }
    return values
  }

  private providerConnectionIsCurrent(folder: WorkspaceFolder, generation?: number) {
    return (generation === undefined || this.providerConnectionRequests.accepts(generation)) &&
      this.providerConnectionDirectory === folder.uri.fsPath && this.workspaceFolder()?.uri.fsPath === folder.uri.fsPath
  }

  private closeProviderConnection() {
    this.providerConnectionRequests.invalidate()
    this.providerConnectionGate.cancel()
    this.providerConnections.clear()
    this.providerConnectionDirectory = undefined
    void this.postProviderConnect({ type: "providerConnect", status: "closed" })
  }

  private async runProviderConnection(operation: () => Promise<void>) {
    const token = this.providerConnectionGate.begin()
    if (!token) return
    try {
      await operation()
    } finally {
      this.providerConnectionGate.finish(token)
    }
  }

  private async providerConnectionError(message: string) {
    this.session.reportError(message)
    await this.postProviderConnect({ type: "providerConnect", status: "error", message })
  }

  private async manageMcps(folder: WorkspaceFolder) {
    try {
      const items = await this.session.listMcpConnections(folder.uri.fsPath)
      if (!items.length) {
        await window.showInformationMessage("No MCP servers are configured for this OpenCode workspace.")
        return
      }
      const selected = await window.showQuickPick(items.map((item) => ({
        label: `${item.status === "connected" ? "$(pass)" : "$(circle-large-outline)"} ${safeQuickPickLabel(item.name)}`,
        description: mcpStatusLabel(item.status),
        detail: item.status === "connected" ? "Select to disconnect" : "Select to connect or retry",
        item,
      })), {
        title: "OpenCode MCP servers",
        placeHolder: "Choose a server to toggle",
        matchOnDescription: true,
      })
      if (!selected) return
      const updated = await this.session.toggleMcp(folder.uri.fsPath, selected.item.name)
      if (!updated) throw new Error("MCP state changed")
      await window.showInformationMessage(`${selected.item.name}: ${mcpStatusLabel(updated.status)}.`)
    } catch {
      this.session.reportError("OpenCode could not update MCP servers. Check their configuration and try again.")
    }
  }

  private async switchConsoleOrganization(folder: WorkspaceFolder) {
    try {
      const organizations = await this.session.listConsoleOrganizations(folder.uri.fsPath)
      if (organizations.length < 2) {
        await window.showInformationMessage(
          organizations.length ? "Only one OpenCode Console organization is available." : "No switchable OpenCode Console organizations are available.",
        )
        return
      }
      const selected = await window.showQuickPick(organizations.map((organization) => ({
        label: `${organization.active ? "$(check) " : ""}${safeQuickPickLabel(organization.name)}`,
        description: safeQuickPickLabel(organization.email),
        detail: organization.active ? "Current organization" : "Switch to this organization",
        organization,
      })), {
        title: "Switch OpenCode Console organization",
        placeHolder: "Choose an organization",
        matchOnDescription: true,
      })
      if (!selected || selected.organization.active) return
      const switched = await this.session.switchConsoleOrganization(
        folder.uri.fsPath,
        selected.organization.accountID,
        selected.organization.orgID,
      )
      if (!switched) throw new Error("organization changed")
      await window.showInformationMessage(`OpenCode Console switched to ${selected.organization.name}.`)
    } catch {
      this.session.reportError("OpenCode could not switch Console organizations. Refresh and try again.")
    }
  }

  private async showSystemStatus(folder: WorkspaceFolder) {
    try {
      const items = await this.session.listSystemStatus(folder.uri.fsPath)
      if (!items.length) {
        await window.showInformationMessage("OpenCode has no active MCP, LSP, or formatter status to show.")
        return
      }
      await window.showQuickPick(items.map((item) => ({
        label: `${statusIcon(item.kind)} ${safeQuickPickLabel(item.name)}`,
        description: `${item.kind.toUpperCase()} · ${statusLabel(item.status)}`,
        detail: item.detail,
      })), {
        title: "OpenCode status",
        placeHolder: "MCP, language server, and formatter status",
        matchOnDescription: true,
        matchOnDetail: true,
      })
    } catch {
      this.session.reportError("OpenCode system status is unavailable. Try refreshing the chat.")
    }
  }

  private showCommandHelp() {
    return window.showQuickPick([
      { label: "/connect", description: "Connect an AI provider" },
      { label: "/org", description: "Switch OpenCode Console organization · aliases: /orgs, /switch-org" },
      { label: "/mcps", description: "View and toggle MCP servers" },
      { label: "/status", description: "View MCP, LSP, and formatter status" },
      { label: "/sessions", description: "Open chat history · aliases: /resume, /continue" },
      { label: "/new", description: "Start a new chat · alias: /clear" },
      { label: "/refresh", description: "Reload the current OpenCode chat" },
      { label: "/models", description: "Choose a model · alias: /mo" },
      { label: "/agents", description: "Choose an agent" },
      { label: "/variants", description: "Choose a reasoning variant" },
      { label: "/compact", description: "Compact this chat · alias: /summarize" },
      { label: "/rename", description: "Rename this chat" },
      { label: "/copy", description: "Copy the visible chat transcript" },
      { label: "/export", description: "Save the visible chat transcript" },
      { label: "/share", description: "Create and copy a public chat link" },
      { label: "/unshare", description: "Remove the public chat link" },
      { label: "/fork", description: "Fork this chat from a message" },
      { label: "/timeline", description: "Jump to a turn in this chat" },
      { label: "/undo", description: "Undo the previous user turn and its file changes" },
      { label: "/redo", description: "Restore the last undone turn and its file changes" },
      { label: "/diff", description: "Review the latest changed file" },
      { label: "/thinking", description: "Expand or collapse activity details · alias: /toggle-thinking" },
      { label: "/timestamps", description: "Show or hide message timestamps · alias: /toggle-timestamps" },
      { label: "/skills", description: "Browse available skills" },
      { label: "/themes", description: "Choose the VS Code color theme" },
      { label: "/debug", description: "View safe OpenCode Native diagnostics" },
      { label: "/help", description: "Show Native commands" },
      { label: "/exit", description: "Close the secondary sidebar · aliases: /quit, /q" },
      ...UNAVAILABLE_TUI_SLASH_COMMANDS.map((command) => ({
        label: `/${command.name}`,
        description: `TUI-only/conditional · ${command.note}`,
      })),
    ], { title: "OpenCode Native commands", placeHolder: "Type / in the composer to run a command" })
  }

  private async copyTranscript() {
    const transcript = this.transcriptText()
    if (!transcript) {
      this.session.reportError("There is no visible OpenCode transcript to copy.")
      return
    }
    await env.clipboard.writeText(transcript)
    await window.showInformationMessage("OpenCode transcript copied to the clipboard.")
  }

  private transcriptText() {
    return this.session.snapshot().messages
      .filter((message) => message.text.trim())
      .map((message) => `${message.role === "user" ? "You" : "OpenCode"}:\n${message.text}`)
      .join("\n\n")
  }

  private async exportTranscript(folder: WorkspaceFolder) {
    const transcript = this.transcriptText()
    if (!transcript) {
      this.session.reportError("There is no visible OpenCode transcript to export.")
      return
    }
    const target = await window.showSaveDialog({
      title: "Export OpenCode chat",
      defaultUri: Uri.joinPath(folder.uri, "opencode-chat.md"),
      filters: { Markdown: ["md"], Text: ["txt"] },
      saveLabel: "Export",
    })
    if (!target) return
    try {
      await workspace.fs.writeFile(target, new TextEncoder().encode(transcript))
      await window.showInformationMessage(`OpenCode chat exported to ${target.fsPath || target.toString(true)}.`)
    } catch {
      this.session.reportError("OpenCode could not export the chat to that location.")
    }
  }

  private async shareCurrentSession() {
    const confirmed = await window.showWarningMessage(
      "Create a public link to this OpenCode chat? Anyone with the link may be able to read it.",
      { modal: true },
      "Share",
    )
    if (confirmed !== "Share") return
    try {
      const url = await this.session.shareCurrentSession()
      if (!url) throw new Error("share unavailable")
      await env.clipboard.writeText(url)
      await window.showInformationMessage("OpenCode share link copied to the clipboard.")
    } catch {
      this.session.reportError("OpenCode could not create a safe share link for this chat.")
    }
  }

  private async unshareCurrentSession() {
    try {
      if (!(await this.session.unshareCurrentSession())) throw new Error("unshare unavailable")
      await window.showInformationMessage("This OpenCode chat is private again.")
    } catch {
      this.session.reportError("OpenCode could not remove this chat's share link.")
    }
  }

  private async mutateHistory(action: "undo" | "redo") {
    const restoredPrompt = action === "undo"
      ? this.session.snapshot().messages.filter((message) => message.role === "user").at(-1)?.text
      : undefined
    try {
      const changed = action === "undo"
        ? await this.session.undoCurrentSession()
        : await this.session.redoCurrentSession()
      if (!changed) {
        this.session.reportError(action === "undo"
          ? "There is no completed OpenCode turn to undo."
          : "There is no undone OpenCode turn to restore.")
        return
      }
      if (action === "undo" && restoredPrompt !== undefined) {
        this.attachmentGeneration++
        this.attachments?.clear()
        await this.postComposer({ type: "composer", text: restoredPrompt })
      }
      if (action === "redo" && !this.session.hasUndoneTurns()) {
        this.attachmentGeneration++
        this.attachments?.clear()
        await this.postComposer({ type: "composer", text: "" })
      }
    } catch {
      this.session.reportError(action === "undo"
        ? "OpenCode could not undo that turn safely."
        : "OpenCode could not restore that turn safely.")
    }
  }

  private async forkCurrentSession(folder: WorkspaceFolder) {
    const messages = this.session.snapshot().messages.filter((message) => message.role === "user")
    if (!messages.length) {
      this.session.reportError("Send a message before forking this OpenCode chat.")
      return
    }
    const selected = await window.showQuickPick([{
      label: "$(git-branch) Full session",
      description: "Fork everything currently visible",
      messageID: undefined,
      text: undefined,
    }, ...messages.map((message, index) => ({
      label: `${index + 1}. ${safeQuickPickLabel(safePreview(message.text) || "Message")}`,
      description: "Fork before this turn and restore its prompt",
      messageID: message.id,
      text: message.text,
    }))], {
      title: "Fork OpenCode chat",
      placeHolder: "Choose the first turn to leave out of the fork",
    })
    if (!selected) return
    try {
      if (!(await this.session.forkCurrentSession(selected.messageID))) throw new Error("fork unavailable")
    } catch {
      this.session.reportError("OpenCode could not fork this chat from that message.")
      return
    }
    this.attachmentGeneration++
    this.attachments?.clear()
    this.historyRequests.invalidate()
    await this.loadHistory(folder, false)
    if (selected.text !== undefined) await this.postComposer({ type: "composer", text: selected.text })
  }

  private async openLatestReview() {
    const review = this.session.snapshot().reviews.at(-1)
    const file = review?.files.find((item) => item.reviewable && !item.conflicted)
    if (!review || !file) {
      this.session.reportError("There is no reviewable OpenCode file change in this chat.")
      return
    }
    try {
      await this.reviewEditor.open(await this.session.review(review.key, file.key))
    } catch (error) {
      this.session.reportError(error instanceof Error ? error.message : "That OpenCode file review is unavailable.")
    }
  }

  private async showDebugInfo(folder: WorkspaceFolder) {
    const state = this.session.snapshot()
    await window.showInformationMessage([
      `OpenCode Native: ${state.phase}`,
      `Workspace: ${folder.name}`,
      `Models: ${state.models.length}`,
      `Commands: ${state.commands.length}`,
      `Pending approvals: ${state.permissions.length}`,
    ].join(" · "))
  }

  private async loadHistory(folder: WorkspaceFolder, loading = true) {
    const generation = this.historyRequests.begin()
    if (loading) await this.postHistory({ type: "history", status: "loading", sessions: [] })
    try {
      const sessions = await this.session.listHistory(folder.uri.fsPath)
      if (!this.historyRequests.accepts(generation)) return
      this.historySessions = sessions
      await this.postHistory({ type: "history", status: "ready", sessions })
    } catch {
      if (!this.historyRequests.accepts(generation)) return
      await this.historyError("OpenCode chat history could not be loaded.")
    }
  }

  private historyError(error: string) {
    return this.postHistory({ type: "history", status: "error", sessions: this.historySessions, error })
  }
}

function currentWorkspaceFolder() {
  const editor = window.activeTextEditor
  const active = editor ? workspace.getWorkspaceFolder(editor.document.uri) : undefined
  if (active) return active
  if (workspace.workspaceFolders?.length === 1) return workspace.workspaceFolders[0]
}

function attachmentError(error: unknown) {
  return error instanceof AttachmentError ? error.message : "OpenCode could not add that context attachment."
}

function attachmentBusy(phase: ViewState["phase"]) {
  return phase === "starting" || phase === "loading" || phase === "stopping" || phase === "syncing"
}

function safeQuickPickLabel(value: string) {
  return value.replaceAll("$(", "$ (")
}

function safePreview(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
}

function mcpStatusLabel(status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration") {
  if (status === "connected") return "Connected"
  if (status === "disabled") return "Disabled"
  if (status === "needs_auth") return "Needs authentication"
  if (status === "needs_client_registration") return "Needs client registration"
  return "Failed"
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase())
}

function statusIcon(kind: "mcp" | "lsp" | "formatter") {
  if (kind === "mcp") return "$(server)"
  if (kind === "lsp") return "$(symbol-interface)"
  return "$(wand)"
}

function html(webview: Webview, script: Uri, language: string) {
  const nonce = randomBytes(16).toString("base64")
  const scriptUri = webview.asWebviewUri(script)
  const locale = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) ? language : "en"
  const direction = /^(ar|dv|fa|he|ps|ur)(-|$)/i.test(locale) ? "rtl" : "ltr"
  return `<!doctype html>
<html lang="${locale}" dir="${direction}">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
    <style nonce="${nonce}">
      :root {
        color-scheme: light dark;
        --opencode-accent: #fab283;
        --opencode-accent-hover: #ffc09f;
        --opencode-accent-soft: rgba(250, 178, 131, 0.11);
        --opencode-accent-border: rgba(250, 178, 131, 0.46);
      }
      body.vscode-light, body.vscode-high-contrast-light {
        --opencode-accent: #d68c27;
        --opencode-accent-hover: #b0851f;
        --opencode-accent-soft: rgba(214, 140, 39, 0.09);
        --opencode-accent-border: rgba(214, 140, 39, 0.48);
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      body {
        margin: 0;
        overflow: hidden;
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        font: var(--vscode-font-size)/1.5 var(--vscode-font-family);
      }
      button, select, textarea { font: inherit; }
      main { position: relative; height: 100vh; height: 100dvh; display: grid; grid-template-rows: minmax(0, 1fr) auto auto auto auto; }
      .history { position: absolute; z-index: 50; inset: 0; display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr); padding: 8px 9px; background: color-mix(in srgb, var(--vscode-sideBar-background) 97%, transparent); }
      .history > header { display: flex; align-items: center; justify-content: space-between; min-height: 32px; padding: 0 3px 5px; }
      .history h2 { margin: 0; font-size: 13px; font-weight: 600; }
      .history-actions { display: flex; gap: 2px; }
      .history-icon { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; font-size: 17px; }
      .history-icon:hover { color: var(--opencode-accent); background: var(--vscode-toolbar-hoverBackground); }
      .history-search-shell { height: 36px; display: flex; align-items: center; gap: 7px; margin: 5px 1px 8px; padding: 0 12px; border: 1px solid var(--vscode-widget-border); border-radius: 18px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-input-background) 72%, transparent); }
      .history-search-shell:focus-within { border-color: var(--opencode-accent-border); box-shadow: 0 0 0 1px var(--opencode-accent-soft); }
      .history-search-shell svg { width: 14px; height: 14px; flex: none; }
      .history-search { min-width: 0; width: 100%; height: 32px; padding: 0; border: 0; outline: 0; color: var(--vscode-input-foreground); background: transparent; }
      .history-search::-webkit-search-cancel-button { display: none; }
      .history-list-heading { min-height: 31px; display: flex; align-items: center; justify-content: space-between; padding: 0 10px; border-bottom: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; }
      .history-list-heading svg { width: 14px; height: 14px; }
      .history-status { min-height: 0; padding: 0 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
      .history-status:empty { display: none; }
      .history-list { min-height: 0; overflow-y: auto; padding: 5px 0; }
      .history-session { width: 100%; min-height: 38px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border: 1px solid transparent; border-radius: 19px; color: var(--vscode-foreground); background: transparent; }
      .history-session:hover { border-color: color-mix(in srgb, var(--vscode-widget-border) 70%, transparent); background: var(--vscode-list-hoverBackground); }
      .history-session.current { border-color: var(--opencode-accent-border); background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 48%, transparent); }
      .history-open { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 4px 7px 12px; border: 0; color: inherit; background: transparent; text-align: start; cursor: pointer; }
      .history-item-actions { display: flex; padding-inline-end: 3px; opacity: 0; }
      .history-session:hover .history-item-actions, .history-session:focus-within .history-item-actions { opacity: 1; }
      .history-row-action { width: 25px; height: 25px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; }
      .history-row-action svg { width: 14px; height: 14px; }
      .history-row-action:hover { color: var(--opencode-accent); background: var(--vscode-toolbar-hoverBackground); }
      .history-rename { min-width: 0; height: 27px; margin: 4px; padding: 0 6px; border: 1px solid var(--opencode-accent); border-radius: 4px; outline: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
      .history-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
      .history-detail { color: var(--vscode-descriptionForeground); font-size: 10px; direction: ltr; unicode-bidi: isolate; white-space: nowrap; }
      .provider-connect { position: absolute; z-index: 60; inset: 0; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); padding: 8px 9px; background: color-mix(in srgb, var(--vscode-sideBar-background) 98%, transparent); }
      .provider-connect > header { min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 3px 5px; }
      .provider-connect-heading { min-width: 0; display: flex; align-items: center; gap: 3px; }
      .provider-connect h2 { min-width: 0; margin: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .provider-connect-icon { width: 27px; height: 27px; flex: none; padding: 0; border: 0; border-radius: 5px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; font-size: 18px; }
      .provider-connect-icon:hover { color: var(--opencode-accent); background: var(--vscode-toolbar-hoverBackground); }
      .provider-connect-back { font-size: 22px; line-height: 1; }
      .provider-connect-search-shell { height: 36px; display: flex; align-items: center; margin: 5px 1px 7px; padding: 0 10px; border: 1px solid var(--vscode-widget-border); border-radius: 7px; background: var(--vscode-input-background); }
      .provider-connect-search-shell:focus-within { border-color: var(--opencode-accent-border); box-shadow: 0 0 0 1px var(--opencode-accent-soft); }
      .provider-connect-search { min-width: 0; width: 100%; height: 32px; padding: 0; border: 0; outline: 0; color: var(--vscode-input-foreground); background: transparent; }
      .provider-connect-search::-webkit-search-cancel-button { display: none; }
      .provider-connect-status { min-height: 19px; padding: 1px 7px 3px; color: var(--vscode-descriptionForeground); font-size: 11px; }
      .provider-connect-status.error { color: var(--vscode-errorForeground); }
      .provider-connect-list { min-height: 0; overflow-y: auto; padding: 0 1px 8px; }
      .provider-connect-category { padding: 10px 10px 4px; color: var(--opencode-accent); font-size: 11px; font-weight: 600; }
      .provider-connect-option { width: 100%; min-height: 34px; display: grid; grid-template-columns: 15px minmax(max-content, auto) minmax(0, 1fr); align-items: center; gap: 5px; padding: 5px 8px; border: 1px solid transparent; border-radius: 5px; color: var(--vscode-menu-foreground); background: transparent; text-align: start; cursor: pointer; }
      .provider-connect-option:hover:not(:disabled), .provider-connect-option:focus-visible { border-color: var(--opencode-accent-border); background: var(--vscode-list-hoverBackground); }
      .provider-connect-check { color: var(--vscode-testing-iconPassed, #73c991); font-weight: 700; }
      .provider-connect-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .provider-connect-description { overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
      .provider-connect-method { width: 100%; min-height: 48px; display: grid; gap: 2px; padding: 7px 10px; border: 1px solid transparent; border-radius: 6px; color: var(--vscode-menu-foreground); background: transparent; text-align: start; cursor: pointer; }
      .provider-connect-method > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .provider-connect-method > span:last-child { color: var(--vscode-descriptionForeground); font-size: 10px; }
      .provider-connect-method:hover:not(:disabled), .provider-connect-method:focus-visible { border-color: var(--opencode-accent-border); background: var(--vscode-list-hoverBackground); }
      .transcript-shell { position: relative; min-height: 0; }
      #empty-brand { position: absolute; z-index: 0; inset: 0; display: grid; place-items: center; pointer-events: none; }
      #empty-brand svg { width: min(360px, 82%); height: auto; }
      #empty-brand .wordmark-open { color: var(--vscode-descriptionForeground); opacity: 0.55; }
      #empty-brand .wordmark-code { color: var(--vscode-foreground); opacity: 0.82; }
      #transcript { position: absolute; inset: 0; overflow-y: auto; padding: 10px 11px 22px; scrollbar-gutter: stable; }
      #sticky-prompt { position: absolute; z-index: 10; inset-block-start: 7px; inset-inline: 9px; width: calc(100% - 18px); max-height: 42px; overflow: hidden; padding: 6px 9px; border: 1px solid var(--opencode-accent-border); border-inline-start-width: 2px; border-radius: 7px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); box-shadow: 0 5px 16px var(--vscode-widget-shadow); text-align: start; cursor: pointer; line-height: 1.35; white-space: nowrap; text-overflow: ellipsis; unicode-bidi: plaintext; }
      #sticky-prompt:hover { background: var(--vscode-toolbar-hoverBackground); }
      .context { direction: ltr; unicode-bidi: isolate; font-family: var(--vscode-editor-font-family); }
      .turn { margin: 0 0 20px; overflow-wrap: anywhere; }
      .turn-prompt { margin: 0; padding: 7px 9px; border: 1px solid var(--vscode-chat-requestBorder, transparent); border-inline-start: 2px solid var(--opencode-accent); border-radius: 7px; background: var(--vscode-chat-requestBackground, var(--vscode-input-background)); line-height: 1.5; white-space: pre-wrap; unicode-bidi: plaintext; }
      .turn-prompt:focus-visible { outline: 1px solid var(--opencode-accent); outline-offset: 1px; }
      .turn-attachments { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; }
      .turn-attachments span { max-width: 100%; overflow: hidden; padding: 1px 6px; border: 1px solid var(--opencode-accent-border); border-radius: 9px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font: 10px/1.5 var(--vscode-editor-font-family); text-overflow: ellipsis; white-space: nowrap; unicode-bidi: isolate; }
      .turn-response { padding: 10px 3px 0; }
      .message-time { display: none; margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 10px; direction: ltr; unicode-bidi: isolate; }
      .transcript.show-timestamps .message-time, .turn-prompt:hover .message-time, .turn-prompt:focus-visible .message-time { display: block; }
      .turn-metadata { margin: 10px 0 3px; color: var(--vscode-descriptionForeground); font-size: 10px; direction: ltr; unicode-bidi: isolate; }
      .turn-metadata-summary { min-height: 24px; display: flex; align-items: center; gap: 5px; width: max-content; max-width: 100%; cursor: pointer; list-style: none; }
      .turn-metadata-summary::-webkit-details-marker { display: none; }
      .turn-metadata-summary::before { content: "›"; flex: none; transition: transform 80ms ease-out; }
      .turn-metadata[open] .turn-metadata-summary::before { transform: rotate(90deg); }
      .turn-metadata-summary:hover, .turn-metadata-summary:focus-visible { color: var(--vscode-foreground); }
      .turn-metadata-summary bdi { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .metadata-separator { flex: none; color: var(--vscode-disabledForeground); }
      .turn-metadata-region { width: min(320px, 100%); margin-top: 3px; padding: 8px 9px; border: 1px solid var(--vscode-widget-border); border-radius: 7px; background: var(--vscode-editorWidget-background); }
      .turn-metadata-region dl, .usage-details dl { display: grid; grid-template-columns: minmax(max-content, 1fr) minmax(0, 1fr); gap: 4px 12px; margin: 0; }
      .turn-metadata-region dt, .usage-details dt { color: var(--vscode-descriptionForeground); }
      .turn-metadata-region dd, .usage-details dd { min-width: 0; margin: 0; color: var(--vscode-foreground); text-align: end; }
      .turn-metadata-region dd bdi, .usage-details dd bdi { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .review-card { margin: 14px 0 4px; overflow: hidden; border: 1px solid var(--vscode-widget-border); border-radius: 10px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent); }
      .review-card > header { min-height: 67px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--vscode-widget-border); }
      .review-identity { min-width: 0; display: flex; align-items: center; gap: 11px; }
      .review-identity > div { min-width: 0; display: grid; gap: 2px; }
      .review-identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
      .review-icon { width: 25px; height: 25px; flex: none; display: grid; place-items: center; color: var(--vscode-descriptionForeground); }
      .review-icon svg { width: 22px; height: 22px; }
      .review-counts, .review-file-counts { direction: ltr; unicode-bidi: isolate; white-space: nowrap; font-size: 11px; }
      .review-counts .added, .review-file-counts .added { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
      .review-counts .removed, .review-file-counts .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
      .review-action { flex: none; min-height: 29px; padding: 3px 11px; border: 1px solid var(--vscode-button-border, var(--vscode-widget-border)); border-radius: 8px; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
      .review-action:hover:not(:disabled) { border-color: var(--opencode-accent-border); background: var(--vscode-button-secondaryHoverBackground); }
      .review-action:disabled, .review-file:disabled { opacity: .55; cursor: default; }
      .review-files { padding: 5px 0; }
      .review-file { width: 100%; min-height: 38px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 9px; padding: 7px 14px; border: 0; color: var(--vscode-descriptionForeground); background: transparent; text-align: start; cursor: pointer; }
      .review-file:hover:not(:disabled) { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
      .review-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: isolate; }
      .review-more { width: 100%; min-height: 35px; padding: 6px 14px; border: 0; color: var(--vscode-descriptionForeground); background: transparent; text-align: start; cursor: pointer; }
      .review-more:hover { color: var(--opencode-accent); background: var(--vscode-list-hoverBackground); }
      #permission-dock { margin: 0 8px 7px; padding: 10px 11px; border: 1px solid var(--opencode-accent-border); border-radius: 9px; background: var(--vscode-editorWidget-background); box-shadow: 0 5px 16px var(--vscode-widget-shadow); }
      #permission-dock > strong { display: block; margin-bottom: 6px; font-size: 12px; }
      .permission-details { max-height: 84px; overflow-y: auto; display: grid; gap: 3px; margin-bottom: 9px; }
      .permission-details:empty { display: none; }
      .permission-details code { overflow: hidden; padding: 3px 5px; border-radius: 4px; color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); font: 10px/1.4 var(--vscode-editor-font-family); text-overflow: ellipsis; white-space: nowrap; unicode-bidi: isolate; }
      .permission-actions { display: flex; justify-content: flex-end; gap: 6px; }
      .permission-actions button { min-height: 28px; padding: 3px 11px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; cursor: pointer; }
      .permission-deny { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
      .permission-deny:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .permission-allow { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      .permission-allow:hover { background: var(--vscode-button-hoverBackground); }
      #question-dock { margin: 0 8px 7px; padding: 10px 11px; border: 1px solid var(--opencode-accent-border); border-radius: 9px; background: var(--vscode-editorWidget-background); box-shadow: 0 5px 16px var(--vscode-widget-shadow); }
      .question-progress { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 3px; color: var(--opencode-accent); font-size: 10px; font-weight: 600; }
      .question-step { padding: 2px 7px; border: 0; color: inherit; background: transparent; cursor: pointer; }
      .question-step:disabled { opacity: .35; cursor: default; }
      #question-dock h3 { margin: 0 0 4px; font-size: 12px; }
      .question-text { margin: 0 0 8px; color: var(--vscode-foreground); line-height: 1.45; }
      .question-options { display: grid; gap: 4px; max-height: 150px; overflow-y: auto; }
      .question-option { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 7px; padding: 6px 7px; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
      .question-option:hover { background: var(--vscode-list-hoverBackground); }
      .question-option:has(input:checked) { border-color: var(--opencode-accent-border); background: var(--vscode-list-activeSelectionBackground); }
      .question-option input { grid-row: 1 / span 2; margin: 2px 0 0; accent-color: var(--opencode-accent); }
      .question-option small { color: var(--vscode-descriptionForeground); }
      .question-custom { box-sizing: border-box; width: 100%; margin-top: 6px; padding: 6px 7px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); outline: none; }
      .question-custom:focus { border-color: var(--opencode-accent); }
      .question-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 9px; }
      .question-summary { display: grid; gap: 7px; margin: 7px 0; padding-left: 22px; }
      .question-summary li { padding-left: 2px; }
      .question-summary strong, .question-summary span { display: block; }
      .question-summary span { margin-top: 2px; color: var(--vscode-descriptionForeground); }
      .question-actions button { min-height: 28px; padding: 3px 11px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; cursor: pointer; }
      .question-cancel { margin-inline-end: auto; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
      .question-back { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
      .question-next { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      #rollback-dock { margin: 0 8px 7px; overflow: hidden; border: 1px solid var(--vscode-widget-border); border-radius: 9px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 76%, transparent); box-shadow: 0 4px 13px var(--vscode-widget-shadow); }
      .rollback-summary { width: 100%; min-height: 34px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 6px 10px; border: 0; color: var(--vscode-foreground); background: transparent; text-align: start; cursor: pointer; }
      .rollback-summary:hover { background: var(--vscode-toolbar-hoverBackground); }
      .rollback-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
      .rollback-chevron { width: 7px; height: 7px; margin: -3px 3px 0; border-inline-end: 1px solid var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-descriptionForeground); transform: rotate(45deg); }
      .rollback-summary[aria-expanded="true"] .rollback-chevron { margin-top: 3px; transform: rotate(225deg); }
      .rollback-hint { display: none; padding: 0 10px 7px; color: var(--vscode-descriptionForeground); font-size: 10px; }
      .rollback-summary[aria-expanded="true"] + .rollback-hint { display: block; }
      .rollback-list { max-height: min(190px, 28vh); overflow-y: auto; border-top: 1px solid var(--vscode-widget-border); }
      .rollback-item { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 9px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 62%, transparent); }
      .rollback-content { min-width: 0; display: grid; gap: 2px; }
      .rollback-preview { display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; unicode-bidi: plaintext; }
      .rollback-time { color: var(--vscode-descriptionForeground); font-size: 10px; direction: ltr; unicode-bidi: isolate; }
      .rollback-restore { min-height: 27px; padding: 3px 9px; border: 1px solid var(--vscode-button-border, var(--vscode-widget-border)); border-radius: 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; white-space: nowrap; }
      .rollback-restore:hover:not(:disabled) { border-color: var(--opencode-accent-border); background: var(--vscode-button-secondaryHoverBackground); }
      .rollback-omitted { margin: 0; padding: 7px 9px; color: var(--vscode-descriptionForeground); font-size: 10px; }
      .markdown { line-height: 1.58; overflow-wrap: anywhere; unicode-bidi: plaintext; }
      .markdown + .markdown { margin-top: 10px; }
      .markdown > :first-child { margin-top: 0; }
      .markdown > :last-child { margin-bottom: 0; }
      .markdown p { margin: 0 0 10px; white-space: normal; }
      .markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6 { margin: 17px 0 7px; color: var(--opencode-accent); line-height: 1.3; }
      .markdown h1 { font-size: 1.3em; }
      .markdown h2 { font-size: 1.18em; }
      .markdown h3, .markdown h4, .markdown h5, .markdown h6 { font-size: 1.05em; }
      .markdown ul, .markdown ol { margin: 5px 0 11px; padding-inline-start: 22px; }
      .markdown li { margin: 3px 0; }
      .markdown li > p { margin: 0; }
      .markdown blockquote { margin: 8px 0; padding-inline-start: 10px; border-inline-start: 2px solid var(--opencode-accent-border); color: var(--vscode-descriptionForeground); }
      .markdown hr { border: 0; border-top: 1px solid var(--vscode-widget-border); margin: 15px 0; }
      .markdown-link { color: var(--vscode-textLink-foreground); text-decoration: underline; text-decoration-style: dotted; }
      .inline-code { direction: ltr; unicode-bidi: isolate; padding: 1px 4px; border-radius: 4px; color: var(--opencode-accent); background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); font: var(--vscode-editor-font-size)/1.4 var(--vscode-editor-font-family); }
      .code-block { margin: 9px 0 12px; overflow: hidden; border: 1px solid var(--vscode-widget-border); border-radius: 7px; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); }
      .code-language { padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); font: 10px/1.4 var(--vscode-editor-font-family); unicode-bidi: isolate; }
      .code-block pre { margin: 0; overflow: auto; padding: 9px 10px; text-align: start; unicode-bidi: isolate; }
      .code-block code { color: var(--vscode-editor-foreground); font: var(--vscode-editor-font-size)/1.5 var(--vscode-editor-font-family); white-space: pre; }
      .turn-activity { margin: 5px 0 9px; color: var(--vscode-descriptionForeground); font-size: 11px; }
      .turn-activity + .turn-activity { margin-top: -3px; }
      .activity-summary { min-height: 26px; display: list-item; cursor: pointer; color: var(--vscode-descriptionForeground); line-height: 26px; user-select: none; }
      .activity-summary::marker { color: var(--vscode-descriptionForeground); }
      .activity-summary:hover, .activity-summary:focus-visible { color: var(--vscode-foreground); }
      .turn-activity[data-status="working"] .activity-summary, .turn-activity[data-status="retrying"] .activity-summary { color: var(--opencode-accent); }
      .turn-activity[data-status="failed"] .activity-summary { color: var(--vscode-errorForeground); }
      .activity-items { display: grid; gap: 2px; padding: 3px 0 4px 15px; border-inline-start: 1px solid var(--vscode-widget-border); }
      .activity-item { min-width: 0; padding: 3px 5px; border-radius: 4px; }
      .activity-item:hover { background: var(--vscode-list-hoverBackground); }
      .activity-item-header { display: grid; grid-template-columns: 13px minmax(0, 1fr) auto; gap: 6px; align-items: baseline; }
      .activity-item-icon { width: 13px; color: var(--vscode-descriptionForeground); text-align: center; }
      .activity-item-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
      .activity-item-status { font-size: 10px; }
      .activity-item-status:empty { display: none; }
      .activity-item[data-status="running"] .activity-item-status, .activity-item[data-status="waiting"] .activity-item-status { color: var(--opencode-accent); }
      .activity-item[data-status="failed"] .activity-item-status { color: var(--vscode-errorForeground); }
      .activity-item[data-status="denied"] { text-decoration: line-through; }
      .activity-item-detail, .activity-file { margin-top: 3px; overflow: hidden; padding-inline-start: 19px; color: var(--vscode-foreground); text-overflow: ellipsis; white-space: pre-wrap; }
      code.activity-item-detail { display: block; direction: ltr; unicode-bidi: isolate; font: 11px/1.45 var(--vscode-editor-font-family); }
      .activity-file { direction: ltr; unicode-bidi: isolate; color: var(--vscode-descriptionForeground); }
      .activity-omitted { padding: 3px 5px; color: var(--vscode-descriptionForeground); font-style: italic; }
      form { position: relative; margin: 0 9px 9px; padding: 9px 10px 8px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 12px; background: var(--vscode-input-background); transition: border-color 80ms ease-out; }
      form:focus-within { border-color: var(--opencode-accent); box-shadow: 0 0 0 1px var(--opencode-accent-soft); }
      form[data-phase="starting"]::before, form[data-phase="loading"]::before, form[data-phase="stopping"]::before { content: ""; position: absolute; inset-block-start: -1px; inset-inline-start: 12px; width: 34%; height: 1px; border-radius: 1px; background: var(--opencode-accent); animation: opencode-progress 1.25s ease-in-out infinite alternate; }
      @keyframes opencode-progress { from { transform: translateX(0); opacity: 0.55; } to { transform: translateX(145%); opacity: 1; } }
      textarea { width: 100%; min-height: 38px; max-height: 144px; resize: none; overflow-y: auto; padding: 1px 3px 7px; border: 0; outline: 0; color: var(--vscode-input-foreground); background: transparent; line-height: 1.45; }
      textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
      .attachment-strip { display: flex; flex-wrap: wrap; gap: 4px; max-height: 58px; overflow-y: auto; margin: 0 2px 6px; }
      .attachment-chip { max-width: 100%; display: inline-flex; align-items: center; gap: 3px; height: 22px; padding-inline-start: 7px; border: 1px solid var(--opencode-accent-border); border-radius: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-size: 10px; }
      .attachment-chip bdi { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: isolate; }
      .attachment-remove { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; color: inherit; background: transparent; cursor: pointer; }
      .attachment-remove:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
      .attachment-control { position: relative; }
      #add-context { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; font-size: 19px; }
      #add-context:hover, #add-context[aria-expanded="true"] { color: var(--opencode-accent); background: var(--vscode-toolbar-hoverBackground); }
      .attachment-menu { position: absolute; z-index: 30; inset-inline-start: 0; bottom: 31px; width: min(220px, calc(100vw - 34px)); padding: 5px; border: 1px solid var(--opencode-accent-border); border-radius: 8px; background: var(--vscode-menu-background); box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
      .attachment-menu::before { content: "Add context"; display: block; padding: 4px 7px 5px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; }
      .attachment-option { width: 100%; display: block; padding: 6px 7px; border: 0; border-radius: 4px; color: var(--vscode-menu-foreground); background: transparent; text-align: start; cursor: pointer; }
      .attachment-option:hover:not(:disabled) { background: var(--vscode-menu-selectionBackground); }
      .controls { display: grid; grid-template-columns: auto minmax(5ch, max-content) minmax(6ch, 1fr) minmax(4ch, max-content) auto; align-items: center; min-width: 0; }
      .picker { position: relative; min-width: 0; }
      #agent-picker { max-width: 11ch; }
      #agent-picker .picker-label { color: var(--opencode-accent); font-weight: 600; }
      #model-picker, #variant-picker { direction: ltr; unicode-bidi: isolate; }
      #model-picker::before, #variant-picker::before { content: "·"; position: absolute; inset-inline-start: -2px; top: 3px; color: var(--vscode-descriptionForeground); pointer-events: none; }
      #variant-picker { max-width: 11ch; }
      .picker-trigger { width: 100%; min-width: 0; height: 26px; display: flex; gap: 5px; align-items: center; padding: 0 6px; border: 0; border-radius: 5px; color: var(--vscode-foreground); background: transparent; cursor: pointer; }
      #model-picker .picker-trigger, #variant-picker .picker-trigger { padding-inline-start: 10px; }
      .picker-trigger:hover:not(:disabled) { color: var(--opencode-accent); background: var(--vscode-toolbar-hoverBackground); }
      .picker-trigger[aria-expanded="true"] { color: var(--opencode-accent); background: var(--opencode-accent-soft); }
      .picker-label { min-width: 2ch; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .picker-chevron { width: 6px; height: 6px; flex: 0 0 auto; margin-top: -3px; border-inline-end: 1px solid var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-descriptionForeground); transform: rotate(45deg); }
      .picker-menu { position: absolute; z-index: 20; inset-inline-start: 0; bottom: 31px; width: min(300px, calc(100vw - 34px)); max-height: min(360px, 55vh); overflow: hidden; padding: 5px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; background: var(--vscode-menu-background); box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
      #model-picker .picker-menu, #variant-picker .picker-menu { inset-inline-start: auto; inset-inline-end: 0; }
      .usage-control { position: fixed; z-index: 60; inset: 0; width: 0; height: 0; direction: ltr; unicode-bidi: isolate; }
      .usage-details { position: fixed; z-index: 60; inset-block-start: 8px; inset-inline-end: 8px; width: min(320px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow-y: auto; padding: 10px; border: 1px solid var(--opencode-accent-border); border-radius: 8px; color: var(--vscode-foreground); background: var(--vscode-menu-background); box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
      .usage-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
      .usage-header h2 { margin: 0; font-size: 13px; }
      .usage-close { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; font-size: 18px; }
      .usage-close:hover { color: var(--opencode-accent); background: var(--vscode-toolbar-hoverBackground); }
      .usage-pair { padding: 8px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; color: var(--opencode-accent); background: var(--vscode-editor-background); text-align: center; font: 600 13px/1.4 var(--vscode-editor-font-family); unicode-bidi: isolate; }
      .usage-note { margin: 5px 1px 0; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.45; text-align: start; unicode-bidi: plaintext; }
      .usage-details h3 { margin: 0 0 7px; font-size: 11px; }
      .usage-details h3:not(:first-child) { margin-top: 12px; padding-top: 9px; border-top: 1px solid var(--vscode-widget-border); }
      .picker-search { width: 100%; height: 28px; margin-bottom: 4px; padding: 0 7px; border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
      .picker-search:focus { border-color: var(--opencode-accent); }
      .picker-list { max-height: min(310px, 48vh); overflow-y: auto; }
      .picker-group { padding: 7px 7px 3px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; }
      .picker-option { width: 100%; display: block; padding: 5px 7px; border: 0; border-radius: 4px; color: var(--vscode-menu-foreground); background: transparent; text-align: start; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .picker-option:hover, .picker-option.active { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); }
      .picker-option[aria-selected="true"] { color: var(--opencode-accent); background: var(--opencode-accent-soft); }
      #send { width: 30px; height: 30px; margin-inline-start: 5px; padding: 0; border: 0; border-radius: 50%; color: #1a1a1a; background: var(--opencode-accent); cursor: pointer; font-size: 16px; font-weight: 700; }
      #send:hover:not(:disabled) { background: var(--opencode-accent-hover); }
      #send.stop { border-radius: 50%; }
      #status { display: block; min-height: 0; margin: 5px 3px 0; color: var(--vscode-descriptionForeground); font-size: 10px; }
      #status:empty { display: none; }
      #status.error { color: var(--vscode-errorForeground); }
      .command-menu { position: absolute; z-index: 30; inset-inline: 0; bottom: calc(100% + 6px); max-height: min(230px, 42vh); overflow-y: auto; padding: 5px; border: 1px solid var(--opencode-accent-border); border-radius: 8px; background: var(--vscode-menu-background); box-shadow: 0 8px 24px var(--vscode-widget-shadow); }
      .command-option { width: 100%; display: grid; grid-template-columns: minmax(8ch, auto) minmax(0, 1fr); gap: 10px; padding: 6px 8px; border: 0; border-radius: 4px; color: var(--vscode-menu-foreground); background: transparent; text-align: start; cursor: pointer; }
      .command-option bdi { color: var(--opencode-accent); font-family: var(--vscode-editor-font-family); }
      .command-option span { overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
      .command-option:hover, .command-option[aria-selected="true"] { background: var(--vscode-menu-selectionBackground); }
      .command-option[aria-disabled="true"] { cursor: default; opacity: 0.68; }
      button:focus-visible { outline: 1px solid var(--opencode-accent); outline-offset: 1px; }
      button:disabled { opacity: 0.55; cursor: default; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
      @media (max-width: 260px) {
        form { margin-inline: 6px; padding-inline: 7px; }
        #rollback-dock { margin-inline: 6px; }
        .rollback-item { grid-template-columns: minmax(0, 1fr); }
        .rollback-restore { justify-self: end; white-space: normal; }
        .controls {
          grid-template-columns: auto minmax(0, 1fr) auto;
          grid-template-areas:
            "context agent send"
            "model model variant";
          row-gap: 2px;
        }
        .attachment-control { grid-area: context; }
        #agent-picker { grid-area: agent; }
        #model-picker { grid-area: model; }
        #variant-picker { grid-area: variant; }
        #send { grid-area: send; }
        #agent-picker, #model-picker, #variant-picker { max-width: none; }
        .picker-chevron { display: none; }
        .picker-trigger { padding-inline: 4px; }
        #model-picker .picker-trigger, #variant-picker .picker-trigger { padding-inline-start: 9px; }
      }
      @media (prefers-reduced-motion: reduce) {
        form[data-phase]::before { animation: none; }
        * { scroll-behavior: auto !important; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="history" id="history" role="dialog" aria-modal="true" aria-label="OpenCode chat history" hidden></section>
      <section id="timeline" role="dialog" aria-modal="true" aria-label="OpenCode chat timeline" hidden></section>
      <section class="provider-connect" id="provider-connect" role="dialog" aria-modal="true" aria-label="Connect an AI provider" hidden></section>
      <div class="usage-control" id="usage" aria-label="Chat token details" hidden></div>
      <div class="transcript-shell">
        <!-- Canonical simple wordmark geometry from packages/console/app/src/asset/brand. -->
        <div id="empty-brand" aria-hidden="true">
          <svg viewBox="0 0 640 115">
            <path class="wordmark-open" d="M49.2308 32.8573H16.4103V82.143H49.2308V32.8573ZM65.641 98.5716H0V16.4287H65.641V98.5716ZM98.4649 82.143H131.285V32.8573H98.4649V82.143ZM147.696 98.5716H98.4649V115H82.0547V16.4287H147.696V98.5716ZM229.743 65.7144H180.512V82.143H229.743V98.5716H164.102V16.4287H229.743V65.7144ZM180.512 49.2859H213.332V32.8573H180.512V49.2859ZM295.387 32.8573H262.567V98.5716H246.156V16.4287H295.387V32.8573ZM311.797 98.5716H295.387V32.8573H311.797V98.5716Z" fill="currentColor"/>
            <path class="wordmark-code" d="M393.844 32.8573H344.613V82.143H393.844V98.5716H328.203V16.4287H393.844V32.8573ZM459.489 32.8573H426.668V82.143H459.489V32.8573ZM475.899 98.5716H410.258V16.4287H475.899V98.5716ZM541.535 32.8571H508.715V82.1428H541.535V32.8571ZM557.946 98.5714H492.305V16.4286H541.535V0H557.946V98.5714ZM590.77 32.8573V49.2859H623.59V32.8573H590.77ZM640 65.7144H590.77V82.143H640V98.5716H574.359V16.4287H640V65.7144Z" fill="currentColor"/>
          </svg>
        </div>
        <button id="sticky-prompt" type="button" dir="auto" hidden></button>
        <section id="transcript" role="log" aria-live="off"></section>
      </div>
      <section id="permission-dock" aria-live="polite" aria-label="OpenCode permission request" hidden></section>
      <section id="question-dock" aria-live="polite" aria-label="OpenCode question" hidden></section>
      <section id="rollback-dock" aria-live="polite" aria-label="Rolled-back OpenCode messages" hidden></section>
      <form id="composer">
        <div class="command-menu" id="command-menu" hidden></div>
        <div class="attachment-strip" id="attachment-strip" aria-label="Context attachments" hidden></div>
        <textarea id="prompt" dir="auto" aria-label="Message OpenCode" placeholder="Ask OpenCode…" maxlength="${MAX_PROMPT_LENGTH}"></textarea>
        <div class="controls">
          <div class="attachment-control"><button id="add-context" type="button" aria-label="Add context" title="Add context" aria-haspopup="menu" aria-expanded="false">+</button><div class="attachment-menu" id="attachment-menu" role="menu" hidden></div></div>
          <div class="picker" id="agent-picker" aria-label="Agent"></div>
          <div class="picker" id="model-picker" aria-label="Model"></div>
          <div class="picker" id="variant-picker" aria-label="Variant" hidden></div>
          <button id="send" type="submit" aria-label="Send" title="Send">↑</button>
        </div>
        <span id="status" role="status"></span>
      </form>
      <div id="announcer" class="sr-only" role="status" aria-live="polite"></div>
    </main>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
}
