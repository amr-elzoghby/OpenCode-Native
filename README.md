# OpenCode Native Sidebar

Use OpenCode from a native VS Code sidebar while keeping the OpenCode CLI, providers, configuration, and sessions underneath.

> [!IMPORTANT]
> OpenCode Native Sidebar is an independent community extension. It is not affiliated with, endorsed by, or maintained by the OpenCode team.

![OpenCode Native chat, tool activity, changed-files summary, and full-file diff review](images/screenshots/native-review.png)

[Watch the 23-second demo](https://github.com/amr-elzoghby/OpenCode-Native/blob/main/media/opencode-native-demo.mp4)

## Highlights

- Streaming chat with OpenCode models, agents, variants, questions, and tool activity.
- Current-chat token total, plus expandable model, agent, timing, cost, and per-turn token details.
- Searchable session history with rename, delete, refresh, fork, undo/redo, rolled-back message restore, and native diff review.
- Provider sign-in through `/connect`, including subscription/OAuth and API-key methods exposed by OpenCode.
- Workspace context plus local text, PDF, image, audio, and video attachments.
- Searchable slash commands, current OpenCode commands and skills, MCP controls, and RTL-aware rendering.
- Approval UI only when OpenCode emits a real pending permission request.

<p align="center">
  <img src="images/screenshots/provider-connect.png" width="49%" alt="Matching provider connection experience in the OpenCode TUI and Native sidebar">
  <img src="images/screenshots/slash-commands.png" width="49%" alt="Searchable slash commands in the OpenCode TUI and Native sidebar">
</p>

## Chat tokens and message history

Use the **Chat Tokens** button beside History to see one total for the current chat. Native calculates it from the input, output, reasoning, cache-read, and cache-write counters supplied by OpenCode for every model request; it does not estimate tokens locally or show monthly/account usage. Response details also show the model, agent, timing, turn tokens, and cost when OpenCode provides them.

After `/undo`, a collapsed **Rolled-back messages** dock appears above the composer. Expand it to restore a selected turn, its saved response, and the earlier rolled-back history through OpenCode's official revert state—without storing a separate conversation copy in the extension.

## Install and set up

OpenCode Native ships the VS Code interface only; it does not bundle the CLI. It works with the official OpenCode CLI and does not require a forked Core build or a Native-specific backend patch.

Choose either installation method:

### VS Code Marketplace

1. Open **Extensions** in VS Code (`Ctrl+Shift+X` on Windows/Linux or `Cmd+Shift+X` on macOS).
2. Search for **OpenCode Native Sidebar**, confirm that the publisher is **amr-s-elzoghby** and the listing links to this repository, then select **Install**.
3. Run **Developer: Reload Window** if VS Code asks you to reload.

If you previously installed the GitHub VSIX published as `amr-elzoghby.opencode-native`, uninstall that package before installing the Marketplace listing. The new Marketplace identity is `amr-s-elzoghby.opencode-native-sidebar`; keeping both installed can create duplicate commands and views.

### GitHub Release

1. Open the [latest GitHub release](https://github.com/amr-elzoghby/OpenCode-Native/releases/latest) and download its `.vsix` file.
2. In VS Code, run **Extensions: Install from VSIX...**, select the file, then run **Developer: Reload Window**.

After installing with either method:

1. Install the [OpenCode CLI](https://opencode.ai) where the VS Code Extension Host runs. In WSL, SSH, or a dev container, install it inside that environment.
2. If `opencode` is not on `PATH`, open Settings, search for **OpenCode Native: Executable Path**, and enter its absolute path in that environment.

Open a trusted, filesystem-backed project, then open **OpenCode** in the Secondary Sidebar. Use `/connect` to sign in, or reuse a provider already connected in the same OpenCode environment.

## Files and context

Use the `+` menu to add workspace files, the current file, the current selection, or **Add file...**.

<p align="center">
  <img src="images/screenshots/add-context.png" width="42%" alt="OpenCode Native Add Context menu">
</p>

**Add file...** opens the device file picker and adds one file at a time. The picker displays all files, but Native accepts only supported UTF-8 text extensions, PDF, PNG/JPEG/GIF/WebP, and recognized audio/video formats. The selected model must support non-text input.

![Add a local device file from OpenCode Native running in VS Code and WSL](images/screenshots/add-local-file.png)

Per-file limits: 256 KiB for text, 5 MiB for images, and 25 MiB for PDF, audio, or video; attachment-count and total-size caps also apply. Workspace context is restricted to regular, non-symlink files inside the current workspace.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+N` | New chat |
| `Alt+R` | Refresh the Native chat |
| `Alt+H` | History |
| `Alt+M` | Models |
| `Alt+A` | Agents |
| `Escape` | Stop an active response |

The `Alt` shortcuts work while keyboard focus is anywhere inside the OpenCode sidebar—click inside it first. `Escape` works while the composer is focused and a response is active.

Use `Cmd+Esc` on macOS or `Ctrl+Esc` on Windows/Linux to open or focus the OpenCode TUI. Add `Shift` to start another TUI terminal. The launcher uses the same configured executable.

## Slash commands

Type `/` to open the command list and keep typing—for example, `/s`—to filter it. Use `/help` for the supported Native actions.

Common actions include `/connect`, `/sessions`, `/new`, `/refresh`, `/models`, `/agents`, `/variants`, `/mcps`, `/compact`, `/fork`, `/undo`, `/redo`, and `/diff`. Current OpenCode commands, MCP commands, and skills also appear. TUI-only or conditional actions are labeled unavailable in Native instead of being run incorrectly; unknown slash text is sent as an ordinary prompt.

## Native and TUI sessions

Native and the TUI can reuse stored sessions and provider sign-in when they run in the same OpenCode data environment and project folder. Two already-open clients do not update each other live.

- TUI to Native: wait for the response to finish, open the same session, then use **Refresh**, `Alt+R`, or `/refresh` in Native.
- Native to TUI: reopen or resume the session in the TUI. `/refresh` is Native-only.

Avoid writing to the same session from both clients at the same time.

![The same OpenCode task and result shown in the TUI and Native sidebar](images/screenshots/tui-parity.png)

## Security and limits

- OpenCode Native does not operate a publisher backend or include publisher telemetry. Prompts, files, and tool context are handled by the local OpenCode Core and may be sent to the provider or integration you select; see the [Privacy Policy](PRIVACY.md).
- The Extension Host owns the authenticated loopback OpenCode server. Provider credentials and the server password are not exposed to the Webview.
- `/connect` sends credentials from VS Code host inputs to OpenCode Core; the sidebar never receives those secrets.
- After explicit selection, the Webview reads the device file and sends its basename, MIME hint, and bounded content to the Extension Host; the full local path is not sent. The host revalidates the payload, detects an allowed type, and checks size and model support before submission.
- OpenCode agents may read or modify workspace files and run terminal commands according to OpenCode Core configuration and permissions.
- Native does not decide which actions require approval. It shows only real pending requests from OpenCode Core and returns **Allow once** or **Deny**. Routine reads, searches, directory inspection, and informational commands remain silent whenever Core allows them; Native has no command-name risk engine.
- Native Review uses OpenCode's official `session.diff` snapshot data and does not require custom file-change-record APIs. Agent edits can still finish when diff data is unavailable, but Review may be unavailable for that turn.
- Live cross-client sync and persistent **Always Allow** management are not included in this release.

## Development

Clone this repository, open its root in VS Code, and install dependencies:

```sh
bun install
```

Then press `F5`. The included launch task builds the extension and starts an Extension Development Host.

```sh
bun run check-types
bun test src/test
bun run lint
bun run package
```

## Issues and license

Report bugs at [GitHub Issues](https://github.com/amr-elzoghby/OpenCode-Native/issues).

OpenCode Native is distributed under the [MIT License](LICENSE); dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). OpenCode is a separate MIT-licensed project.
