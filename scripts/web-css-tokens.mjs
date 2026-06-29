// SPDX-License-Identifier: AGPL-3.0-only
// CSS custom-property definition gate — tokens-only rule enforcement.
// Shared by `pnpm verify:web` (local loop) and the CI web-build job.
//
// Checks that every `var(--token)` reference in web/src components is actually
// DEFINED somewhere in app.css. CSS custom-props fall back SILENTLY (rendering
// wrong with zero console output), so a build-time gate is the only reliable guard.
// Background: --alpha-300/--radius-8 escaped undetected in inc 24.6 before this gate.
//
// Three-part check (green-but-blind defence — per docs/behaviours/verify-the-artifact.md):
//   1. Parse-guard: app.css must exist, define >0 tokens, and we must scan >0 source files.
//   2. Negative: every var(--x) ref in src/**/*.{ts,tsx,css} (excl. app.css) must be in
//      the defined set OR in the documented allowlist (Radix runtime-injected vars).
//   3. Positive control: a known-good token (--gray-1000) must be in the defined set AND
//      be referenced, proving the scan hit real content.

import { readdirSync, readFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const webSrc = join(__dirname, "..", "packages", "web", "src")
const appCss = join(webSrc, "styles", "app.css")

// Allowlist: vars injected at runtime by third-party libraries (NOT in app.css).
// Keep this tight — add a comment justifying each entry.
const RUNTIME_ALLOWLIST = new Set([
  // Radix UI Select injects these on the trigger element for popover positioning.
  "--radix-select-trigger-height",
  "--radix-select-trigger-width",
])

// ── 1. Parse-guard ────────────────────────────────────────────────────────────

// Read app.css.
let cssText
try {
  cssText = readFileSync(appCss, "utf8")
} catch {
  console.error(`web:css-tokens FAILED — app.css not found at ${appCss}`)
  process.exit(1)
}

// Collect all defined custom properties: any `--name:` declaration anywhere in app.css.
// Matches both `:root { --x: y }` and `.dashboard-grid { ... }` and @media blocks.
const definedTokens = new Set()
for (const m of cssText.matchAll(/--([A-Za-z0-9-]+)\s*:/g)) {
  definedTokens.add(`--${m[1]}`)
}

if (definedTokens.size === 0) {
  console.error("web:css-tokens FAILED — parse-guard: no custom properties found in app.css")
  process.exit(1)
}

// ── 2. Collect source files ───────────────────────────────────────────────────

function allFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...allFiles(p))
    } else {
      const ext = extname(e.name)
      if (ext === ".ts" || ext === ".tsx" || ext === ".css") {
        out.push(p)
      }
    }
  }
  return out
}

// All .ts/.tsx/.css under web/src, excluding app.css itself.
const sourceFiles = allFiles(webSrc).filter((f) => f !== appCss)

if (sourceFiles.length === 0) {
  console.error("web:css-tokens FAILED — parse-guard: no source files found under web/src")
  process.exit(1)
}

// ── 3. Scan for var(--x) references ──────────────────────────────────────────

// Map: token → list of files that reference it.
/** @type {Map<string, string[]>} */
const refs = new Map()

for (const file of sourceFiles) {
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    continue
  }
  for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
    const tok = m[1]
    if (!refs.has(tok)) refs.set(tok, [])
    refs.get(tok).push(file.replace(`${webSrc}/`, ""))
  }
}

// ── 4. Negative check ─────────────────────────────────────────────────────────

const missing = []
for (const [tok, files] of refs) {
  if (definedTokens.has(tok)) continue // defined in app.css
  if (RUNTIME_ALLOWLIST.has(tok)) continue // runtime-injected, documented allowlist
  missing.push({ tok, files: [...new Set(files)] })
}

if (missing.length > 0) {
  console.error("web:css-tokens FAILED — var() references to undefined custom properties detected:")
  for (const { tok, files } of missing) {
    console.error(`  ✗ ${tok}`)
    for (const f of files) console.error(`      ${f}`)
  }
  console.error(
    "\nFix: define the token in packages/web/src/styles/app.css, or add to RUNTIME_ALLOWLIST",
    "\nif it is injected at runtime by a third-party library (document the reason).",
  )
  process.exit(1)
}

// ── 5. Positive control ───────────────────────────────────────────────────────

const POSITIVE = "--gray-1000"
if (!definedTokens.has(POSITIVE)) {
  console.error(
    `web:css-tokens FAILED — positive control token "${POSITIVE}" not found in app.css.\n` +
      "The CSS parser may have failed or app.css structure changed — review the script.",
  )
  process.exit(1)
}
if (!refs.has(POSITIVE)) {
  console.error(
    `web:css-tokens FAILED — positive control token "${POSITIVE}" is defined but not ` +
      "referenced in any source file. The file scanner may not have run correctly.",
  )
  process.exit(1)
}

console.log(
  `web:css-tokens OK — ${definedTokens.size} tokens defined, ${sourceFiles.length} files scanned,` +
    ` ${refs.size} unique var() refs, all resolve.`,
)
