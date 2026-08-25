import { deepEqual, equal, rejects } from "node:assert/strict"
import { MAX_LOCAL_FILE_BYTES } from "../protocol"
import { encodeLocalFile, insertPastedText, previewImageInfo } from "../webview-attachments"

describe("local device file picker uploads", () => {
  it("encodes the exact browser-selected bytes and metadata", async () => {
    const content = Uint8Array.from([0, 1, 2, 253, 254, 255])
    deepEqual(await encodeLocalFile({
      name: "clip.mp4",
      type: "video/mp4",
      size: content.byteLength,
      arrayBuffer: async () => content.buffer,
    }), {
      name: "clip.mp4",
      mime: "video/mp4",
      data: Buffer.from(content).toString("base64"),
    })
  })

  it("rejects empty, oversized, and changed browser files before posting", async () => {
    await rejects(encodeLocalFile({ name: "empty", type: "", size: 0, arrayBuffer: async () => new ArrayBuffer(0) }), /empty/)
    await rejects(encodeLocalFile({
      name: "large", type: "video/mp4", size: MAX_LOCAL_FILE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0),
    }), /larger than 25 MiB/)
    await rejects(encodeLocalFile({
      name: "changed", type: "text/plain", size: 2, arrayBuffer: async () => new Uint8Array([1]).buffer,
    }), /changed/)
  })

  it("replaces the selected text, preserves the caret, and respects maxlength", () => {
    const events: Array<{ type: string; bubbles?: boolean }> = []
    const input = fakeTextarea("hello world", 6, 11, 12, events)
    deepEqual(insertPastedText(input, "beautiful"), { inserted: "beauti", truncated: true })
    equal(input.value, "hello beauti")
    equal(input.selectionStart, 12)
    equal(input.selectionEnd, 12)
    deepEqual(events, [{ type: "input", bubbles: true }])

    const full = fakeTextarea("1234", 4, 4, 4, events)
    deepEqual(insertPastedText(full, "x"), { inserted: "", truncated: true })
    equal(full.value, "1234")
    equal(events.length, 1)
  })

  it("keeps Arabic, English, multiline text, and emoji intact at the paste boundary", () => {
    const events: Array<{ type: string; bubbles?: boolean }> = []
    const mixed = fakeTextarea("ابدأ: ", 6, 6, 100, events)
    deepEqual(insertPastedText(mixed, "hello\n🙂 تمام"), { inserted: "hello\n🙂 تمام", truncated: false })
    equal(mixed.value, "ابدأ: hello\n🙂 تمام")
    const emojiBoundary = fakeTextarea("", 0, 0, 1, events)
    deepEqual(insertPastedText(emojiBoundary, "🙂"), { inserted: "", truncated: true })
    equal(emojiBoundary.value, "")
    const exactEmoji = fakeTextarea("", 0, 0, 2, events)
    deepEqual(insertPastedText(exactEmoji, "🙂x"), { inserted: "🙂", truncated: true })
    equal(exactEmoji.value, "🙂")
    equal(exactEmoji.selectionStart, 2)
  })

  it("reads bounded PNG, JPEG, GIF, and WebP dimensions from raster headers", () => {
    deepEqual(previewImageInfo(png(640, 480)), { mime: "image/png", width: 640, height: 480 })
    deepEqual(previewImageInfo(jpeg(1_024, 768)), { mime: "image/jpeg", width: 1_024, height: 768 })
    deepEqual(previewImageInfo(gif(320, 200)), { mime: "image/gif", width: 320, height: 200 })
    deepEqual(previewImageInfo(webp(800, 600)), { mime: "image/webp", width: 800, height: 600 })
  })

  it("rejects malformed, non-raster, zero-sized, and decompression-sized previews", () => {
    equal(previewImageInfo(new TextEncoder().encode('<svg onload="alert(1)"></svg>')), undefined)
    equal(previewImageInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 20])), undefined)
    equal(previewImageInfo(png(0, 100)), undefined)
    equal(previewImageInfo(png(8_193, 1)), undefined)
    equal(previewImageInfo(png(5_000, 5_000)), undefined)
    deepEqual(previewImageInfo(png(8_192, 1)), { mime: "image/png", width: 8_192, height: 1 })
  })
})

function fakeTextarea(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  maxLength: number,
  events: Array<{ type: string; bubbles?: boolean }>,
) {
  class FakeEvent {
    constructor(public type: string, public init: { bubbles?: boolean } = {}) {}
  }
  const input = {
    value,
    selectionStart,
    selectionEnd,
    maxLength,
    ownerDocument: { defaultView: { Event: FakeEvent } },
    setRangeText(text: string, start: number, end: number, selectionMode: string) {
      equal(selectionMode, "end")
      this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`
      this.selectionStart = start + text.length
      this.selectionEnd = this.selectionStart
    },
    dispatchEvent(event: FakeEvent) {
      events.push({ type: event.type, bubbles: event.init.bubbles })
      return true
    },
  }
  return input as unknown as HTMLTextAreaElement
}

function png(width: number, height: number) {
  const value = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 0, 0, 0, 0, 0,
  ])
  writeUint32BE(value, 16, width)
  writeUint32BE(value, 20, height)
  return value
}

function jpeg(width: number, height: number) {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 7, 8,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0,
  ])
}

function gif(width: number, height: number) {
  return Uint8Array.from([
    ...Buffer.from("GIF89a", "ascii"),
    width & 0xff, (width >>> 8) & 0xff,
    height & 0xff, (height >>> 8) & 0xff,
  ])
}

function webp(width: number, height: number) {
  const value = new Uint8Array(30)
  value.set(Buffer.from("RIFF", "ascii"), 0)
  value.set(Buffer.from("WEBP", "ascii"), 8)
  value.set(Buffer.from("VP8X", "ascii"), 12)
  writeUint24LE(value, 24, width - 1)
  writeUint24LE(value, 27, height - 1)
  return value
}

function writeUint24LE(value: Uint8Array, offset: number, number: number) {
  value[offset] = number & 0xff
  value[offset + 1] = (number >>> 8) & 0xff
  value[offset + 2] = (number >>> 16) & 0xff
}

function writeUint32BE(value: Uint8Array, offset: number, number: number) {
  value[offset] = (number >>> 24) & 0xff
  value[offset + 1] = (number >>> 16) & 0xff
  value[offset + 2] = (number >>> 8) & 0xff
  value[offset + 3] = number & 0xff
}
