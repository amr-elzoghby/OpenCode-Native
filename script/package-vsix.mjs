import { readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import JSZip from "jszip"

const root = new URL("../", import.meta.url)
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const filename = `${manifest.name}-${manifest.version}.vsix`
const output = new URL(`dist/${filename}`, root)
const temporary = new URL(`dist/.${filename}.${process.pid}.tmp`, root)

const files = [
  "package.json",
  "README.md",
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
zip.file("extension.vsixmanifest", vsixManifest(manifest))
zip.file("[Content_Types].xml", contentTypes())
for (const file of files) {
  const contents = await readFile(new URL(file, root))
  zip.file(
    `extension/${archiveName(file)}`,
    file === "README.md" ? rewriteReadmeImages(contents.toString("utf8"), manifest) : contents,
  )
}

try {
  await writeFile(temporary, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  }))
  await rename(temporary, output)
  console.log(`Packaged current production bundles: ${join(new URL("dist/", root).pathname, filename)}`)
} catch (error) {
  await unlink(temporary).catch(() => undefined)
  throw error
}

function archiveName(file) {
  if (file === "README.md") return "readme.md"
  if (file === "LICENSE") return "LICENSE.txt"
  return file
}

function rewriteReadmeImages(markdown, value) {
  const base = readmeImageBase(value)
  const rewrite = (source) => {
    if (!isRelativeImage(source)) return source
    const resolved = new URL(source, base)
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
      throw new Error(`README image escapes its GitHub package directory: ${source}`)
    }
    return resolved.href
  }

  return markdown
    .replace(/(!\[[^\]\r\n]*\]\()([^\s)]+)([^)]*\))/g, (_, before, source, after) => `${before}${rewrite(source)}${after}`)
    .replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/gi, (_, before, source, after) => `${before}${rewrite(source)}${after}`)
}

function isRelativeImage(source) {
  return !source.startsWith("/")
    && !source.startsWith("#")
    && !source.startsWith("//")
    && !/^[a-z][a-z\d+.-]*:/i.test(source)
}

function readmeImageBase(value) {
  const repository = githubRepository(value.repository)
  const homepage = githubHomepage(value.homepage)
  if (!repository || !homepage) {
    throw new Error("Relative README images require HTTPS GitHub repository and homepage URLs.")
  }
  if (repository.owner.toLowerCase() !== homepage.owner.toLowerCase()
    || repository.name.toLowerCase() !== homepage.name.toLowerCase()) {
    throw new Error("The GitHub repository and homepage must identify the same repository.")
  }

  const segments = [repository.owner, repository.name, homepage.ref, ...homepage.directory]
  return new URL(`${segments.map((segment) => encodeURIComponent(segment)).join("/")}/`, "https://raw.githubusercontent.com/")
}

function githubRepository(value) {
  const source = typeof value === "object" && value ? value.url : value
  const url = githubUrl(source)
  if (!url) return
  const segments = githubSegments(url)
  if (segments.length !== 2) return
  const name = segments[1].replace(/\.git$/i, "")
  if (!name) return
  return { owner: segments[0], name }
}

function githubHomepage(value) {
  const url = githubUrl(value)
  if (!url) return
  const segments = githubSegments(url)
  if (segments.length < 4 || segments[2] !== "tree") return
  return {
    owner: segments[0],
    name: segments[1].replace(/\.git$/i, ""),
    ref: segments[3],
    directory: segments.slice(4),
  }
}

function githubUrl(value) {
  if (typeof value !== "string") return
  try {
    const url = new URL(value.startsWith("git+") ? value.slice(4) : value)
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port) return
    return url
  } catch {
    return
  }
}

function githubSegments(url) {
  return url.pathname.split("/").filter(Boolean).map((segment) => {
    const value = decodeURIComponent(segment)
    if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
      throw new Error(`Unsafe GitHub URL segment: ${segment}`)
    }
    return value
  })
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

function vsixManifest(value) {
  const repository = typeof value.repository === "object" ? value.repository.url : value.repository
  const support = typeof value.bugs === "object" ? value.bugs.url : value.bugs
  const extensionKind = Array.isArray(value.extensionKind) ? value.extensionKind.join(",") : value.extensionKind ?? "workspace"
  const flags = value.preview ? "Public Preview" : "Public"
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(value.name)}" Version="${xml(value.version)}" Publisher="${xml(value.publisher)}" />
    <DisplayName>${xml(value.displayName ?? value.name)}</DisplayName>
    <Description xml:space="preserve">${xml(value.description ?? "")}</Description>
    <Tags>${xml((value.keywords ?? []).join(","))}</Tags>
    <Categories>${xml((value.categories ?? []).join(","))}</Categories>
    <GalleryFlags>${flags}</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(value.engines?.vscode ?? "*")}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${xml((value.extensionDependencies ?? []).join(","))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="${xml((value.extensionPack ?? []).join(","))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml(extensionKind)}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="${xml((value.enabledApiProposals ?? []).join(","))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xml(repository ?? "")}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="${xml(repository ?? "")}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${xml(repository ?? "")}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${xml(support ?? "")}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${xml(value.homepage ?? "")}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${xml(value.galleryBanner?.color ?? "#000000")}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${xml(value.galleryBanner?.theme ?? "dark")}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="${xml(value.pricing ?? "Free")}" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${xml(value.icon)}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xml(value.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>`
}

function contentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".svg" ContentType="image/svg+xml"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>`
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
