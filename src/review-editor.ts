import { basename } from "node:path"
import { randomBytes } from "node:crypto"
import { Disposable, Range, Uri, commands, workspace, type TextDocumentContentProvider } from "vscode"

const SCHEME = "opencode-review"
const MAX_DOCUMENTS = 8

export class ReviewEditor implements TextDocumentContentProvider, Disposable {
  private documents = new Map<string, { before: string; after: string }>()
  private disposables = [
    workspace.registerTextDocumentContentProvider(SCHEME, this),
    workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme !== SCHEME) return
      const key = document.uri.path.split("/")[1]
      if (!key || workspace.textDocuments.some((item) => item.uri.scheme === SCHEME && item.uri.path.startsWith(`/${key}/`))) return
      this.documents.delete(key)
    }),
  ]

  provideTextDocumentContent(uri: Uri) {
    const document = this.documents.get(uri.path.split("/")[1] ?? "")
    if (!document) return ""
    if (uri.authority === "before") return document.before
    if (uri.authority === "after") return document.after
    return ""
  }

  async open(document: { path: string; before: string; after: string }) {
    while (this.documents.size >= MAX_DOCUMENTS) {
      const removable = [...this.documents.keys()].find((key) =>
        !workspace.textDocuments.some((item) => item.uri.scheme === SCHEME && item.uri.path.startsWith(`/${key}/`)),
      )
      if (!removable) throw new Error("Close an existing OpenCode review before opening another one.")
      this.documents.delete(removable)
    }
    const key = randomBytes(18).toString("base64url")
    this.documents.set(key, { before: document.before, after: document.after })
    const name = basename(document.path).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file"
    const before = Uri.from({ scheme: SCHEME, authority: "before", path: `/${key}/${name}` })
    const after = Uri.from({ scheme: SCHEME, authority: "after", path: `/${key}/${name}` })
    try {
      await commands.executeCommand("vscode.diff", before, after, `Full file review: ${document.path}`, {
        preview: true,
        preserveFocus: false,
        selection: new Range(0, 0, 0, 0),
      })
      // This fixed editor command expands the current diff without changing the user's global setting.
      await commands.executeCommand("diffEditor.showAllUnchangedRegions").then(undefined, () => undefined)
    } catch (error) {
      this.documents.delete(key)
      throw error
    }
  }

  dispose() {
    this.documents.clear()
    this.disposables.forEach((item) => item.dispose())
  }
}
