// SPDX-License-Identifier: AGPL-3.0-only
// Client-bundle leak check — the server-only-core boundary's definitive gate.
// Shared by `pnpm verify:web` (local loop) and the CI web-build job, so the logic
// lives in ONE place (was duplicated in ci.yml). Assumes the web client bundle is
// already built (packages/web/dist/client).
//
// Three-part check (green-but-blind defence — a missing/empty dir must FAIL, not
// vacuously pass):
//   1. Existence guard: dist/client/assets exists and is non-empty.
//   2. Negative: no server-only / secret-payload identifiers in any client chunk.
//   3. Positive control: a string KNOWN to be in the bundle IS present — proves the
//      scan hit real content (so an empty match-set means "clean", never "scanned nothing").

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// --dir <path> overrides the scan root (used by the leakcheck self-tests to
// point at a planted fixture instead of the real build output). Default
// unchanged: packages/web/dist/client. A --dir flag with a MISSING value is a
// hard error — silently falling back to the real default dir would make a
// mis-invoked self-test scan the wrong tree and pass vacuously.
const dirFlagIndex = process.argv.indexOf("--dir")
if (dirFlagIndex !== -1 && !process.argv[dirFlagIndex + 1]) {
  console.error("web:leakcheck FAILED — --dir flag given without a value")
  process.exit(1)
}
const clientDir =
  dirFlagIndex !== -1
    ? process.argv[dirFlagIndex + 1]
    : join(__dirname, "..", "packages", "web", "dist", "client")
const assetsDir = join(clientDir, "assets")

// Server-only mechanisms + secret payload markers that must never reach the client.
const DENY = [
  "better-sqlite3",
  "napi-rs/keyring",
  "@junction/core",
  // Server-only libs reached via *.server.ts only (inc 28 probe/call): source-runtime +
  // the provider libs it lazy-imports + the openapi spec parser. They pull the native/core
  // chain and must never reach the client bundle. (inc-28 web review — harden the gate for
  // the new server-only chain, not just @junction/core.)
  "@junction/source-runtime",
  "@junction/mcp-client",
  "@junction/openapi-client",
  "@junction/graphql-client",
  "@scalar/openapi-parser",
  "CREATE TABLE",
  "drizzle",
  "secretRef",
  "secret_ref",
]
// A marker guaranteed in every route's client bundle. NOT `createFileRoute` —
// TanStack Start compiles that macro away (inc-23 false-positive); useLoaderData survives.
const POSITIVE = "useLoaderData"

function allFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...allFiles(p))
    else out.push(p)
  }
  return out
}

// 1. Existence guard.
try {
  if (!statSync(assetsDir).isDirectory() || readdirSync(assetsDir).length === 0) {
    console.error(`web:leakcheck FAILED — ${assetsDir} is empty (build did not emit client assets)`)
    process.exit(1)
  }
} catch {
  console.error(`web:leakcheck FAILED — ${assetsDir} missing (run the web build first)`)
  process.exit(1)
}

const files = allFiles(clientDir)
const text = files.map((f) => {
  try {
    return readFileSync(f, "utf8")
  } catch {
    return ""
  }
})
const joined = text.join("\n")

// 2. Negative check.
const leaks = []
for (const bad of DENY) {
  const hits = files.filter((_, i) => text[i].includes(bad))
  if (hits.length > 0)
    leaks.push(`${bad} → ${hits.map((f) => f.replace(clientDir, "dist/client")).join(", ")}`)
}
if (leaks.length > 0) {
  console.error("web:leakcheck FAILED — server-only/secret identifiers in client bundle:")
  for (const l of leaks) console.error(`  ✗ ${l}`)
  process.exit(1)
}

// 3. Positive control.
if (!joined.includes(POSITIVE)) {
  console.error(
    `web:leakcheck FAILED — positive control "${POSITIVE}" not found in client bundle.\n` +
      "The bundle is empty/corrupt or the marker changed — the scan may not have run.",
  )
  process.exit(1)
}

console.log(
  `web:leakcheck OK — ${files.length} client files scanned, no leaks, positive control present.`,
)
