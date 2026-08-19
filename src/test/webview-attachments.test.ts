import { deepEqual, rejects } from "node:assert/strict"
import { MAX_LOCAL_FILE_BYTES } from "../protocol"
import { encodeLocalFile } from "../webview-attachments"

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
})
