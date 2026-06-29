// SPDX-License-Identifier: AGPL-3.0-only
// web-launch — start the @junction/web dashboard in dev or prod, with a dynamic home/port.
//
// Two modes:
//   - prod (default): runs the built SSR server (packages/web/serve.mjs). Agentation is
//     compiled OUT (it is import.meta.env.DEV-gated). This is what `junction web` runs.
//   - dev (--dev): runs the Vite dev server (HMR + the agentation annotation overlay).
//
// Flags (all optional; flags win over env, env wins over defaults):
//   --dev               use the Vite dev server instead of the built prod server
//   --home <path>       JUNCTION_HOME for the child (the data dir the dashboard reads)
//   --default-home <p>  fallback home used ONLY if neither --home nor JUNCTION_HOME is set
//                       (the dev script sets this to /tmp/jtest; prod leaves it unset →
//                        core's default ~/.junction). Explicit --home/env always win.
//   --port <n>          port to listen on (prod default 4321, dev default 5173)
//   --store <kind>      JUNCTION_STORE (e.g. "file"); passed through if given
//
// Usage:
//   node scripts/web-launch.mjs --home /tmp/jtest --port 4321          # prod
//   node scripts/web-launch.mjs --dev --home /tmp/jtest --port 5173    # dev + agentation
//   JUNCTION_HOME=/tmp/jtest node scripts/web-launch.mjs --dev         # env also works
//
// Wrapped by the root scripts `pnpm web:prod` and `pnpm web:dev`.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..")
const webDir = join(repoRoot, "packages", "web")

// ── parse flags ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    dev: false,
    home: undefined,
    defaultHome: undefined,
    port: undefined,
    store: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dev") opts.dev = true
    else if (a === "--home") opts.home = argv[++i]
    else if (a === "--default-home") opts.defaultHome = argv[++i]
    else if (a === "--port") opts.port = argv[++i]
    else if (a === "--store") opts.store = argv[++i]
    else if (a.startsWith("--home=")) opts.home = a.slice("--home=".length)
    else if (a.startsWith("--default-home=")) opts.defaultHome = a.slice("--default-home=".length)
    else if (a.startsWith("--port=")) opts.port = a.slice("--port=".length)
    else if (a.startsWith("--store=")) opts.store = a.slice("--store=".length)
    else {
      console.error(`web-launch: unknown argument "${a}"`)
      process.exit(2)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

// Home precedence: explicit --home > JUNCTION_HOME env > --default-home (script default) > unset.
// So a user can always override the dev script's /tmp/jtest default via flag or env.
const home = opts.home ?? process.env.JUNCTION_HOME ?? opts.defaultHome
const store = opts.store ?? process.env.JUNCTION_STORE
const port = opts.port ?? process.env.PORT ?? (opts.dev ? "5173" : "4321")

// Build the child env: pass JUNCTION_HOME/STORE/PORT through to the server process,
// which is where core's getPaths() reads them (server-side in both modes).
const childEnv = { ...process.env, PORT: String(port) }
if (home !== undefined) childEnv.JUNCTION_HOME = home
if (store !== undefined) childEnv.JUNCTION_STORE = store

const homeLabel = home ?? "(default ~/.junction)"

// ── launch ──────────────────────────────────────────────────────────────────────
let cmd
let args
if (opts.dev) {
  // Vite dev server (agentation overlay included). --port is native to vite.
  cmd = "pnpm"
  args = ["--filter", "@junction/web", "exec", "vite", "dev", "--port", String(port)]
  console.log(`web (dev): vite dev → http://127.0.0.1:${port}  home=${homeLabel}  [agentation on]`)
} else {
  // Built prod server. Guard that a build exists so the failure is clear, not cryptic.
  const builtServer = join(webDir, "dist", "server", "server.js")
  if (!existsSync(builtServer)) {
    console.error(
      `web (prod): no build found at ${builtServer}\n` +
        `Run \`pnpm --filter @junction/web build\` first (or use --dev for the dev server).`,
    )
    process.exit(1)
  }
  cmd = process.execPath
  args = [join(webDir, "serve.mjs")]
  console.log(`web (prod): serve.mjs → http://127.0.0.1:${port}  home=${homeLabel}`)
}

const child = spawn(cmd, args, { cwd: repoRoot, env: childEnv, stdio: "inherit" })

// Forward termination signals so Ctrl-C cleanly stops the child.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig))
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
