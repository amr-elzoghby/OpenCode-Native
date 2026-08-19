import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"

const STARTUP_TIMEOUT = 15_000
const STOP_TIMEOUT = 3_000

export type OwnedServer = {
  url: string
  authorization: string
  close(): Promise<void>
}

export async function startServer(directory: string, signal: AbortSignal) {
  const executable = await resolveOpencode()
  if (signal.aborted) throw new Error("OpenCode startup was cancelled.")

  const password = randomBytes(32).toString("base64url")
  const process = spawn(globalThis.process.execPath, [join(__dirname, "server-host.js")], {
    cwd: directory,
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })

  let closing: Promise<void> | undefined
  const close = () => (closing ??= stop(process))

  return new Promise<OwnedServer>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => fail("OpenCode did not start within 15 seconds."), STARTUP_TIMEOUT)
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      process.removeListener("error", onError)
      process.removeListener("exit", onExit)
      process.removeListener("message", onMessage)
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      void close().then(
        () => reject(new Error(message)),
        () => reject(new Error("OpenCode process did not exit after termination.")),
      )
    }
    const onAbort = () => fail("OpenCode startup was cancelled.")
    const onError = (error: Error) => {
      const message =
        "code" in error && error.code === "ENOENT"
          ? "OpenCode CLI executable was not found on the extension host PATH."
          : "OpenCode failed to start."
      fail(message)
    }
    const onExit = () => fail("OpenCode exited before the server was ready.")
    const onMessage = (value: unknown) => {
      if (settled) return
      const message = parseMessage(value)
      if (!message || message.type === "error") return fail(startupError(message?.code))
      settled = true
      cleanup()
      resolve({
        url: message.url,
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        close,
      })
    }

    signal.addEventListener("abort", onAbort, { once: true })
    process.on("error", onError)
    process.on("exit", onExit)
    process.on("message", onMessage)
    if (signal.aborted) onAbort()
    if (!settled) {
      try {
        process.send({ type: "start", executable, password })
      } catch {
        fail("OpenCode failed to start.")
      }
    }
  })
}

export async function resolveOpencode() {
  // Keep the process wrapper usable in host-independent unit tests. The
  // extension runtime supplies this module only when startup is requested.
  const { workspace } = await import("vscode")
  const configured = workspace.getConfiguration("opencode.native").get<unknown>("executablePath")
  if (typeof configured === "string" && configured.trim()) {
    const executable = configured.trim()
    if (!isAbsolute(executable) || !(await executableFile(executable))) {
      throw new Error("The configured OpenCode CLI executable is not an executable file.")
    }
    return executable
  }
  const path = Object.entries(globalThis.process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? ""
  const names = globalThis.process.platform === "win32" ? ["opencode.exe", "opencode.com", "opencode"] : ["opencode"]
  const candidates = path
    .split(delimiter)
    .filter((directory) => isAbsolute(directory))
    .flatMap((directory) => names.map((name) => join(directory, name)))
  const matches = await Promise.all(candidates.map(async (candidate) => (await executableFile(candidate)) ? candidate : undefined))
  const executable = matches.find((candidate) => candidate !== undefined)
  if (!executable) throw new Error("OpenCode CLI executable was not found on the extension host PATH.")
  return executable
}

async function executableFile(candidate: string) {
  return Promise.all([access(candidate, constants.X_OK), stat(candidate)])
    .then(([, info]) => info.isFile())
    .catch(() => false)
}

async function stop(process: ChildProcess) {
  if (exited(process)) return
  try {
    process.send?.({ type: "shutdown" })
  } catch {}
  if (await waitForExit(process, STOP_TIMEOUT)) return
  try {
    process.kill("SIGKILL")
  } catch {}
  if (await waitForExit(process, 1_000)) return
  throw new Error("OpenCode process did not exit after termination.")
}

function exited(process: ChildProcess) {
  return process.pid === undefined || process.exitCode !== null || process.signalCode !== null
}

function waitForExit(process: ChildProcess, timeout: number) {
  if (exited(process)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      process.removeListener("exit", done)
      resolve(exited(process))
    }, timeout)
    process.once("exit", done)
  })
}

type Message = { type: "ready"; url: string } | { type: "error"; code: "spawn" | "startup" | "binding" }

function parseMessage(value: unknown): Message | undefined {
  try {
    if (!value || typeof value !== "object" || !("type" in value)) return
    if (
      value.type === "error" &&
      "code" in value &&
      (value.code === "spawn" || value.code === "startup" || value.code === "binding")
    ) {
      return { type: "error", code: value.code }
    }
    if (value.type !== "ready" || !("url" in value) || typeof value.url !== "string") return
    const url = new URL(value.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.origin !== value.url) return
    return { type: "ready", url: value.url }
  } catch {}
}

function startupError(code?: "spawn" | "startup" | "binding") {
  if (code === "spawn") return "OpenCode failed to start."
  if (code === "binding") return "OpenCode did not bind to the expected loopback address."
  return "OpenCode exited before the server was ready."
}
