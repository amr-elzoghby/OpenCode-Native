import { deepEqual, equal } from "node:assert/strict"
import { PermissionStore } from "../permissions"

describe("permission trust boundary", () => {
  it("projects only bounded display data behind an opaque key", () => {
    const store = new PermissionStore(() => "opaque_permission_key_123")
    const request = permission()
    store.upsert(request, "session-1")
    deepEqual(store.snapshot(), [{
      key: "opaque_permission_key_123",
      title: "Run command",
      details: [],
      files: [],
    }])
    equal(JSON.stringify(store.snapshot()).includes("per_123"), false)
    equal(JSON.stringify(store.snapshot()).includes("always"), false)
    equal(store.matches("opaque_permission_key_123", request), true)
  })

  it("rejects cross-session, malformed, and changed requests", () => {
    const store = new PermissionStore(() => "opaque_permission_key_123")
    store.upsert(permission(), "other-session")
    equal(store.snapshot().length, 0)
    store.upsert(permission(), "session-1")
    equal(store.matches("opaque_permission_key_123", { ...permission(), patterns: ["rm -rf /" ] }), false)
    store.upsert({ ...permission(), id: "bad\nid" }, "session-1")
    equal(store.snapshot().length, 1)
  })

  it("rotates the opaque key when Core changes a request with the same ID", () => {
    const keys = ["opaque_permission_key_old", "opaque_permission_key_new"]
    const store = new PermissionStore(() => keys.shift()!)
    const initial = { ...permission(), metadata: { command: "bun test" } }
    store.upsert(initial, "session-1")
    const oldKey = store.snapshot()[0]!.key
    store.upsert({ ...initial, metadata: { command: "bun run build" } }, "session-1")
    const updated = store.snapshot()[0]!
    equal(updated.key, "opaque_permission_key_new")
    equal(updated.details[0], "bun run build")
    equal(store.resolve(oldKey), undefined)
  })

  it("sanitizes control and BiDi display text without forwarding metadata", () => {
    const store = new PermissionStore(() => "opaque_permission_key_123")
    store.upsert({
      ...permission(),
      permission: "plugin\u202etool",
      patterns: ["line\ncommand"],
      metadata: { secret: "must-not-cross" },
    } as ReturnType<typeof permission> & { metadata: { secret: string } }, "session-1")
    const output = JSON.stringify(store.snapshot())
    equal(output.includes("\u202e"), false)
    equal(output.includes("\n"), false)
    equal(output.includes("must-not-cross"), false)
  })

  it("projects typed paths and redacted canonical shell commands", () => {
    const keys = ["opaque_permission_file_123", "opaque_permission_shell_123"]
    const store = new PermissionStore(() => keys.shift()!)
    store.upsert({ ...permission(), permission: "edit", patterns: ["/home/user/private/project/src/a.ts"] }, "session-1", "/home/user/private/project")
    store.upsert({
      ...permission(),
      id: "per_shell",
      metadata: {
        command: "TOKEN=plain-value GITHUB_TOKEN=github-value AWS_SECRET_ACCESS_KEY=aws-value REDIS_PASSWORD=redirect-value>target.txt (GH_TOKEN=paren-value command) && OPENAI_API_KEY=separator-value command | CLIENT_SECRET=pipe-value command; curl -H \"Authorization: Bearer bearer-value\" --header 'X-API-Key: api-value' --client-secret flag-value -u user:user-value 'https://user:pass@example.com?q=ok&token=query-value#access_token=fragment-value'",
      },
    }, "session-1")
    const output = JSON.stringify(store.snapshot())
    equal(output.includes("src/a.ts"), true)
    equal(output.includes("/home/user"), false)
    equal(output.includes("Authorization: [redacted]"), true)
    equal(output.includes("X-API-Key: [redacted]"), true)
    equal(output.includes("https://[redacted]@example.com"), true)
    for (const value of ["plain-value", "github-value", "aws-value", "redirect-value", "paren-value", "separator-value", "pipe-value", "bearer-value", "api-value", "flag-value", "user-value", "query-value", "fragment-value"]) {
      equal(output.includes(value), false)
    }
    equal(output.includes(">target.txt"), true)
  })

  it("projects allowlisted search, web, task, and external-directory context", () => {
    let key = 0
    const store = new PermissionStore(() => `opaque_permission_key_${++key}`)
    store.upsert({ ...permission(), id: "per_grep", permission: "grep", metadata: { pattern: "validateTask" } }, "session-1")
    store.upsert({ ...permission(), id: "per_web", permission: "webfetch", metadata: { url: "https://user:pass@example.com/docs?q=secret#token" } }, "session-1")
    store.upsert({ ...permission(), id: "per_task", permission: "task", metadata: { subagent_type: "research", description: "Inspect validation" } }, "session-1")
    store.upsert({ ...permission(), id: "per_ext", permission: "external_directory", patterns: ["/tmp/project/*"], metadata: { parentDir: "/tmp/project" } }, "session-1")
    const prompts = store.snapshot()
    deepEqual(prompts.map((item) => item.title), ["Search text", "Fetch URL", "Start research subagent", "Access external directory"])
    equal(JSON.stringify(prompts).includes("validateTask"), true)
    equal(JSON.stringify(prompts).includes("q=secret"), false)
    equal(JSON.stringify(prompts).includes("Scope: /tmp/project/*"), true)
  })

  it("keeps proposed edit contents host-side and exposes only opaque review metadata", () => {
    let key = 0
    const store = new PermissionStore(() => `opaque_permission_key_${++key}`)
    const request = {
      ...permission(),
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: {
        diff: "--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        filepath: "src/a.ts",
      },
    }
    store.upsert(request, "session-1", "/workspace")
    const prompt = store.snapshot()[0]!
    deepEqual(prompt.files.map((file) => file.path), ["src/a.ts"])
    equal(JSON.stringify(prompt).includes("old"), false)
    equal(JSON.stringify(prompt).includes("new"), false)
    deepEqual(store.resolveReview(prompt.key, prompt.files[0]!.key), { path: "src/a.ts", before: "old\n", after: "new\n" })
    equal(store.matches(prompt.key, { ...request, metadata: { ...request.metadata, diff: request.metadata.diff.replace("+new", "+changed") } }), false)
  })
})

function permission() {
  return {
    id: "per_123",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["bun test"],
    always: ["bun test*"],
  }
}
