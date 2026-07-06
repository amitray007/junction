#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Codegen: per-app catalog.json/help.json/tools/*.json -> committed
// catalog.generated.ts (increment 30.8).
//
// WHY this exists: core must ship the App catalog as validated in-memory data
// with NO runtime `fs` (packages/core/src is hard-blocked from readFileSync by
// .claude/hooks/boundary-guard.mjs — see docs/methods/30.8-app-catalog-schema.md
// §2a). So the catalog is AUTHORED as per-app JSON (human- + importer-writable)
// and COMPILED here, at build/authoring time, into a plain TS module of
// validated object literals that core's index.ts imports like any other
// in-repo data. Mirrors packages/web/scripts/gen-brand-icons.mjs's shape
// (authored data -> generator script -> committed generated file, run
// manually via a package.json script, NOT wired into the bundler).
//
// FAIL LOUD: throws (non-zero exit) if any catalog.json is missing a required
// field, fails AppCatalogEntrySchema.parse, or an app id is fs-unsafe /
// case-insensitively duplicate — a bad catalog entry is a build-time error,
// never a silent skip.
//
// Run: `pnpm --filter @junction/core gen:catalog` (re-run after adding/editing
// a catalog/<id>/*.json; NOT wired into `tsdown build` — the output is a
// pinned, committed snapshot, not a build artifact).

import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE_ROOT = join(__dirname, "..")
// CATALOG_DIR is overridable via GEN_CATALOG_DIR so a test can point the
// generator at a scratch fixture tree (e.g. to prove the orphan-tools-file
// guard fails loud) without mutating the real, committed catalog/ dir.
const CATALOG_DIR = process.env.GEN_CATALOG_DIR ?? join(CORE_ROOT, "src", "apps", "catalog")
const OUT_PATH = join(CATALOG_DIR, "catalog.generated.ts")

// ─── 1. Load the schema (from the built dist — plain `node` can't load raw
// .ts with relative .js specifiers without a loader) ───────────────────────
// This generator lives outside packages/core/src (the boundary-guard hook
// blocks `fs` reads from a core src file) — but it still needs
// AppCatalogEntrySchema to validate against. Requires `pnpm --filter
// @junction/core build` to have run first (mirrors gen-brand-icons.mjs,
// which also imports the built @junction/core rather than its source).
let AppCatalogEntrySchema
try {
  ;({ AppCatalogEntrySchema } = await import(join(CORE_ROOT, "dist", "index.js")))
} catch (err) {
  throw new Error(
    `gen-catalog: could not import dist/index.js (${err.message}) — run ` +
      "`pnpm --filter @junction/core build` first so AppCatalogEntrySchema is available.",
  )
}

if (typeof AppCatalogEntrySchema?.safeParse !== "function") {
  throw new Error(
    "gen-catalog: dist/index.js loaded but has no AppCatalogEntrySchema export — " +
      "is it exported from packages/core/src/index.ts?",
  )
}

// ─── 2. Discover per-app directories ────────────────────────────────────────

function readJsonIfExists(path) {
  try {
    const raw = readFileSync(path, "utf8")
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === "ENOENT") return undefined
    throw new Error(`gen-catalog: failed to parse JSON at ${path}: ${err.message}`)
  }
}

/** fs-safe, case-insensitively-unique id guard (method file §4, M1). */
const FS_SAFE_ID = /^[a-z0-9][a-z0-9-]*$/

const appDirs = readdirSync(CATALOG_DIR).filter((name) => {
  const full = join(CATALOG_DIR, name)
  return statSync(full).isDirectory()
})

if (appDirs.length === 0) {
  throw new Error(
    `gen-catalog: no app directories found under ${CATALOG_DIR} — nothing to generate`,
  )
}

const seenLowerIds = new Map() // lowercased id -> original dir name(s)
const entries = []

for (const dirName of appDirs.sort()) {
  const appDir = join(CATALOG_DIR, dirName)
  const catalogJsonPath = join(appDir, "catalog.json")
  const catalogJson = readJsonIfExists(catalogJsonPath)
  if (catalogJson === undefined) {
    throw new Error(
      `gen-catalog: ${dirName}/catalog.json is missing — every catalog/<id>/ dir must have one`,
    )
  }

  // fs-safe + case-insensitive uniqueness guard, checked against the DIRECTORY
  // name (the fs-visible identity) — macOS/Windows fold case, so "github" and
  // "GitHub" would collide on disk even though today's ids are simple slugs.
  if (!FS_SAFE_ID.test(dirName)) {
    throw new Error(
      `gen-catalog: app directory "${dirName}" is not fs-safe (must match ${FS_SAFE_ID}) — ` +
        "rename the directory to a plain lowercase slug",
    )
  }
  const lower = dirName.toLowerCase()
  if (seenLowerIds.has(lower)) {
    throw new Error(
      `gen-catalog: case-insensitive id collision between "${seenLowerIds.get(lower)}" and ` +
        `"${dirName}" — app directory names must be unique even case-insensitively ` +
        "(macOS/Windows fold case)",
    )
  }
  seenLowerIds.set(lower, dirName)

  if (catalogJson.id !== dirName) {
    throw new Error(
      `gen-catalog: ${dirName}/catalog.json has id "${catalogJson.id}" — the JSON "id" field ` +
        "must match its containing directory name exactly",
    )
  }

  // help.json merge precedence: help.json wins per-field (shallow field-merge)
  // over an inline `help` in catalog.json, if both are present (method file §4).
  const helpJson = readJsonIfExists(join(appDir, "help.json"))
  let help = catalogJson.help
  if (helpJson !== undefined) {
    help = { ...(catalogJson.help ?? {}), ...helpJson }
  }

  // tools/*.tools.json: merged into the matching surface's starterTools by
  // surface kind (e.g. tools/http.tools.json -> the "http" surface).
  const toolsDir = join(appDir, "tools")
  let surfaces = catalogJson.surfaces
  let toolFiles = []
  try {
    toolFiles = readdirSync(toolsDir)
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }
  if (toolFiles.length > 0) {
    const matchedToolFiles = new Set()
    if (Array.isArray(surfaces)) {
      surfaces = surfaces.map((surface) => {
        const toolFile = toolFiles.find((f) => f === `${surface.kind}.tools.json`)
        if (!toolFile) return surface
        matchedToolFiles.add(toolFile)
        const starterTools = readJsonIfExists(join(toolsDir, toolFile))
        return { ...surface, starterTools }
      })
    }
    // FAIL LOUD (not a silent skip): a tools/*.tools.json whose kind matches NO
    // surface (typo'd filename, renamed/removed surface) would otherwise be
    // silently dropped — the generator would exit 0 with the intended starter
    // tools simply missing. Every tools/*.tools.json file MUST match exactly
    // one surface.
    const unmatched = toolFiles.filter((f) => !matchedToolFiles.has(f))
    if (unmatched.length > 0) {
      throw new Error(
        `gen-catalog: ${dirName}/tools/${unmatched[0]} does not match any surface's kind ` +
          `(expected a surface with kind "${unmatched[0].replace(/\.tools\.json$/, "")}") — ` +
          "rename the file or add the matching surface; a tools file must never be silently dropped",
      )
    }
  }

  const candidate = { ...catalogJson, ...(surfaces ? { surfaces } : {}), ...(help ? { help } : {}) }

  const parsed = AppCatalogEntrySchema.safeParse(candidate)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`gen-catalog: ${dirName}/catalog.json failed AppCatalogEntrySchema:\n${issues}`)
  }

  entries.push(parsed.data)
}

// ─── 3. Emit catalog.generated.ts ───────────────────────────────────────────

const header = `// SPDX-License-Identifier: AGPL-3.0-only
// AUTO-GENERATED by packages/core/scripts/gen-catalog.mjs — DO NOT EDIT BY HAND.
// Regenerate with \`pnpm --filter @junction/core gen:catalog\` after adding or
// editing a catalog/<id>/{catalog.json,help.json,tools/*.json} entry.
//
// This is a PINNED, COMMITTED snapshot (increment 30.8 — see
// docs/methods/30.8-app-catalog-schema.md §2a): every entry below was
// validated against AppCatalogEntrySchema at codegen time. index.ts
// re-validates at module load as a belt-and-suspenders check — this file
// carries zero runtime \`fs\`, so core stays embeddable.

import type { AppCatalogEntry } from "../catalog-schema.js"

export const CATALOG_ENTRIES: readonly AppCatalogEntry[] = ${JSON.stringify(entries, null, 2)}
`

writeFileSync(OUT_PATH, header, "utf8")

// Format with the project's own formatter (Biome) so the committed output
// matches `pnpm verify`'s formatting gate.
try {
  execFileSync("pnpm", ["exec", "biome", "format", "--write", OUT_PATH], {
    cwd: CORE_ROOT,
    stdio: "inherit",
  })
} catch (err) {
  throw new Error(`gen-catalog: biome format --write failed on the generated file: ${err.message}`)
}

console.log(`gen-catalog: wrote ${entries.length} app(s) -> ${OUT_PATH}`)
