// SPDX-License-Identifier: AGPL-3.0-only
// `junction web` — launch the @junction/web dashboard (read-only).
//
// ARCHITECTURE: this command resolves the web server entry via
// import.meta.resolve("@junction/web/server") — an ARTIFACT dependency, not a
// code import. The CLI source NEVER imports from @junction/web modules; the
// package.json dep enables import.meta.resolve to find serve.mjs.
// depcruise sees no code edge (import.meta.resolve is a runtime call, not a
// static import declaration).
//
// The resolved file is packages/web/serve.mjs — a thin Node.js HTTP → Fetch
// bridge. serve.mjs itself loads the built SSR bundle (dist/server/server.js)
// and will exit with a clear error if that bundle is missing.

import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { defineCommand } from "citty"

export const webCommand = defineCommand({
  meta: {
    name: "web",
    description: "Launch the local web dashboard (http://127.0.0.1:<port>).",
  },
  args: {
    port: {
      type: "string",
      description: "Port to listen on",
      default: "4321",
    },
    open: {
      type: "boolean",
      description: "Open the browser automatically",
      default: true,
    },
  },
  async run({ args }) {
    // Resolve serve.mjs (committed source; always present after `pnpm install`).
    // Throws only if the @junction/web package is not installed at all.
    let entryPath: string
    try {
      entryPath = fileURLToPath(import.meta.resolve("@junction/web/server"))
    } catch {
      process.stderr.write(
        "junction web: could not resolve @junction/web/server.\n" +
          "Run `pnpm install && pnpm build` first.\n",
      )
      process.exitCode = 1
      return
    }

    // serve.mjs itself checks for dist/server/server.js and exits with a clear
    // message if it's missing — no need to re-check the SSR bundle here.
    // But verify serve.mjs itself is readable as a basic sanity guard.
    try {
      await access(entryPath)
    } catch {
      process.stderr.write(
        `junction web: serve.mjs not found at ${entryPath}\n` +
          "This is unexpected — try reinstalling with `pnpm install`.\n",
      )
      process.exitCode = 1
      return
    }

    const port = args.port ?? "4321"
    const url = `http://127.0.0.1:${port}`

    const child = spawn(process.execPath, [entryPath], {
      stdio: "inherit",
      env: { ...process.env, HOST: "127.0.0.1", PORT: port },
    })

    if (args.open !== false) {
      // Small delay so the HTTP server can bind before the browser connects
      setTimeout(() => openInBrowser(url), 800)
    }

    await new Promise<void>((resolve) => {
      child.on("close", (code) => {
        if (code !== null && code !== 0) process.exitCode = code
        resolve()
      })
    })
  },
})

/** Open a URL in the system default browser. No new dependency. */
function openInBrowser(url: string): void {
  let cmd: string
  let cmdArgs: string[]
  if (process.platform === "darwin") {
    cmd = "open"
    cmdArgs = [url]
  } else if (process.platform === "win32") {
    cmd = "cmd"
    cmdArgs = ["/c", "start", url]
  } else {
    cmd = "xdg-open"
    cmdArgs = [url]
  }
  spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref()
}
