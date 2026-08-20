import { randomBytes } from "node:crypto"
import { open, readFile, readdir, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import JSZip from "jszip"
import { ARCHIVE_DATE, contentTypes, rewriteReadmeImages, vsixManifest } from "./vsix-content.mjs"

const root = new URL("../", import.meta.url)
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const filename = `${manifest.name}-${manifest.version}.vsix`
const output = new URL(`dist/${filename}`, root)
const temporary = new URL(`dist/.${filename}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`, root)
const zipOptions = { date: ARCHIVE_DATE, createFolders: false }

const files = [
  "package.json",
  "README.md",
  "PRIVACY.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "dist/extension.js",
  "dist/webview.js",
  "dist/server-host.js",
  "images/button-dark.svg",
  "images/button-light.svg",
  "images/icon.png",
  "images/screenshots/add-context.png",
  "images/screenshots/add-local-file.png",
  "images/screenshots/native-review.png",
  "images/screenshots/provider-connect.png",
  "images/screenshots/slash-commands.png",
  "images/screenshots/tui-parity.png",
]

const productionSources = await sourceFiles(new URL("src/", root))
const newestSource = Math.max(...await Promise.all(productionSources.map(async (file) => (await stat(file)).mtimeMs)))
const bundles = files.filter((file) => file.startsWith("dist/"))
const oldestBundle = Math.min(...await Promise.all(bundles.map(async (file) => (await stat(new URL(file, root))).mtimeMs)))
if (newestSource > oldestBundle) throw new Error("Production sources are newer than dist. Run `bun run package` to rebuild before packaging.")

const zip = new JSZip()
zip.file("extension.vsixmanifest", vsixManifest(manifest), zipOptions)
zip.file("[Content_Types].xml", contentTypes(), zipOptions)
for (const file of files) {
  const contents = await readFile(new URL(file, root))
  zip.file(
    `extension/${archiveName(file)}`,
    file === "README.md" ? rewriteReadmeImages(contents.toString("utf8"), manifest) : contents,
    zipOptions,
  )
}

let handle
let temporaryCreated = false
try {
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  })
  handle = await open(temporary, "wx", 0o600)
  temporaryCreated = true
  await handle.writeFile(archive)
  await handle.close()
  handle = undefined
  await rename(temporary, output)
  console.log(`Packaged current production bundles: ${join(new URL("dist/", root).pathname, filename)}`)
} catch (error) {
  await handle?.close().catch(() => undefined)
  if (temporaryCreated) await unlink(temporary).catch(() => undefined)
  throw error
}

function archiveName(file) {
  if (file === "README.md") return "readme.md"
  if (file === "LICENSE") return "LICENSE.txt"
  return file
}

async function sourceFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "test") continue
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory)
    if (entry.isDirectory()) result.push(...await sourceFiles(url))
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(url)
  }
  return result
}
