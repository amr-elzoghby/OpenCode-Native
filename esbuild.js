const esbuild = require("esbuild")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started")
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        console.error(`    ${location.file}:${location.line}:${location.column}:`)
      })
      console.log("[watch] build finished")
    })
  },
}

async function main() {
  const contexts = await Promise.all(
    [
      {
        entryPoints: ["src/extension.ts"],
        format: "cjs",
        platform: "node",
        outfile: "dist/extension.js",
        external: ["vscode"],
      },
      {
        entryPoints: ["src/webview.ts"],
        format: "iife",
        platform: "browser",
        outfile: "dist/webview.js",
      },
      {
        entryPoints: ["src/server-host.ts"],
        format: "cjs",
        platform: "node",
        outfile: "dist/server-host.js",
      },
    ].map((options) =>
      esbuild.context({
        ...options,
        bundle: true,
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        logLevel: "silent",
        plugins: [esbuildProblemMatcherPlugin],
      }),
    ),
  )
  if (watch) {
    await Promise.all(contexts.map((context) => context.watch()))
    return
  }

  await Promise.all(contexts.map((context) => context.rebuild()))
  await Promise.all(contexts.map((context) => context.dispose()))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
