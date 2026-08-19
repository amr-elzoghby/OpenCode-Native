import { deepStrictEqual, equal, match } from "node:assert/strict"
import { readFile } from "node:fs/promises"
import JSZip from "jszip"

const root = new URL("../", import.meta.url)
const sourceManifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const path = process.argv[2] ?? new URL(`dist/${sourceManifest.name}-${sourceManifest.version}.vsix`, root)

const archive = await JSZip.loadAsync(await readFile(path))
const expectedFiles = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/package.json",
  "extension/readme.md",
  "extension/LICENSE.txt",
  "extension/THIRD_PARTY_NOTICES.md",
  "extension/dist/extension.js",
  "extension/dist/webview.js",
  "extension/dist/server-host.js",
  "extension/images/button-dark.svg",
  "extension/images/button-light.svg",
  "extension/images/icon.png",
  "extension/images/screenshots/add-context.png",
  "extension/images/screenshots/add-local-file.png",
  "extension/images/screenshots/native-review.png",
  "extension/images/screenshots/provider-connect.png",
  "extension/images/screenshots/slash-commands.png",
  "extension/images/screenshots/tui-parity.png",
]
deepStrictEqual(Object.values(archive.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort(), expectedFiles.sort())
const entry = archive.file("extension/package.json")
if (!entry) throw new Error("The VSIX does not contain extension/package.json.")

const manifest = JSON.parse(await entry.async("string"))
const command = "opencode.native.addExplorerFiles"

deepStrictEqual(manifest, sourceManifest)
equal(manifest.contributes?.commands?.some((item) => item.command === command), true)
deepStrictEqual(manifest.contributes?.menus?.["explorer/context"], [{
  command,
  when: "resourceScheme == file && !explorerResourceIsFolder",
  group: "2_workspace@50",
}])

for (const file of ["extension.js", "webview.js", "server-host.js"]) {
  const bundled = archive.file(`extension/dist/${file}`)
  if (!bundled) throw new Error(`The VSIX does not contain dist/${file}.`)
  const [actual, expected] = await Promise.all([
    bundled.async("nodebuffer"),
    readFile(new URL(`dist/${file}`, root)),
  ])
  equal(actual.equals(expected), true, `The VSIX contains a stale dist/${file}.`)
}

const webviewEntry = archive.file("extension/dist/webview.js")
if (!webviewEntry) throw new Error("The VSIX does not contain dist/webview.js.")
const webview = await webviewEntry.async("string")
match(webview, /activity-summary/)
match(webview, /review-card/)
match(webview, /Chat tokens/)
match(webview, /rollback-dock/)
match(webview, /\/mcps/)
match(webview, /\/status/)

const readmeEntry = archive.file("extension/readme.md")
if (!readmeEntry) throw new Error("The VSIX does not contain extension/readme.md.")
const [sourceReadme, packagedReadme] = await Promise.all([
  readFile(new URL("README.md", root), "utf8"),
  readmeEntry.async("string"),
])
const imageBase = "https://raw.githubusercontent.com/amr-elzoghby/OpenCode-Native/main/images/screenshots/"
for (const file of ["add-context.png", "add-local-file.png", "native-review.png", "provider-connect.png", "slash-commands.png", "tui-parity.png"]) {
  equal(sourceReadme.includes(`images/screenshots/${file}`), true, `The source README no longer references ${file}.`)
  equal(packagedReadme.includes(`${imageBase}${file}`), true, `The packaged README does not use an HTTPS URL for ${file}.`)
}
equal(sourceReadme.includes(imageBase), false, "The source README must keep portable relative image links.")
equal(packagedReadme.includes("](images/screenshots/"), false, "The packaged README contains a relative Markdown image URL.")
equal(packagedReadme.includes('src="images/screenshots/'), false, "The packaged README contains a relative HTML image URL.")
equal(packagedReadme.includes("[MIT License](LICENSE)"), true, "Packaging rewrote a non-image README link.")
equal(packagedReadme.includes("[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)"), true, "Packaging rewrote a non-image README link.")
equal(Object.keys(archive.files).some((name) => /(?:^|\/)(?:src|node_modules|out)\//.test(name) || name.endsWith(".map")), false)
