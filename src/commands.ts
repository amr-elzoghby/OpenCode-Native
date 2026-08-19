import { createHash, randomBytes } from "node:crypto"
import { isReservedNativeSlashName } from "./protocol"

const MAX_COMMANDS = 200
const MAX_COMMAND_SCAN = 1_000
const MAX_COMMAND_NAME = 128
const MAX_COMMAND_DESCRIPTION = 500
const MAX_COMMAND_TEMPLATE = 256_000
const MAX_COMMAND_TOTAL_CHARS = 2_000_000

export type CommandSummary = {
  key: string
  name: string
  description?: string
  source: "command" | "mcp" | "skill"
}

type CommandTarget = {
  name: string
  fingerprint: string
}

type ValidCommand = CommandTarget & Omit<CommandSummary, "key">

export class CommandStore {
  private targets = new Map<string, CommandTarget>()
  private summaries: CommandSummary[] = []

  replace(value: unknown) {
    const previous = new Map(Array.from(this.targets, ([key, target]) => [target.name, { key, target }]))
    const targets = new Map<string, CommandTarget>()
    const summaries = commands(value).map((command) => {
      const existing = previous.get(command.name)
      const key = existing?.target.fingerprint === command.fingerprint ? existing.key : issueKey(targets)
      targets.set(key, { name: command.name, fingerprint: command.fingerprint })
      return { key, name: command.name, description: command.description, source: command.source }
    })
    this.targets = targets
    this.summaries = summaries
  }

  snapshot() {
    return this.summaries.map((command) => ({ ...command }))
  }

  resolve(key: string) {
    return this.targets.get(key)
  }

  matches(key: string, value: unknown) {
    const target = this.targets.get(key)
    if (!target) return false
    return commands(value).some((command) =>
      command.name === target.name && command.fingerprint === target.fingerprint,
    )
  }

  clear() {
    this.targets.clear()
    this.summaries = []
  }
}

function commands(value: unknown) {
  const seen = new Set<string>()
  let totalChars = 0
  return (Array.isArray(value) ? value.slice(0, MAX_COMMAND_SCAN) : [])
    .flatMap((item): ValidCommand[] => {
      const command = record(item)
      if (!command || !commandName(command.name) || isReservedNativeSlashName(command.name) || seen.has(command.name)) return []
      if (!Object.keys(command).every((key) =>
        ["name", "description", "agent", "model", "source", "template", "subtask", "hints"].includes(key)
      )) return []
      if (command.description !== undefined && !displayString(command.description, MAX_COMMAND_DESCRIPTION)) return []
      if (command.source !== undefined && !["command", "mcp", "skill"].includes(String(command.source))) return []
      if (typeof command.template !== "string" || command.template.length > MAX_COMMAND_TEMPLATE) return []
      const chars = command.name.length + command.template.length +
        (typeof command.description === "string" ? command.description.length : 0)
      if (totalChars + chars > MAX_COMMAND_TOTAL_CHARS) return []
      if (command.agent !== undefined && !boundedString(command.agent, 256)) return []
      if (command.model !== undefined && !boundedString(command.model, 512)) return []
      if (command.subtask !== undefined && typeof command.subtask !== "boolean") return []
      if (!Array.isArray(command.hints) || command.hints.length > 100 ||
        !command.hints.every((hint) => boundedString(hint, 128))) return []
      seen.add(command.name)
      totalChars += chars
      const source = command.source === "mcp" || command.source === "skill" ? command.source : "command"
      return [{
        name: command.name,
        description: typeof command.description === "string" ? command.description : undefined,
        source,
        fingerprint: createHash("sha256").update(JSON.stringify({
          name: command.name,
          description: command.description,
          source,
          agent: command.agent,
          model: command.model,
          subtask: command.subtask,
          hints: command.hints,
          template: command.template,
        })).digest("base64url"),
      }]
    })
    .slice(0, MAX_COMMANDS)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function commandName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_COMMAND_NAME &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

function issueKey(targets: Map<string, CommandTarget>) {
  const key = randomBytes(18).toString("base64url")
  if (!targets.has(key)) return key
  return issueKey(targets)
}

function displayString(value: unknown, maximum: number): value is string {
  return boundedString(value, maximum) && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
