// SPDX-License-Identifier: AGPL-3.0-only
// Web smoke test — drives the BUILT, RUNNING server (not units/types) to catch the
// "green but blind" class of bug that bit inc 23 repeatedly: build + tests pass while
// the real artifact is broken (unstyled page, dead SSR cookie read, leaked secret).
//
// Assumes the web package is already built (dist/server + dist/client). Run after
// `pnpm --filter @junction/web build`. Boots serve.mjs on an ephemeral port against
// a throwaway JUNCTION_HOME, curls the real responses, asserts, and exits non-zero on
// any failure. No browser needed — these are deterministic HTTP/HTML checks.
//
// Deeper visual/interaction QA (theme toggle, collapse persistence, no-shake nav,
// reduced-motion) is the `junction-web-verify` skill's job via `agent-browser`.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const webDir = join(__dirname, "..", "packages", "web")
const PORT = 4319 + Math.floor((Date.now() % 1000) / 10) // spread across runs; not crypto
const BASE = `http://127.0.0.1:${PORT}`

const home = mkdtempSync(join(tmpdir(), "junction-smoke-"))
const failures = []
const ok = (cond, msg) => (cond ? null : failures.push(msg))

const server = spawn("node", ["serve.mjs"], {
  cwd: webDir,
  env: { ...process.env, JUNCTION_HOME: home, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverErr = ""
server.stderr.on("data", (d) => {
  serverErr += String(d)
})

function cleanup() {
  try {
    server.kill("SIGKILL")
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
}

async function waitUp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`)
      if (r.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

try {
  if (!(await waitUp())) {
    console.error(`web:smoke — server did not come up on ${BASE}\n${serverErr}`)
    cleanup()
    process.exit(1)
  }

  // 1. Home renders 200 + the stylesheet is LINKED (B0: unstyled-build regression).
  const homeRes = await fetch(`${BASE}/`)
  const homeHtml = await homeRes.text()
  ok(homeRes.status === 200, "GET / did not return 200")
  ok(/<link[^>]+rel="stylesheet"/.test(homeHtml), "no <link rel=stylesheet> in / (unstyled build)")

  // 2. The linked CSS asset actually SERVES 200 text/css (B0: serve.mjs static serving).
  const cssMatch = homeHtml.match(/href="(\/assets\/[^"]+\.css)"/)
  ok(cssMatch != null, "no /assets/*.css href found in /")
  if (cssMatch) {
    const cssRes = await fetch(`${BASE}${cssMatch[1]}`)
    ok(cssRes.status === 200, `CSS asset ${cssMatch[1]} did not return 200`)
    ok(
      (cssRes.headers.get("content-type") ?? "").includes("text/css"),
      "CSS asset served without text/css content-type",
    )
  }

  // 3. SSR cookie read works: collapsed cookie → server renders data-sidebar="collapsed"
  //    (the inc-23 sidebar SSR bug: server always rendered "expanded").
  const collapsedRes = await fetch(`${BASE}/`, {
    headers: { cookie: "junction-sidebar=collapsed" },
  })
  const collapsedHtml = await collapsedRes.text()
  ok(
    /<html[^>]+data-sidebar="collapsed"/.test(collapsedHtml),
    'collapsed cookie did NOT yield data-sidebar="collapsed" (SSR cookie read broken)',
  )
  ok(
    /<html[^>]+data-sidebar="expanded"/.test(homeHtml),
    'no-cookie did NOT yield data-sidebar="expanded" (SSR default broken)',
  )

  // 4. No server-only / secret identifiers in the SSR HTML payload (defence-in-depth
  //    beyond the dist/client leak-grep — this checks the rendered response too).
  for (const bad of [
    "secretRef",
    "secret_ref",
    "better-sqlite3",
    "@junction/core",
    "CREATE TABLE",
  ]) {
    ok(!homeHtml.includes(bad), `server-only identifier "${bad}" leaked into SSR HTML`)
  }

  // 5. Real routes render 200 (no SSR crash on any page).
  for (const path of ["/platforms", "/credentials", "/profiles"]) {
    const r = await fetch(`${BASE}${path}`)
    ok(r.status === 200, `GET ${path} returned ${r.status}, expected 200`)
  }
  // 6. Unknown route returns the not-found page (404 status + an HTML body, NOT a 500 crash).
  const nf = await fetch(`${BASE}/does-not-exist`)
  ok(nf.status === 404, `GET /does-not-exist returned ${nf.status}, expected 404 (not-found route)`)
  ok((await nf.text()).includes("<html"), "/does-not-exist did not return an HTML not-found page")

  cleanup()
  if (failures.length > 0) {
    console.error(`web:smoke FAILED (${failures.length}):`)
    for (const f of failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.log("web:smoke OK — built server serves styled, SSR-correct, leak-free responses.")
  process.exit(0)
} catch (err) {
  cleanup()
  console.error(`web:smoke errored: ${String(err)}\n${serverErr}`)
  process.exit(1)
}
