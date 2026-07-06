#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// DEV-TIME ONLY: integrations.sh -> draft junction App catalog entry
// (increment 30.9). Mirrors gen-catalog.mjs's shape: a .mjs OUTSIDE src/ so it
// may use fetch/fs freely (packages/core/src is hard-blocked from fs by
// .claude/hooks/boundary-guard.mjs). NO runtime code imports this file, it is
// never bundled into dist, and integrations.sh is never a product dependency
// — this is a maintainer's authoring accelerator, off the runtime path.
//
// It fetches GET https://integrations.sh/api/{domain}/surface (a plain,
// unauthenticated, deterministic cached read — verified 2026-07-06) and NEVER
// /discover (that fires their LLM live — banned, see docs/methods/
// 30.9-integrations-importer.md §0). It maps the payload to a DRAFT
// AppCatalogEntry (catalog.json + help.json) shaped to validate against
// AppCatalogEntrySchema (packages/core/src/apps/catalog-schema.ts), and
// writes it to a STAGING dir ONLY — never into src/apps/catalog/ (§3c: all 45
// app dirs already exist; the importer must never clobber a hand-authored
// entry). A maintainer reviews, edits, fills REVIEW:* placeholders, and moves
// the result into the live catalog by hand.
//
// Run: `pnpm --filter @junction/core import:app <domain>`
// e.g. `pnpm --filter @junction/core import:app github.com`

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  basisToFact,
  credentialToAppAuth,
  dedupAppAuth,
  hasNoMappableSurfaces,
  mapAuthSetup,
  mapInstallCommands,
  mapSurface,
  proposeAppId,
  proposeDisplayName,
} from "./import-from-integrations.mapping.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE_ROOT = join(__dirname, "..")
const STAGING_ROOT = join(__dirname, ".import-staging")
const LIVE_CATALOG_ROOT = join(CORE_ROOT, "src", "apps", "catalog")

const SURFACE_ENDPOINT = (domain) =>
  `https://integrations.sh/api/${encodeURIComponent(domain)}/surface`

// ─── 1. CLI arg + fail-loud guard against /discover misuse ─────────────────
// Kept inside a function (not top-level) so importing this module for its
// `buildDraft` export (tests, the REPL smoke-check above) never trips
// process.argv parsing or process.exit — only running it as a script does.

function readDomainArg() {
  const domain = process.argv[2]
  if (!domain) {
    console.error("usage: node scripts/import-from-integrations.mjs <domain>")
    console.error("example: node scripts/import-from-integrations.mjs github.com")
    process.exit(1)
  }
  if (domain.includes("/discover")) {
    throw new Error(
      "import-from-integrations: refusing a domain containing '/discover' — this importer " +
        "ONLY ever calls /api/{domain}/surface (deterministic cached read), NEVER /discover " +
        "(fires integrations.sh's LLM live). Pass a bare domain, e.g. 'github.com'.",
    )
  }
  return domain
}

// ─── 2. Fetch — plain GET, no auth. Fail loud on non-200/non-JSON. ─────────

async function fetchSurface(domainToFetch) {
  const url = SURFACE_ENDPOINT(domainToFetch)
  let res
  try {
    res = await fetch(url)
  } catch (err) {
    throw new Error(
      `import-from-integrations: network error fetching ${url}: ${err.message} — ` +
        "a service problem; retry later.",
    )
  }
  if (res.status === 404) {
    throw new Error(
      `import-from-integrations: integrations.sh has no surface for "${domainToFetch}" (404) — ` +
        "this is EXPECTED for many apps, not a bug. Author the catalog entry from scratch instead.",
    )
  }
  if (!res.ok) {
    throw new Error(
      `import-from-integrations: ${url} returned HTTP ${res.status} — a service problem, retry later.`,
    )
  }
  let payload
  try {
    payload = await res.json()
  } catch (err) {
    throw new Error(`import-from-integrations: ${url} did not return valid JSON: ${err.message}`)
  }
  return payload
}

// ─── 3. Map payload -> draft catalog entry + review artifact ───────────────

/**
 * The core transform (exported for tests that want to run the full pipeline
 * against a fixture payload without touching fs/network). Pure given `payload`.
 */
export function buildDraft(payload) {
  const id = proposeAppId(payload.domain)
  const displayName = proposeDisplayName(payload)
  const credentialsById = payload.credentials ?? {}

  const facts = []
  const placeholders = []
  const reviewNotes = []
  const surfaces = []
  const allAuthModes = []
  let detectedCount = 0
  let discoveredCount = 0

  const rawSurfaces = payload.surfaces ?? []
  const mappedResults = rawSurfaces.map((s) => mapSurface(s, credentialsById))

  rawSurfaces.forEach((rawSurface, i) => {
    const result = mappedResults[i]
    const path = `surfaces[${i}]`

    // basis + facts (trust tagging, §3a) — record for the surface itself and
    // for each auth entry's basis, regardless of whether the surface mapped.
    const surfaceFact = basisToFact(`${path}.basis`, rawSurface.basis)
    facts.push(surfaceFact)
    if (surfaceFact.via === "detected") detectedCount++
    else discoveredCount++
    for (const entry of rawSurface.auth?.entries ?? []) {
      const authFact = basisToFact(`${path}.auth`, entry.basis)
      facts.push(authFact)
      if (authFact.via === "detected") detectedCount++
      else discoveredCount++
    }

    if (result.skip) {
      reviewNotes.push(`[REVIEW] ${path} (type "${rawSurface.type}") skipped: ${result.skip}`)
      return
    }

    if (result.andComposed.length > 0) {
      for (const ids of result.andComposed) {
        reviewNotes.push(
          `[REVIEW] ${path}: AND-composed auth (${ids.join(" + ")} all required) — junction ` +
            "models accepted auth modes as a DISJUNCTION, not a conjunction. Confirm this is " +
            "actually required-together, not alternative options.",
        )
      }
    }

    // oauth2 REVIEW:providerId placeholders — one per distinct oauth2
    // credential. The placeholder is now "REVIEW:providerId:<credentialId>"
    // (credentialToAppAuth, §2g M2 fix) rather than one bare literal, so
    // match the PREFIX, not an exact string — every oauth2 providerId the
    // importer ever emits starts with "REVIEW:providerId" regardless of
    // which distinct credential it came from.
    result.surface.auth.forEach((auth, authIdx) => {
      if (auth.mode === "oauth2" && auth.providerId?.startsWith("REVIEW:providerId")) {
        placeholders.push({
          path: `${path}.auth[${authIdx}].providerId`,
          token: auth.providerId,
          reason:
            "oauth2 providerId must reference an oauth/catalog.ts provider id — never guessed.",
        })
      }
    })

    surfaces.push(result.surface)
    allAuthModes.push(...result.surface.auth)
  })

  if (hasNoMappableSurfaces(mappedResults) && rawSurfaces.length > 0) {
    reviewNotes.unshift(
      "[REVIEW] no surfaces mapped — every raw surface was skipped. Author surfaces manually.",
    )
  }
  if (rawSurfaces.length === 0) {
    reviewNotes.unshift("[REVIEW] payload has zero surfaces — author surfaces manually.")
  }

  // App-level auth[] = union of all mapped credential types (§2b), PLUS any
  // credential never referenced by a mapped surface (still worth flagging).
  // credentialToAppAuth (credential-id-aware, not the bare type-only form) —
  // keeps distinct oauth2 credentials distinguishable here too, so a payload
  // with two oauth2 creds doesn't collapse to one at the app level either
  // (§2g M2, the vacuity a review caught).
  const appLevelAuthFromCreds = Object.entries(credentialsById)
    .map(([credId, c]) => credentialToAppAuth(credId, c))
    .filter((a) => a !== undefined)
  const auth = dedupAppAuth([...allAuthModes, ...appLevelAuthFromCreds])
  const finalAuth = auth.length > 0 ? auth : [{ mode: "none" }]

  const supportedKinds = [...new Set(surfaces.map((s) => s.kind))]

  const cliSurfaceRaw = rawSurfaces.find((s) => s.type === "cli")
  const { commands: installCommands, unmapped: unmappedRegistries } = mapInstallCommands(
    cliSurfaceRaw,
    id,
  )
  if (unmappedRegistries.length > 0) {
    reviewNotes.push(
      `[REVIEW] cli package registryType(s) not mapped to an install command: ${unmappedRegistries.join(", ")}.`,
    )
  }
  const authSetup = mapAuthSetup(cliSurfaceRaw)

  const oauth2Cred = Object.entries(credentialsById).find(([, c]) => c.type === "oauth2")
  const oauthApp = oauth2Cred?.[1]?.generateUrl
    ? { registerUrl: oauth2Cred[1].generateUrl }
    : undefined

  const catalogEntry = {
    id,
    displayName,
    supportedKinds,
    auth: finalAuth,
    ...(surfaces.length > 0 ? { surfaces } : {}),
  }

  const help = {
    description: payload.description,
    provenance: {
      authoredBy: "junction-importer",
      researchedFrom: ["integrations.sh", payload.domain],
      lastReviewed: "REVIEW:lastReviewed",
    },
    ...(Object.keys(installCommands).length > 0
      ? {
          install: {
            commands: installCommands,
            verifyCmd: "REVIEW:verifyCmd",
            minVersion: "REVIEW:minVersion",
          },
        }
      : {}),
    ...(authSetup ? { authSetup } : {}),
    ...(oauthApp ? { oauthApp } : {}),
  }

  const review = {
    app: id,
    domain: payload.domain,
    usedLlm: payload.usedLlm ?? true,
    facts,
    placeholders,
    counts: {
      detected: detectedCount,
      discovered: discoveredCount,
      placeholders: placeholders.length,
    },
    notes: reviewNotes,
  }

  return { id, catalogEntry, help, review }
}

// ─── 4. Staging write + collision report (§3c/§3d) ─────────────────────────

function fsSafeId(id) {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/**
 * Best-effort AppCatalogEntrySchema.safeParse on the draft, for immediate
 * QA-ability (a review caught that `main()` wrote the draft without ever
 * running it through the schema — only the test suite did, so a shape drift
 * in integrations.sh's payload, or an unexpected empty `surfaces[]` (e.g.
 * every raw surface got url-less-skipped), could silently ship a
 * STRUCTURALLY invalid catalog.json that only surfaces much later, at
 * `gen:catalog` time or worse). Returns a structured result — the caller
 * writes it into `_import-review.json` (a PERSISTENT record, not just a
 * console line that scrolls away) — and never throws: a raw draft is
 * INTENTIONALLY schema-invalid while REVIEW:* placeholders are unfilled
 * (§3b), so an unfilled-placeholder failure is expected, not fatal. Soft-
 * imports dist/index.js (same as gen-catalog.mjs) and reports "skipped" if
 * the build hasn't run yet — the importer must still work standalone,
 * without forcing a core build.
 */
async function checkSchemaShape(catalogEntry) {
  let AppCatalogEntrySchema
  try {
    ;({ AppCatalogEntrySchema } = await import(join(CORE_ROOT, "dist", "index.js")))
  } catch {
    return {
      status: "skipped",
      reason: "run `pnpm --filter @junction/core build` to enable this check",
    }
  }
  if (typeof AppCatalogEntrySchema?.safeParse !== "function") {
    return { status: "skipped", reason: "dist/index.js has no AppCatalogEntrySchema export" }
  }

  const result = AppCatalogEntrySchema.safeParse(catalogEntry)
  if (result.success) {
    return { status: "ok" }
  }
  return {
    status: "invalid",
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  }
}

function detectCollision(id) {
  const liveDir = join(LIVE_CATALOG_ROOT, id)
  let exists = false
  try {
    exists = statSync(liveDir).isDirectory()
  } catch {
    exists = false
  }
  if (!exists) return { exists: false, hasSurfaces: false, hasHelpJson: false }

  let hasSurfaces = false
  try {
    const catalogJson = JSON.parse(readFileSync(join(liveDir, "catalog.json"), "utf8"))
    hasSurfaces = Array.isArray(catalogJson.surfaces) && catalogJson.surfaces.length > 0
  } catch {
    // no catalog.json or unparsable — treat as no surfaces
  }
  const hasHelpJson = existsSync(join(liveDir, "help.json"))
  return { exists: true, hasSurfaces, hasHelpJson }
}

async function main() {
  const domain = readDomainArg()
  const payload = await fetchSurface(domain)
  const { id, catalogEntry, help, review } = buildDraft(payload)

  if (!fsSafeId(id)) {
    throw new Error(
      `import-from-integrations: proposed id "${id}" (from domain "${domain}") is not fs-safe ` +
        "(must match ^[a-z0-9][a-z0-9-]*$) — supply a corrected id by hand when authoring the entry.",
    )
  }

  const collision = detectCollision(id)
  review.collision = collision
  if (collision.exists) {
    review.notes.unshift(
      `[REVIEW] app "${id}" already exists in the live catalog (packages/core/src/apps/catalog/${id}/) ` +
        `— hasSurfaces=${collision.hasSurfaces} hasHelpJson=${collision.hasHelpJson}. This draft is a ` +
        "RE-DRAFT for the reviewer to 3-way-merge by hand. Do NOT overwrite the authored entry.",
    )
  }

  // Schema-shape check (§4 fix-4/6, upgraded to HIGH by a deeper review: a
  // structural bug — e.g. every raw surface skipped, leaving an empty
  // surfaces[] — could otherwise ship silently). Computed BEFORE the write so
  // its result lands in the PERSISTENT _import-review.json, not just a
  // console line that scrolls away.
  const schemaCheck = await checkSchemaShape(catalogEntry)
  review.schemaCheck = schemaCheck

  // Idempotent re-run: wipe this app's staging dir before writing (§3d).
  const outDir = join(STAGING_ROOT, id)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  writeFileSync(join(outDir, "catalog.json"), `${JSON.stringify(catalogEntry, null, 2)}\n`, "utf8")
  writeFileSync(join(outDir, "help.json"), `${JSON.stringify(help, null, 2)}\n`, "utf8")
  writeFileSync(join(outDir, "_import-review.json"), `${JSON.stringify(review, null, 2)}\n`, "utf8")

  console.log(`import-from-integrations: wrote draft for "${id}" -> ${outDir}`)
  console.log(
    `  facts: ${review.counts.detected} detected, ${review.counts.discovered} discovered, ` +
      `${review.counts.placeholders} placeholder(s) to resolve`,
  )
  if (collision.exists) {
    console.log(`  COLLISION: "${id}" already exists in the live catalog — this is a re-draft.`)
  }
  if (review.notes.length > 0) {
    console.log("  review notes:")
    for (const note of review.notes) console.log(`    - ${note}`)
  }

  if (schemaCheck.status === "ok") {
    console.log("  schema check: OK (validates against AppCatalogEntrySchema as-is)")
  } else if (schemaCheck.status === "skipped") {
    console.log(`  schema check: skipped (${schemaCheck.reason})`)
  } else {
    console.log(
      "  schema check: draft does NOT validate yet (expected while REVIEW:* placeholders are unfilled):",
    )
    for (const issue of schemaCheck.issues) {
      console.log(`    - ${issue.path}: ${issue.message}`)
    }
  }
}

// Only run when invoked directly (not when imported by a test for buildDraft).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
