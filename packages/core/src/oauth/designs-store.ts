// SPDX-License-Identifier: AGPL-3.0-only
// CustomOAuthDesignStore — persistence for user-authored `custom:<slug>` OAuth
// designs (increment 45, Slice A / Fable ruling D1).
//
// SHAPE: mirrors sources/tool-pins.ts EXACTLY (versioned JSON file at
// paths.oauthDesignsFile, home-locked via proper-lockfile, atomic 0600 write,
// re-read-under-lock-refuses-on-corruption) — see that file's header for the
// full rationale of each mechanical choice duplicated here.
//
// THE ONE DELIBERATE DIFFERENCE FROM tool-pins.ts (D1): tool-pins fails OPEN
// on load corruption (a broken pins file must never break tool listing — a
// UX-only degradation). This store fails CLOSED: `loadCustomDesigns` returns
// a TYPED ERROR on a corrupt/unparseable/wrong-version file, NEVER a silent
// empty set. A custom design's `tokenUrl` is where refresh tokens get POSTed
// — silently treating a corrupt designs file as "no custom designs" would
// make every credential bound to a `custom:*` design fail closed at the
// RESOLVER anyway (dangling-provider-reference), but the STORE itself must
// surface the corruption as a typed, diagnosable error rather than quietly
// participate in that failure by pretending the file was simply empty. A
// missing file (first run — no custom designs ever created) is the ONE
// legitimate "empty" case and returns `ok([])` with no error.
//
// NAMESPACE ENFORCEMENT AT LOAD (D3): the Zod schema's `id` regex
// (`^custom:[a-z0-9][a-z0-9-]*$`) is validated on every load, not just at
// create time. A hand-edited file smuggling `id: "github"` (or any non-
// `custom:`-prefixed id) fails the parse and surfaces as the SAME typed
// parse-failed error as any other corruption — it can never reach
// `mergeDesigns` and shadow a built-in.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { ResultAsync } from "neverthrow"
import { z } from "zod"
import { writeFile0600 } from "../credentials/vault-crypto.js"
import type { JunctionPaths } from "../paths/index.js"

// ---------------------------------------------------------------------------
// CustomOAuthDesign — the authorable subset of OAuthProvider
// ---------------------------------------------------------------------------

/**
 * The custom-id namespace (D3): `custom:` prefix + a lowercase-alnum-hyphen
 * slug. Structurally disjoint from every built-in catalog id (none of which
 * carry a `:`), so a custom design can NEVER collide with a built-in by
 * construction — `mergeDesigns`'s "built-ins always win" rule is belt-and-
 * suspenders on top of this, not the only guard.
 */
export const CUSTOM_OAUTH_DESIGN_ID_PATTERN = /^custom:[a-z0-9][a-z0-9-]*$/

/**
 * Zod schema for a user-authored OAuth design. Field types mirror
 * `OAuthProvider` (catalog.ts) exactly, MINUS the fields a human never
 * authors: `deviceAuthorizationUrl` (RFC 8628 device-code — not offered
 * through the authoring UI this increment) and `parseTokenResponse` /
 * `userinfoHeaders` (functions/maps aren't authorable via a form or an OIDC
 * discovery doc). A `CustomOAuthDesign` IS-A usable `OAuthProvider` field-for-
 * field on every field it declares — `mergeDesigns` (catalog.ts) uses it
 * directly as an `OAuthProvider`, no conversion step.
 */
export const CustomOAuthDesignSchema = z.object({
  id: z.string().regex(CUSTOM_OAUTH_DESIGN_ID_PATTERN),
  displayName: z.string().min(1),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopeSeparator: z.union([z.literal(" "), z.literal(","), z.literal("+")]),
  pkce: z.union([z.literal("S256"), z.literal("plain"), z.literal("disabled")]),
  supportsRefresh: z.boolean(),
  expiryStrategy: z.union([z.literal("expires_in"), z.literal("expires_at"), z.literal("none")]),
  redirectMode: z.union([z.literal("loopback-fixed"), z.literal("loopback-ephemeral")]),
  defaultScopes: z.array(z.string()).optional(),
  authorizationParams: z.record(z.string(), z.string()).optional(),
  userinfoUrl: z.string().url().optional(),
  registrationHint: z.object({
    redirectUri: z.string(),
    scopes: z.string(),
    docsUrl: z.string(),
  }),
})

export type CustomOAuthDesign = z.infer<typeof CustomOAuthDesignSchema>

// ---------------------------------------------------------------------------
// On-disk schema
// ---------------------------------------------------------------------------

const DesignsFileSchema = z.object({
  v: z.literal(1),
  designs: z.record(z.string(), CustomOAuthDesignSchema),
})

type DesignsFile = z.infer<typeof DesignsFileSchema>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DesignsStoreError =
  /**
   * D1 — fail CLOSED: the file is present but corrupt JSON, fails the Zod
   * schema (incl. a smuggled non-`custom:`-prefixed id, or a future/old
   * version literal), or a record's key disagrees with its own `id` field.
   */
  | { kind: "parse-failed"; cause?: unknown }
  /** Any other I/O failure reading a PRESENT file (permissions, etc). */
  | { kind: "read-failed"; cause: unknown }
  /** save(): the under-lock re-read hit corruption — the write is refused, bytes untouched (mirrors tool-pins' savePinFile). */
  | { kind: "refused-corrupt-file" }
  /** save(): the write itself failed (lock acquisition, disk, etc). */
  | { kind: "write-failed"; cause: unknown }

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

/**
 * Tags a read failure that is NOT a parse/schema problem (permission denied,
 * etc — ENOENT is handled separately, never reaches here). Distinguishing by
 * exception TYPE (this wrapper) rather than by inspecting the caught value's
 * shape after the fact keeps `loadCustomDesigns`'s error mapping a simple,
 * unambiguous instanceof check.
 */
class DesignsReadError extends Error {
  constructor(readonly cause: unknown) {
    super("oauth-designs.json: read failed")
  }
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse raw JSON text into a validated design list. Throws on invalid
 * JSON/schema (including a key/id mismatch) — callers convert to the typed
 * `parse-failed` error. Keeping the throw internal-only (never crossing a
 * Result boundary) mirrors tool-pins' `parsePinFile`.
 */
function parseDesignsFile(raw: string): CustomOAuthDesign[] {
  const parsed = DesignsFileSchema.parse(JSON.parse(raw) as unknown)
  return Object.entries(parsed.designs).map(([key, design]) => {
    // Defensive: the record key must agree with the design's own `id` — a
    // hand-edited file could otherwise smuggle a mismatched pair past the
    // per-value Zod check. Treat disagreement as corruption (fail closed).
    if (key !== design.id) {
      // nosemgrep: no-bare-throw-in-core -- category 3 (same-module try/catch conversion): thrown inside parseDesignsFile → readAndParse, caught + Result-converted by loadCustomDesigns's ResultAsync.fromPromise mapper (below). Never crosses the module boundary as a throw.
      throw new Error(`oauth-designs.json: key "${key}" does not match design id "${design.id}"`)
    }
    return design
  })
}

function serializeDesigns(designs: CustomOAuthDesign[]): string {
  const entries: DesignsFile["designs"] = {}
  for (const design of designs) entries[design.id] = design
  return JSON.stringify({ v: 1, designs: entries } satisfies DesignsFile, null, 2)
}

/**
 * Load + parse the file. ENOENT resolves to an empty array (the one
 * legitimate "no custom designs" case — handled HERE, inside the async
 * function, so callers built on `ResultAsync.fromPromise` never have to
 * distinguish "rejected with ENOENT" from "rejected with real corruption"
 * after the fact). Any other failure (read error, JSON.parse, Zod, or the
 * key/id-mismatch check in `parseDesignsFile`) propagates as a rejection —
 * `loadCustomDesigns` below maps that rejection to the typed fail-closed
 * error.
 */
async function readAndParse(oauthDesignsFile: string): Promise<CustomOAuthDesign[]> {
  let raw: string
  try {
    raw = await readFile(oauthDesignsFile, "utf-8")
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return []
    // nosemgrep: no-bare-throw-in-core -- category 3 (same-module try/catch conversion): distinguishes a real read error from ENOENT inside readAndParse; caught + Result-converted by loadCustomDesigns's ResultAsync.fromPromise mapper. Never crosses the module boundary.
    throw new DesignsReadError(cause)
  }
  return parseDesignsFile(raw)
}

// ---------------------------------------------------------------------------
// loadCustomDesigns
// ---------------------------------------------------------------------------

/**
 * Load all custom OAuth designs. FAILS CLOSED (D1 — the deliberate
 * difference from tool-pins):
 *   - Missing file (ENOENT — first run, no custom designs ever created) →
 *     `ok([])`, no error. This is the ONLY empty-without-error case.
 *   - Present-but-corrupt/unparseable/wrong-schema file → `err({kind:
 *     "parse-failed"})`. NEVER a silent `ok([])` — a caller that swallowed
 *     this into an empty set would be indistinguishable from "no custom
 *     designs exist," masking real corruption of a file whose `tokenUrl`
 *     fields are a refresh-token exfiltration surface.
 *   - Other I/O failure on a present file → `err({kind: "read-failed"})`.
 */
export function loadCustomDesigns(
  paths: JunctionPaths,
): ResultAsync<CustomOAuthDesign[], DesignsStoreError> {
  return ResultAsync.fromPromise(
    readAndParse(paths.oauthDesignsFile),
    (cause): DesignsStoreError => {
      // DesignsReadError = an I/O failure OTHER than ENOENT (which
      // readAndParse already resolved to `[]`, never a rejection) — e.g.
      // permission denied. Anything else (JSON.parse SyntaxError, Zod
      // validation, our own key/id-mismatch Error) means the file is
      // PRESENT but unusable → fail closed as parse-failed, never silently
      // empty (D1 — the whole point of this store).
      if (cause instanceof DesignsReadError) return { kind: "read-failed", cause: cause.cause }
      return { kind: "parse-failed", cause }
    },
  )
}

// ---------------------------------------------------------------------------
// saveCustomDesigns
// ---------------------------------------------------------------------------

/**
 * Persist the full custom-design list, home-locked + atomic (mirrors
 * tool-pins' `savePinFile`): acquires a lock on `paths.home`, RE-READS the
 * on-disk file under that lock (never trusting a caller's stale snapshot —
 * guards against a concurrent process's own save), and REFUSES the write
 * (`{kind: "refused-corrupt-file"}`, bytes untouched) if that re-read hits
 * corruption — never clobber a file we couldn't parse.
 *
 * Slice A only needs this primitive to EXIST (Slice D's add/delete are the
 * first real callers) — see the method file.
 */
export function saveCustomDesigns(
  paths: JunctionPaths,
  designs: CustomOAuthDesign[],
): ResultAsync<void, DesignsStoreError> {
  return ResultAsync.fromPromise(doSave(paths, designs), (cause): DesignsStoreError => {
    if (cause instanceof RefusedError) return { kind: "refused-corrupt-file" }
    return { kind: "write-failed", cause }
  })
}

class RefusedError extends Error {}

async function doSave(paths: JunctionPaths, designs: CustomOAuthDesign[]): Promise<void> {
  const { lock } = await import("proper-lockfile")
  const lockfilePath = path.join(paths.home, ".oauth-designs.lock")
  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(paths.home, { lockfilePath })

    // Re-read under the lock — refuse to overwrite a file we can't parse.
    // readAndParse already resolves ENOENT to `[]` (fine to proceed over —
    // first write), so ANY rejection here means real corruption.
    try {
      await readAndParse(paths.oauthDesignsFile)
    } catch {
      // nosemgrep: no-bare-throw-in-core -- category 3 (same-module try/catch conversion): thrown inside doSave, caught + Result-converted by saveCustomDesigns's ResultAsync.fromPromise mapper. Never crosses the module boundary as a throw.
      throw new RefusedError("oauth-designs.json: refusing to overwrite an unparseable file")
    }

    await writeFile0600(paths.oauthDesignsFile, Buffer.from(serializeDesigns(designs), "utf-8"))
  } finally {
    if (release) await release().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// parseCustomOAuthDesign — single-object validation (Slice D's create path)
// ---------------------------------------------------------------------------

/** Validate a single design object without going through the file store (Slice D's create-time validation reuses this). */
export function parseCustomOAuthDesign(
  value: unknown,
): { ok: true; design: CustomOAuthDesign } | { ok: false; error: DesignsStoreError } {
  const parsed = CustomOAuthDesignSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, error: { kind: "parse-failed", cause: parsed.error } }
  }
  return { ok: true, design: parsed.data }
}
