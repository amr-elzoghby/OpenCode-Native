import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { isAbsolute } from "node:path"

const HOSTNAME = "127.0.0.1"
const STARTUP_TIMEOUT = 15_000
const STOP_TIMEOUT = 1_000

let child: ChildProcessWithoutNullStreams | undefined
let stopping: Promise<void> | undefined
let started = false
let ready = false
let failed = false

globalThis.process.on("message", handle)
globalThis.process.once("disconnect", shutdown)

function handle(value: unknown) {
  const message = parseMessage(value)
  if (!message) return fail("startup")
  if (message.type === "shutdown") return shutdown()
  if (started) return fail("startup")
  started = true
  start(message.executable, message.password)
}

function start(executable: string, password: string) {
  const process = spawn(executable, ["serve", `--hostname=${HOSTNAME}`, "--port=0"], {
    cwd: globalThis.process.cwd(),
    env: {
      ...globalThis.process.env,
      OPENCODE_CALLER: "vscode",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: password,
    },
    shell: false,
    windowsHide: true,
  })
  child = process
  process.stderr.resume()

  let output = ""
  const timeout = setTimeout(() => fail("startup"), STARTUP_TIMEOUT)
  process.once("error", () => fail("spawn"))
  process.once("exit", () => {
    clearTimeout(timeout)
    child = undefined
    if (stopping) return
    if (ready) return shutdown()
    fail("startup")
  })
  process.stdout.on("data", (chunk) => {
    if (ready || stopping) return
    output = (output + chunk.toString()).slice(-65_536)
    const line = output.split("\n").find((item) => item.startsWith("opencode server listening"))
    const match = line?.match(/on\s+(https?:\/\/[^\s]+)/)
    if (!match) return
    const url = new URL(match[1])
    if (url.protocol !== "http:" || url.hostname !== HOSTNAME) return fail("binding")
    clearTimeout(timeout)
    ready = true
    send({ type: "ready", url: url.origin })
  })
}

function shutdown() {
  if (stopping) return
  stopping = stop().finally(() => globalThis.process.exit())
}

function fail(code: "spawn" | "startup" | "binding") {
  if (stopping || failed) return
  failed = true
  if (!globalThis.process.connected) return shutdown()
  globalThis.process.send?.({ type: "error", code }, shutdown)
}

async function stop() {
  const process = child
  if (!process || exited(process)) return
  sendSignal(process)
  if (await waitForExit(process, STOP_TIMEOUT)) return
  sendSignal(process, "SIGKILL")
  await waitForExit(process, STOP_TIMEOUT)
}

function send(message: { type: "ready"; url: string } | { type: "error"; code: string }) {
  try {
    globalThis.process.send?.(message)
  } catch {}
}

function sendSignal(process: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM") {
  try {
    process.kill(signal)
  } catch {}
}

function exited(process: ChildProcessWithoutNullStreams) {
  return process.pid === undefined || process.exitCode !== null || process.signalCode !== null
}

function waitForExit(process: ChildProcessWithoutNullStreams, timeout: number) {
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

type Start = { type: "start"; executable: string; password: string }
type Shutdown = { type: "shutdown" }

function parseMessage(value: unknown): Start | Shutdown | undefined {
  try {
    if (!value || typeof value !== "object" || !("type" in value)) return
    if (value.type === "shutdown" && Object.keys(value).length === 1) return { type: "shutdown" }
    if (
      value.type !== "start" ||
      Object.keys(value).length !== 3 ||
      !("executable" in value) ||
      typeof value.executable !== "string" ||
      !isAbsolute(value.executable) ||
      !("password" in value) ||
      typeof value.password !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.password)
    ) return
    return { type: "start", executable: value.executable, password: value.password }
  } catch {}
}
