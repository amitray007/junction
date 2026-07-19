// SPDX-License-Identifier: AGPL-3.0-only
// deriveCredentialName — the SAME deterministic derivation rule migration
// 0011's backfill uses (docs/methods/42-credentials-standalone.md "BINDING
// identity model"), reused by every credential-CREATE path that doesn't take
// a user-supplied `name` today: OAuth connect (oauth-connect.ts), catalog
// connect (connect-from-catalog.ts), and the legacy CLI `credential add
// --account` (no `--name`). Keeps those paths' BEHAVIOR unchanged — they just
// gain a derived name instead of requiring one from the caller.
//
// Increment 46 (Fable RA) — the 2nd param is a name-derivation SEED, not a
// stored field: `profileName` is gone; a real account string (e.g. the OAuth
// connect flow's provider username) still feeds this seed, its meaning
// landing entirely in the derived `name` — nothing lost.
//
// Pure function — no I/O, no DB query. Callers resolve the "existing names"
// set themselves (typically via `repos.credentials.list()`), matching the
// migration's collision rule: `<platformId>-<label>`, `-2`/`-3` suffixed on
// collision.

import { CredentialNameSchema } from "../schema/credential.js"

/**
 * Lowercase + strip characters CredentialNameSchema's slug regex
 * (`^[a-z0-9][a-z0-9-]*$`) rejects, so a platformId/label containing
 * uppercase or other punctuation still derives a valid slug rather than
 * throwing downstream at CredentialSchema.parse. Collapses runs of stripped
 * characters to a single hyphen (never a double hyphen from two adjacent
 * invalid chars) and trims a leading hyphen (the schema requires the first
 * char be alphanumeric).
 */
function slugifyPart(part: string): string {
  const lowered = part.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return lowered.replace(/^-+/, "").replace(/-+$/, "")
}

/**
 * Derive a deterministic credential name from `<platformId>-<label>`,
 * suffixed `-2`, `-3`, … on collision against `existingNames`. Mirrors
 * migration 0011's backfill rule exactly (ROW_NUMBER()-ordered by id there;
 * here the caller controls ordering by calling this once per new credential
 * against the CURRENT existing-names set, which is the live equivalent).
 *
 * The returned name is always a valid CredentialNameSchema slug — a
 * malformed platformId/label is slugified first (see slugifyPart), so this
 * function never throws.
 */
export function deriveCredentialName(
  platformId: string,
  label: string,
  existingNames: ReadonlySet<string>,
): string {
  const base = `${slugifyPart(platformId)}-${slugifyPart(label)}`
  const slugged = CredentialNameSchema.safeParse(base).success ? base : slugifyPart(base)
  // Empty-slug guard (data-migration review, LOW): if BOTH parts slugify to
  // nothing (e.g. platformId="*" + label="*" → base "-" → ""), fall back
  // to a valid literal so this never returns a name CredentialNameSchema would
  // reject. The collision loop below then uniquifies it. (The migration's
  // parallel path uses lower(id); this pure fn has no id, so "credential" is
  // the neutral default — the caller-supplied uniqueness set disambiguates.)
  const baseName = slugged === "" ? "credential" : slugged

  if (!existingNames.has(baseName)) return baseName

  let n = 2
  let candidate = `${baseName}-${n}`
  while (existingNames.has(candidate)) {
    n += 1
    candidate = `${baseName}-${n}`
  }
  return candidate
}
