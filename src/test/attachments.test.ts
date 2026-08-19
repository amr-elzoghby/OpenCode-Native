import { deepEqual, equal, rejects } from "node:assert/strict"
import { appendFile, mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_IMAGES,
  safeLabel,
} from "../attachments"

describe("host-owned attachments", () => {
  let directory = ""

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "opencode-native-attachments-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it("projects only opaque safe metadata and resolves a structured snapshot", async () => {
    const path = join(directory, "dirty.ts")
    await writeFile(path, "saved")
    const store = new AttachmentStore(directory)
    await store.addSnapshot(path, "unsaved editor text", "file")
    const chip = store.snapshot()[0]!
    deepEqual(chip, { id: chip.id, kind: "file", label: "dirty.ts", range: undefined })
    equal(JSON.stringify(chip).includes(directory), false)
    const parts = await store.resolve([chip.id])
    equal(Buffer.from(parts[0]!.url.split(",")[1]!, "base64").toString(), "unsaved editor text")
  })

  it("captures a stable selection snapshot and range", async () => {
    const path = join(directory, "selection.ts")
    await writeFile(path, "one\ntwo\nthree")
    const store = new AttachmentStore(directory)
    let selection = "two"
    await store.addSnapshot(path, selection, "selection", { start: 2, end: 2 })
    selection = "three"
    const chip = store.snapshot()[0]!
    equal(chip.range?.start, 2)
    const part = (await store.resolve([chip.id]))[0]!
    equal(Buffer.from(part.url.split(",")[1]!, "base64").toString(), "two")
  })

  it("keeps image bytes in the host and gates structured parts by model capability", async () => {
    const path = join(directory, "pixel.png")
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await writeFile(path, content)
    const store = new AttachmentStore(directory)
    await store.addImages([path])
    const chip = store.snapshot()[0]!
    deepEqual(chip, { id: chip.id, kind: "image", label: "pixel.png", range: undefined })
    equal(JSON.stringify(chip).includes("base64"), false)
    equal(JSON.stringify(chip).includes(directory), false)
    await rejects(store.resolve([chip.id]), /does not support image input/)
    const part = (await store.resolve([chip.id], true))[0]!
    equal(part.mime, "image/png")
    deepEqual(Buffer.from(part.url.split(",")[1]!, "base64"), content)
  })

  it("sniffs image content and enforces image size limits", async () => {
    const fake = join(directory, "fake.png")
    await writeFile(fake, "<svg onload=alert(1)></svg>")
    await rejects(new AttachmentStore(directory).addImages([fake]), /Only PNG, JPEG, GIF, and WebP/)

    const large = join(directory, "large.png")
    await writeFile(large, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MAX_IMAGE_BYTES),
    ]))
    await rejects(new AttachmentStore(directory).addImages([large]), /larger than 5 MiB/)
  })

  it("accepts bounded local text, PDF, image, audio, and video uploads without host paths", async () => {
    const store = new AttachmentStore(directory)
    const upload = (name: string, mime: string, content: Buffer) =>
      store.addLocalUpload(name, mime, content.toString("base64"))

    await upload("C:\\Users\\amr\\notes.ts", "video/mp2t", Buffer.from("const safe = true"))
    await upload("report.pdf", "application/pdf", Buffer.from("%PDF-1.7 safe"))
    await upload("pixel.png", "application/octet-stream", Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]))
    await upload("sound.mp3", "audio/mpeg", Buffer.from("ID3safe"))
    await upload("clip.mp4", "video/mp4", Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]))

    deepEqual(store.snapshot().map((item) => [item.label, item.kind]), [
      ["notes.ts", "file"], ["report.pdf", "file"], ["pixel.png", "image"],
      ["sound.mp3", "file"], ["clip.mp4", "file"],
    ])
    const parts = await store.resolve(store.snapshot().map((item) => item.id), true)
    deepEqual(parts.map((item) => item.mime), ["text/plain", "application/pdf", "image/png", "audio/mpeg", "video/mp4"])
    equal(JSON.stringify(store.snapshot()).includes("Users"), false)
  })

  it("rejects forged and unsupported local uploads", async () => {
    const store = new AttachmentStore(directory)
    await rejects(store.addLocalUpload("bad.bin", "application/octet-stream", "not base64"), /payload is invalid/)
    await rejects(store.addLocalUpload("fake.mp4", "video/mp4", Buffer.from("not a video").toString("base64")), /supports local text files/)
    await rejects(store.addLocalUpload("script.ts", "text/plain", Buffer.from([0, 1, 2]).toString("base64")), /binary data/)
  })

  it("bounds aggregate image memory and rejects an image changed while open", async () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const size = Math.floor(MAX_IMAGE_TOTAL_BYTES / 3)
    const paths = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
      const path = join(directory, `${index}.png`)
      await writeFile(path, Buffer.concat([header, Buffer.alloc(size)]))
      return path
    }))
    const aggregate = new AttachmentStore(directory)
    await aggregate.addImages(paths.slice(0, 2))
    await rejects(aggregate.addImages(paths.slice(2)), /10 MiB total/)

    const changing = join(directory, "changing.png")
    await writeFile(changing, Buffer.concat([header, Buffer.from("safe")]))
    const replacement = new AttachmentStore(directory, {
      afterOpen: async () => writeFile(changing, Buffer.concat([header, Buffer.from("changed")]))
    })
    await rejects(replacement.addImages([changing]), /changed while OpenCode was reading it/)

    await rejects(
      new AttachmentStore(directory).addImages(Array.from({ length: MAX_IMAGES + 1 }, () => changing)),
      /up to 4 images/,
    )
  })

  it("rejects outside paths, directories, and symlinks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opencode-native-outside-"))
    const file = join(outside, "outside.ts")
    await writeFile(file, "outside")
    const folder = join(directory, "folder")
    await mkdir(folder)
    const link = join(directory, "link.ts")
    await symlink(file, link)
    const store = new AttachmentStore(directory)
    await rejects(store.addFiles([file]), /inside the current workspace/)
    await rejects(store.addFiles([folder]), /regular workspace files/)
    await rejects(store.addFiles([link]), /Symlinked files/)
    await rm(outside, { recursive: true, force: true })
  })

  it("enforces per-item, aggregate, count, and opaque-ID limits", async () => {
    const path = join(directory, "large.txt")
    await writeFile(path, "x".repeat(MAX_ATTACHMENT_BYTES + 1))
    await rejects(new AttachmentStore(directory).addFiles([path]), /larger than 256 KiB/)

    await writeFile(path, "ok")
    const aggregate = new AttachmentStore(directory)
    for (let index = 0; index < 4; index++) {
      await aggregate.addSnapshot(path, String(index).repeat(220 * 1024), "file")
    }
    await rejects(aggregate.addSnapshot(path, "x".repeat(220 * 1024), "file"), /1 MiB total/)

    const count = new AttachmentStore(directory)
    for (let index = 0; index < MAX_ATTACHMENTS; index++) await count.addSnapshot(path, `${index}`, "file")
    await rejects(count.addSnapshot(path, "overflow", "file"), /up to 20/)
    await rejects(count.resolve(["forged_attachment_key_123"]), /no longer available/)
  })

  it("rejects an oversized file batch before filesystem access", async () => {
    const missing = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => join(directory, `missing-${index}.txt`))
    await rejects(new AttachmentStore(directory).addFiles(missing), /up to 20 context attachments/)
  })

  it("sanitizes malicious labels and revalidates files at Send", async () => {
    equal(safeLabel("src/\u202eevil\n.ts"), "src/�evil�.ts")
    const path = join(directory, "gone.ts")
    await writeFile(path, "content")
    const store = new AttachmentStore(directory)
    await store.addFiles([path])
    await unlink(path)
    await rejects(store.resolve([store.snapshot()[0]!.id]))
  })

  it("clears only explicitly accepted attachment references", async () => {
    const first = join(directory, "first.ts")
    const second = join(directory, "second.ts")
    await writeFile(first, "first")
    await writeFile(second, "second")
    const store = new AttachmentStore(directory)
    await store.addFiles([first, second])
    const [accepted, preserved] = store.snapshot()
    store.removeMany([accepted!.id])
    deepEqual(store.snapshot().map((item) => item.id), [preserved!.id])
  })

  it("rejects replacement and growth after the file is opened", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opencode-native-race-"))
    const secret = join(outside, "secret.txt")
    const replaced = join(directory, "replaced.txt")
    await writeFile(secret, "secret")
    await writeFile(replaced, "safe")
    const replacement = new AttachmentStore(directory, {
      afterOpen: async () => {
        await unlink(replaced)
        await symlink(secret, replaced)
      },
    })
    await rejects(replacement.addFiles([replaced]), /changed|Symlinked/)

    const growing = join(directory, "growing.txt")
    await writeFile(growing, "safe")
    const growth = new AttachmentStore(directory, {
      afterOpen: async () => appendFile(growing, "x".repeat(MAX_ATTACHMENT_BYTES + 1)),
    })
    await rejects(growth.addFiles([growing]), /larger than 256 KiB/)

    const rewritten = join(directory, "rewritten.txt")
    await writeFile(rewritten, "safe")
    const rewrite = new AttachmentStore(directory, {
      afterOpen: async () => writeFile(rewritten, "evil"),
    })
    await rejects(rewrite.addFiles([rewritten]), /changed/)
    await rm(outside, { recursive: true, force: true })
  })

  it("serializes concurrent additions and rechecks count at commit", async () => {
    const paths = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
      const path = join(directory, `${index}.txt`)
      await writeFile(path, `${index}`)
      return path
    }))
    const store = new AttachmentStore(directory)
    const results = await Promise.allSettled([store.addFiles(paths.slice(0, 12)), store.addFiles(paths.slice(12))])
    equal(results.filter((result) => result.status === "rejected").length, 1)
    equal(store.snapshot().length, 12)
  })

  it("discards an attachment that completes after Clear or New Chat", async () => {
    const path = join(directory, "late.txt")
    await writeFile(path, "late")
    let release = () => {}
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let opened = () => {}
    const started = new Promise<void>((resolve) => { opened = resolve })
    const store = new AttachmentStore(directory, {
      afterOpen: async () => {
        opened()
        await blocked
      },
    })
    const adding = store.addFiles([path])
    await started
    store.clear()
    release()
    await adding
    deepEqual(store.snapshot(), [])
  })

  it("rejects Send resolution that completes after Clear or New Chat", async () => {
    const path = join(directory, "send-race.txt")
    await writeFile(path, "context")
    const store = new AttachmentStore(directory)
    await store.addFiles([path])
    const resolving = store.resolve([store.snapshot()[0]!.id])
    store.clear()
    await rejects(resolving, /changed before the prompt was sent|no longer available/)
  })
})
