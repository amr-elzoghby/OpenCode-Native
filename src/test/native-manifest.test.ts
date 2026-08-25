import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deepEqual, equal } from "node:assert/strict"

describe("Native command wiring", () => {
  const root = join(__dirname, "..", "..")
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    extensionKind?: string[]
    contributes: {
      configuration?: { properties?: Record<string, { scope?: string }> }
      keybindings: Array<{ command: string; key: string; when?: string }>
      commands: Array<{ command: string }>
      menus: {
        "explorer/context"?: Array<{ command: string; when?: string; group?: string }>
        "view/title"?: Array<{ command: string; when?: string; group?: string }>
      }
    }
  }

  it("does not collide with the official OpenCode terminal command IDs", () => {
    const packageSource = readFileSync(join(root, "package.json"), "utf8")
    const extension = readFileSync(join(root, "src/extension.ts"), "utf8")
    const wiring = `${packageSource}\n${extension}`
    equal(wiring.includes('"opencode.openTerminal"'), false)
    equal(wiring.includes('"opencode.openNewTerminal"'), false)
    equal(wiring.includes('"opencode.native.openTerminal"'), true)
    equal(wiring.includes('"opencode.native.openNewTerminal"'), true)
  })

  it("keeps GUI shortcuts scoped and remappable", () => {
    const native = manifest.contributes.keybindings.filter((binding) => binding.when?.includes("opencode.native."))
    deepEqual(native, [
      { command: "opencode.native.newChat", key: "alt+n", when: "opencode.native.sidebarFocused && !inQuickOpen" },
      { command: "opencode.native.refresh", key: "alt+r", when: "opencode.native.sidebarFocused && !inQuickOpen" },
      { command: "opencode.native.history", key: "alt+h", when: "opencode.native.sidebarFocused && !inQuickOpen" },
      { command: "opencode.native.models", key: "alt+m", when: "opencode.native.sidebarFocused && !inQuickOpen" },
      { command: "opencode.native.agents", key: "alt+a", when: "opencode.native.sidebarFocused && !inQuickOpen" },
      {
        command: "opencode.native.stop",
        key: "escape",
        when: "opencode.native.composerFocused && opencode.native.generating",
      },
    ])
    const extension = readFileSync(join(root, "src", "extension.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    equal(extension.includes('"opencode.native.sidebarFocused", false'), true)
    equal(webview.includes('window.addEventListener("focus", () => vscode.postMessage({ type: "sidebarFocus", focused: true }))'), true)
    equal(webview.includes('window.addEventListener("blur", () => vscode.postMessage({ type: "sidebarFocus", focused: false }))'), true)
    equal(sidebar.includes('"opencode.native.sidebarFocused", message.focused'), true)
    deepEqual(manifest.extensionKind, ["workspace"])
  })

  it("opens the detailed current-chat usage from the view title instead of the composer", () => {
    deepEqual(manifest.contributes.menus["view/title"], [
      { command: "opencode.native.history", when: "view == opencode.sidebar", group: "navigation@1" },
      { command: "opencode.native.refresh", when: "view == opencode.sidebar", group: "navigation@3" },
      { command: "opencode.native.usage", when: "view == opencode.sidebar", group: "navigation@2" },
      { command: "opencode.native.newChat", when: "view == opencode.sidebar", group: "navigation@4" },
    ])
    equal(manifest.contributes.commands.some((command) => command.command === "opencode.native.usage"), true)
    const extension = readFileSync(join(root, "src", "extension.ts"), "utf8")
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    const usage = readFileSync(join(root, "src", "webview-usage.ts"), "utf8")
    equal(extension.includes('registerCommand("opencode.native.usage", () => sidebar.openUsage())'), true)
    equal(sidebar.indexOf('id="usage"') < sidebar.indexOf('class="transcript-shell"'), true)
    equal(sidebar.indexOf('id="usage"') < sidebar.indexOf('<form id="composer">'), true)
    equal(usage.includes("Calculated from OpenCode's input, output, reasoning, cache-read, and cache-write counters"), true)
    equal(usage.includes("const restore = !available && root.contains(document.activeElement)"), true)
    equal(usage.indexOf("const restore =") < usage.indexOf("root.hidden = !available"), true)
    equal(usage.includes('["Input", formatTokens(session.tokens?.input)]'), true)
    equal(usage.includes('["Cache read", formatTokens(session.tokens?.cacheRead)]'), true)
    equal(usage.includes('["Tokens", formatTokens(session.tokens?.total)]'), true)
    equal(usage.includes("innerHTML"), false)
    equal(usage.includes("Model limit"), false)
    equal(usage.includes("Current context"), false)
    equal(usage.includes("formatPercent"), false)
  })

  it("keeps a visible draggable native scrollbar on the transcript", () => {
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    equal(sidebar.includes("overflow-y: auto"), true)
    equal(sidebar.includes("scrollbar-gutter: stable"), true)
    equal(sidebar.includes("#transcript::-webkit-scrollbar { width: 12px; }"), true)
    equal(sidebar.includes("#transcript::-webkit-scrollbar-thumb"), true)
    equal(sidebar.includes("scrollbarSlider-activeBackground"), true)
  })

  it("shows only three safe recent chats in the empty transcript state", () => {
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    const recent = readFileSync(join(root, "src", "webview-recent-chats.ts"), "utf8")
    const protocol = readFileSync(join(root, "src", "protocol.ts"), "utf8")
    equal(sidebar.indexOf('id="recent-chats"') < sidebar.indexOf('id="transcript"'), true)
    equal(sidebar.includes("sessions: sessions.slice(0, MAX_RECENT_CHATS)"), true)
    equal(sidebar.includes("this.resetHistoryProjection()"), true)
    equal(webview.includes("recentChats.update(messages.length === 0, controlsDisabled)"), true)
    equal(webview.includes('viewAll: () => invokeAction("sessions")'), true)
    equal(recent.includes("MAX_RECENT_CHATS"), true)
    equal(recent.includes("name.textContent = session.title"), true)
    equal(recent.includes('name.dir = "auto"'), true)
    equal(recent.includes('detail.dir = "ltr"'), true)
    equal(recent.includes("opening = true"), true)
    equal(recent.includes("innerHTML"), false)
    equal(recent.includes("localStorage"), false)
    equal(recent.includes("sessionID"), false)
    equal(protocol.includes("MAX_RECENT_CHATS = 3"), true)
  })

  it("keeps OpenCode auth and provider configuration behind the Extension Host SDK", () => {
    const session = readFileSync(join(root, "src", "session.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    const connect = readFileSync(join(root, "src", "webview-connect.ts"), "utf8")
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    const provider = readFileSync(join(root, "src", "provider-connection.ts"), "utf8")
    const authBoundary = session + sidebar + provider
    equal(session.includes("client.provider.list"), true)
    equal(session.includes("projectCatalog"), true)
    equal(authBoundary.includes("auth.json"), false)
    equal(authBoundary.includes("workspaceState"), false)
    equal(authBoundary.includes("globalState"), false)
    equal(authBoundary.includes("context.secrets"), false)
    equal(session.includes("attempt.client.auth.set("), true)
    equal(session.includes("attempt.client.provider.oauth.callback("), true)
    equal(session.includes("refreshProviderConnections("), true)
    equal(sidebar.includes('sessionError?.includes("event connection could not be restored")'), true)
    equal(webview.includes("Authorization"), false)
    equal(connect.includes("API key for"), false)
    equal(connect.includes("authorization code"), false)
    equal(connect.includes("providerID"), false)
    equal(sidebar.includes("password: true"), true)
    equal(provider.includes("randomBytes(18)"), true)
    equal(sidebar.includes("resolveMethod("), true)
    equal(sidebar.includes("selected.methods.length === 1"), true)
    equal(sidebar.includes('if (action === "connect") await this.runProviderConnection('), true)
    equal(sidebar.includes("runProviderConnection(() => this.selectProviderConnection"), true)
    equal(sidebar.includes("runProviderConnection(() => this.selectProviderMethod"), true)
    equal(sidebar.includes("Destination: ${authorization.origin}"), true)
    equal(session.match(/providerMethod\(attempt/g)?.length, 4)
    equal(sidebar.includes("showQuickPick(\n        providers.map"), false)
    equal(webview.includes('action === "connect") providerConnect.open()'), false)
    equal(
      sidebar.indexOf("if (!this.providerConnectionIsCurrent(folder, generation)) return", sidebar.indexOf("const fresh = await")) <
        sidebar.indexOf("selectProvider(key, fresh)"),
      true,
    )
  })

  it("removes the unauthenticated legacy terminal bridge", () => {
    const extension = readFileSync(join(root, "src", "extension.ts"), "utf8")
    equal(extension.includes("fetch("), false)
    equal(extension.includes("--port"), false)
    equal(extension.includes("_EXTENSION_OPENCODE_PORT"), false)
    equal(manifest.contributes.commands.some((command) => command.command === "opencode.addFilepathToTerminal"), false)
  })

  it("allows an explicit machine-scoped CLI without trusting workspace configuration", () => {
    const server = readFileSync(join(root, "src", "server.ts"), "utf8")
    const extension = readFileSync(join(root, "src", "extension.ts"), "utf8")
    equal(manifest.contributes.configuration?.properties?.["opencode.native.executablePath"]?.scope, "machine")
    equal(server.includes('workspace.getConfiguration("opencode.native")'), true)
    equal(server.includes("isAbsolute(executable)"), true)
    equal(server.includes("constants.X_OK"), true)
    equal(extension.includes("shellPath: executable"), true)
    equal(extension.includes('sendText("opencode")'), false)
  })

  it("keeps Markdown inert and the Webview network-disabled", () => {
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    const transcript = readFileSync(join(root, "src", "webview-transcript.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    const policy = sidebar.match(/Content-Security-Policy\" content=\"([^\"]+)/)?.[1]
    equal(sidebar.includes("default-src 'none'"), true)
    equal(sidebar.includes("connect-src 'none'"), true)
    equal(policy?.match(/(?:^|; )img-src ([^;]+)/)?.[1], "blob:")
    equal(policy?.includes("data:"), false)
    equal(policy?.includes("http:"), false)
    equal(policy?.includes("https:"), false)
    equal(sidebar.includes("unsafe-inline"), false)
    equal(transcript.includes('token.type === "html"'), true)
    equal(transcript.includes("document.createTextNode(token.raw)"), true)
    equal(`${transcript}${webview}`.includes("innerHTML"), false)
    equal(`${transcript}${webview}`.includes("fetch("), false)
  })

  it("keeps pasted-image previews bounded, local, correlated, and disposable", () => {
    const attachments = readFileSync(join(root, "src", "webview-attachments.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    const source = `${attachments}\n${webview}`
    const drop = attachments.slice(attachments.indexOf("handleDrop(event:"), attachments.indexOf("    ids()"))
    const prepare = attachments.slice(attachments.indexOf("async function prepareUpload"), attachments.indexOf("  function queueThumbnail"))

    equal(source.includes("navigator.clipboard"), false)
    equal(source.includes("innerHTML"), false)
    equal(source.includes("data:image"), false)
    equal(source.includes("http://"), false)
    equal(source.includes("https://"), false)
    equal(attachments.includes("URL.createObjectURL(thumbnail)"), true)
    equal(attachments.includes("URL.revokeObjectURL(url)"), true)
    equal(attachments.includes('canvas.toBlob(resolve, "image/png")'), true)
    equal(attachments.includes("MAX_PREVIEW_DIMENSION = 160"), true)
    equal(attachments.includes("MAX_SOURCE_DIMENSION = 8_192"), true)
    equal(attachments.includes("MAX_SOURCE_PIXELS = 20_000_000"), true)
    equal(attachments.includes("MAX_PREVIEW_BYTES = 256 * 1024"), true)
    equal(attachments.includes("MAX_IMAGE_BYTES = 5 * 1024 * 1024"), true)
    equal(attachments.includes("MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024"), true)
    equal(attachments.includes("MAX_IMAGES = 4"), true)
    equal(attachments.includes('mime === "application/octet-stream"'), true)
    equal(attachments.match(/files[.]filter[(]rasterCandidate[)]/g)?.length, 2)
    equal(prepare.indexOf("pending.get(entry.requestID) !== entry") < prepare.indexOf("previewImageInfo(encoded.bytes)"), true)
    equal(prepare.includes("encoded.bytes.byteLength > MAX_IMAGE_BYTES"), true)
    equal(prepare.includes("otherImages >= MAX_IMAGES"), true)
    equal(prepare.includes("otherImageBytes + encoded.bytes.byteLength > MAX_IMAGE_TOTAL_BYTES"), true)
    equal(attachments.includes("return operation.then(() => result, () => undefined)"), true)
    equal(attachments.includes("message.context !== context"), true)
    equal(attachments.includes("entry.context !== message.context"), true)
    equal(attachments.includes("if (nextContext !== context)"), true)
    equal(attachments.match(/clearTransientState[(][)]/g)?.length, 3)
    equal(attachments.includes('image.src = previewURL'), true)
    equal(attachments.includes('image.draggable = false'), true)
    equal(webview.includes('prompt.addEventListener("paste"'), true)
    equal(webview.includes('composer.addEventListener("dragover"'), true)
    equal(webview.includes('composer.addEventListener("drop"'), true)
    equal(attachments.includes('Array.from(event.dataTransfer.types).includes("Files")'), true)
    equal(drop.indexOf("if (!files.length) return false") < drop.indexOf("event.preventDefault()"), true)
    equal(webview.includes('window.addEventListener("beforeunload", () => attachments.dispose()'), true)
    equal(webview.match(/attachments[.]isUploading[(][)]/g)?.length, 3)
    equal(manifest.contributes.keybindings.some((binding) => /(?:ctrl|cmd)[+]v/i.test(binding.key)), false)
  })

  it("keeps blocking History and context menus keyboard-contained", () => {
    const history = readFileSync(join(root, "src", "webview-history.ts"), "utf8")
    const connect = readFileSync(join(root, "src", "webview-connect.ts"), "utf8")
    const timeline = readFileSync(join(root, "src", "webview-timeline.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    const attachments = readFileSync(join(root, "src", "webview-attachments.ts"), "utf8")
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    equal(history.includes('root.setAttribute("role", "dialog")'), true)
    equal(history.includes('root.setAttribute("aria-modal", "true")'), true)
    equal(history.includes('event.key !== "Tab"'), true)
    equal(history.includes("item.inert = true"), true)
    equal(history.includes("previousFocus?.focus()"), true)
    equal(history.includes("if (root.hidden) return"), true)
    equal(connect.includes('event.key !== "Tab"'), true)
    equal(connect.includes('item.closest("[hidden]")'), true)
    equal(connect.includes('event.key === "ArrowDown"'), true)
    equal(connect.includes("item.inert = true"), true)
    equal(connect.includes("previousFocus?.focus()"), true)
    equal(connect.match(/setBusy[(]/g)?.length, 5)
    equal(connect.includes("disableControls"), false)
    equal(webview.includes("history.close()"), true)
    equal(webview.includes("timeline.close()"), true)
    equal(timeline.includes('event.key !== "Tab"'), true)
    equal(timeline.includes("item.inert = true"), true)
    equal(timeline.includes("previousFocus?.focus()"), true)
    equal(timeline.includes("if (root.hidden) {"), true)
    equal(webview.includes("providerConnect.close()"), true)
    equal(attachments.includes('menu.setAttribute("role", "menu")'), true)
    equal(attachments.includes('button.setAttribute("role", "menuitem")'), true)
    equal(attachments.includes('event.key === "ArrowDown"'), true)
    equal(attachments.includes('localFile.textContent = "Add file…"'), true)
    equal(attachments.includes('fileInput.type = "file"'), true)
    equal(attachments.includes('fileInput.accept ='), false)
    equal(attachments.includes('label: "Image…"'), false)
    equal(sidebar.includes('openLabel: "Add images"'), false)
  })

  it("keeps undo and fork composer restoration host-authored", () => {
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    equal(sidebar.includes('await this.postComposer({ type: "composer", text: restoredPrompt })'), true)
    equal(sidebar.includes('await this.postComposer({ type: "composer", text: "" })'), true)
    equal(sidebar.includes('label: "$(git-branch) Full session"'), true)
    equal(sidebar.match(/postComposer[(][{] type: "composer"/g)?.length, 3)
    equal(webview.includes('vscode.postMessage({ type: "composer"'), false)
  })

  it("adds workspace files through Explorer and keeps file drops scoped to the composer", () => {
    deepEqual(manifest.contributes.menus["explorer/context"], [{
      command: "opencode.native.addExplorerFiles",
      when: "resourceScheme == file && !explorerResourceIsFolder",
      group: "2_workspace@50",
    }])
    equal(manifest.contributes.commands.some((command) => command.command === "opencode.native.addExplorerFiles"), true)
    const webview = readFileSync(join(root, "src", "webview.ts"), "utf8")
    equal(webview.includes('composer.addEventListener("dragover"'), true)
    equal(webview.includes('composer.addEventListener("drop"'), true)
    equal(webview.includes('window.addEventListener("drop"'), false)
    equal(webview.includes('document.addEventListener("drop"'), false)
  })

  it("keeps native review contents in the Extension Host", () => {
    const protocol = readFileSync(join(root, "src", "protocol.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview-transcript.ts"), "utf8")
    const editor = readFileSync(join(root, "src", "review-editor.ts"), "utf8")
    const session = readFileSync(join(root, "src", "session.ts"), "utf8")
    equal(protocol.includes("patch?:"), false)
    equal(webview.includes(".patch"), false)
    equal(webview.includes("vscode.diff"), false)
    equal(editor.includes('commands.executeCommand("vscode.diff"'), true)
    equal(editor.includes('commands.executeCommand("diffEditor.showAllUnchangedRegions")'), true)
    equal(editor.includes("workspace.getConfiguration"), false)
    equal(editor.includes("Full file review:"), true)
    equal(editor.includes("executeCommand(document"), false)
    equal(webview.includes("changeID"), false)
    equal(webview.includes("before"), false)
    equal(webview.includes("after"), false)
    equal(webview.includes('"file changes"} observed'), true)
    equal(session.includes("client.session.diff"), true)
    equal(session.includes("/session/{sessionID}/change"), false)
    equal(session.includes("changeDetail"), false)
  })

  it("keeps permission authority and raw request data out of the Webview", () => {
    const protocol = readFileSync(join(root, "src", "protocol.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview-permissions.ts"), "utf8")
    equal(webview.includes("requestID"), false)
    equal(webview.includes("metadata"), false)
    equal(webview.includes("always"), false)
    equal(protocol.includes('decision: "allow" | "deny"'), true)
    equal(protocol.includes('decision: "always"'), false)
  })

  it("keeps question authority and raw request IDs out of the Webview", () => {
    const webview = readFileSync(join(root, "src", "webview-questions.ts"), "utf8")
    const host = readFileSync(join(root, "src", "questions.ts"), "utf8")
    equal(webview.includes("requestID"), false)
    equal(webview.includes("messageID"), false)
    equal(webview.includes("callID"), false)
    equal(webview.includes("innerHTML"), false)
    equal(host.includes("randomBytes(18)"), true)
  })

  it("keeps rolled-back message identities and Core mutations in the Extension Host", () => {
    const webview = readFileSync(join(root, "src", "webview-rollback.ts"), "utf8")
    const host = readFileSync(join(root, "src", "session.ts"), "utf8")
    equal(webview.includes("messageID"), false)
    equal(webview.includes("sessionID"), false)
    equal(webview.includes("innerHTML"), false)
    equal(webview.includes("textContent = message.preview"), true)
    equal(host.includes("boundaryMessageID"), true)
    equal(host.includes("client.session.unrevert"), true)
  })

  it("keeps multi-question prompts navigable and confirms before submission", () => {
    const webview = readFileSync(join(root, "src", "webview-questions.ts"), "utf8")
    equal(webview.includes("Question ${index + 1} of ${prompt.questions.length}"), true)
    equal(webview.includes('setAttribute("aria-label", "Previous question")'), true)
    equal(webview.includes('setAttribute("aria-label", "Next question")'), true)
    equal(webview.includes('header.textContent = "Confirm your answers"'), true)
    equal(webview.includes('button("Review"'), false)
    equal(webview.match(/button\("Submit"/g)?.length, 1)
  })

  it("projects tools as read-only bounded activity", () => {
    const transcript = readFileSync(join(root, "src", "transcript.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview-transcript.ts"), "utf8")
    equal(transcript.includes('title: "Ran command"'), true)
    equal(transcript.includes("state.output"), false)
    equal(transcript.includes("env"), false)
    equal(webview.includes("postMessage"), false)
    equal(webview.includes("innerHTML"), false)
  })

  it("renders model work as collapsed per-message phases before the review card", () => {
    const transcript = readFileSync(join(root, "src", "transcript.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview-transcript.ts"), "utf8")
    equal(transcript.includes("messageID: string"), true)
    equal(transcript.includes("return assistants.flatMap"), true)
    equal(webview.includes("current.element.open = false"), true)
    equal(webview.includes("new Map(turn.activities.map"), true)
    equal(webview.includes("view.activities.get(activity.messageID)"), true)
    equal(webview.includes("reviewReady(turn.activities) ? turn.review : undefined"), true)
    equal(webview.indexOf("turn.activities.forEach") < webview.indexOf("updateReview(view, assistant"), true)
  })

  it("keeps usage typed, Core-authored, keyboard-readable, and separate by scope", () => {
    const transcript = readFileSync(join(root, "src", "transcript.ts"), "utf8")
    const session = readFileSync(join(root, "src", "session.ts"), "utf8")
    const protocol = readFileSync(join(root, "src", "protocol.ts"), "utf8")
    const usage = readFileSync(join(root, "src", "webview-usage.ts"), "utf8")
    const webview = readFileSync(join(root, "src", "webview-transcript.ts"), "utf8")
    const sidebar = readFileSync(join(root, "src", "sidebar.ts"), "utf8")
    equal(session.includes('part.type === "step-finish"'), true)
    equal(session.includes("loadSessionUsage"), true)
    equal(transcript.includes("turnUsageSnapshot"), true)
    equal(protocol.includes("sessionUsage: UsageTotals"), true)
    equal(protocol.includes("contextLimit?: number"), true)
    equal(usage.includes('panel.setAttribute("role", "dialog")'), true)
    equal(usage.includes('setAttribute("aria-label", "Close chat token details")'), true)
    equal(usage.includes('event.key !== "Escape"'), true)
    equal(usage.includes("innerHTML"), false)
    equal(usage.includes("postMessage"), false)
    equal(webview.includes('document.createElement("details")'), true)
    equal(webview.includes('view.prompt.tabIndex = turn.prompt.createdAt === undefined ? -1 : 0'), true)
    equal(sidebar.includes('id="usage" aria-label="Chat token details"'), true)
    equal(sidebar.includes('"context agent send"'), true)
    equal(sidebar.includes('"model model variant"'), true)
    equal(sidebar.includes("grid-template-columns: auto minmax(0, 1fr) auto"), true)
  })

  it("rejects stale VSIX bundles byte-for-byte", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
    const packager = readFileSync(join(root, "script", "package-vsix.mjs"), "utf8")
    const verifier = readFileSync(join(root, "script", "verify-vsix.mjs"), "utf8")
    equal(manifest.scripts.package.includes("package-vsix.mjs"), true)
    equal(manifest.scripts.package.includes("test:vsix"), true)
    equal(verifier.includes('actual.equals(expected)'), true)
    equal(verifier.includes("vsixManifest(sourceManifest)"), true)
    equal(verifier.includes("ARCHIVE_DATE"), true)
    equal(verifier.includes("expectedFiles.sort()"), true)
    equal(packager.includes("newestSource > oldestBundle"), true)
    equal(packager.includes('open(temporary, "wx", 0o600)'), true)
  })
})
