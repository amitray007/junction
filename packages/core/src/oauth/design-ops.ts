// SPDX-License-Identifier: AGPL-3.0-only
// Custom OAuth-design authoring ops (increment 45, Slice D / Fable D3/D4) —
// add/list/delete on top of designs-store.ts's persistence primitives. This
// is where the POLICY lives (built-in-collision rejection, create-only,
// delete-if-unreferenced) — designs-store.ts stays a dumb file store.
//
// D3 (namespace): a custom design's id is ALWAYS `custom:<slug>` (enforced by
// CustomOAuthDesignSchema's regex, both here at parse time and at every file
// load). addCustomDesign additionally rejects a create whose id collides with
// a BUILT-IN catalog id — structurally impossible given the regex (no built-in
// id contains `:`), but checked explicitly anyway as the create-time half of
// "built-ins always win" (mergeDesigns is the load-time half).
//
// D4 (delete): only `custom:*` ids are ever deletable — a delete request for
// a built-in id is a typed rejection, not a 404 (the id is real, just not
// something this store owns). "Unreferenced" means BOTH:
//   - no platform's `oauthProviderId` equals this id, AND
//   - no credential's LEGACY `oauthMeta.providerId` equals this id (the
//     legacy fallback arm stays live until Slice E — a credential that still
//     depends on the legacy field for resolution must not be orphaned by a
//     design delete out from under it).
// A referenced delete is refused with a typed error NAMING the referrers
// (platform ids / credential ids) so the caller (CLI/web) can show the user
// exactly what to unlink first.

import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import type { JunctionPaths } from "../paths/index.js"
import type { Repositories } from "../repositories/index.js"
import type { OAuthProvider } from "./catalog.js"
import { getProvider, listProviders } from "./catalog.js"
import {
  CUSTOM_OAUTH_DESIGN_ID_PATTERN,
  type CustomOAuthDesign,
  type DesignsStoreError,
  loadCustomDesigns,
  parseCustomOAuthDesign,
  saveCustomDesigns,
} from "./designs-store.js"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DesignOpError =
  /** The input didn't validate as a CustomOAuthDesign (bad id charset, missing field, etc). */
  | { kind: "invalid-design"; cause: unknown }
  /** create: the id collides with a BUILT-IN catalog id — a custom design can never shadow one. */
  | { kind: "builtin-collision"; id: string }
  /** create: a custom design with this id already exists — this slice is create-only, no overwrite. */
  | { kind: "already-exists"; id: string }
  /** delete: the id is not a `custom:*` id — built-ins (and any other non-custom id) are undeletable. */
  | { kind: "not-custom"; id: string }
  /** delete: no custom design exists with this id. */
  | { kind: "not-found"; id: string }
  /** delete: the design is still referenced by ≥1 platform and/or legacy credential. */
  | { kind: "referenced"; id: string; platformIds: string[]; credentialIds: string[] }
  /** Propagated from the underlying store (load/save I/O, fail-closed corruption, etc). */
  | { kind: "store-error"; cause: DesignsStoreError }

// ---------------------------------------------------------------------------
// addCustomDesign
// ---------------------------------------------------------------------------

/**
 * Validate + persist a new custom OAuth design. Create-only (D4 scope): an id
 * that already exists — whether a built-in OR an existing custom design — is
 * rejected rather than silently overwritten. Editing a referenced design's
 * URLs is explicitly deferred (see the method file's Deferred table — the
 * live-token-invalidation question isn't decided yet).
 */
export function addCustomDesign(
  paths: JunctionPaths,
  input: unknown,
): ResultAsync<CustomOAuthDesign, DesignOpError> {
  const parsed = parseCustomOAuthDesign(input)
  if (!parsed.ok) {
    return errAsync({ kind: "invalid-design", cause: parsed.error })
  }
  const design = parsed.design

  // Structurally near-impossible (CUSTOM_OAUTH_DESIGN_ID_PATTERN requires a
  // `custom:` prefix, and no built-in id carries a `:`) but checked
  // explicitly — this is the create-time half of "built-ins always win"
  // (mergeDesigns is the load-time half); belt-and-suspenders, not the only
  // guard.
  if (getProvider(design.id) !== undefined) {
    return errAsync({ kind: "builtin-collision", id: design.id })
  }

  return loadCustomDesigns(paths)
    .mapErr((cause): DesignOpError => ({ kind: "store-error", cause }))
    .andThen((existing) => {
      if (existing.some((d) => d.id === design.id)) {
        return errAsync<CustomOAuthDesign, DesignOpError>({ kind: "already-exists", id: design.id })
      }
      return saveCustomDesigns(paths, [...existing, design])
        .mapErr((cause): DesignOpError => ({ kind: "store-error", cause }))
        .map(() => design)
    })
}

// ---------------------------------------------------------------------------
// listAllDesigns
// ---------------------------------------------------------------------------

export type ListedDesign = OAuthProvider & { isCustom: boolean }

/**
 * The merged design set (built-ins + custom), each entry flagged `isCustom`
 * so a caller (web/CLI list) can render the two groups distinctly without
 * re-deriving the split itself (e.g. via the `custom:` prefix). Built-ins
 * first, in catalog order, then custom designs — a stable, predictable order
 * for `list --json` consumers.
 */
export function listAllDesigns(paths: JunctionPaths): ResultAsync<ListedDesign[], DesignOpError> {
  return loadCustomDesigns(paths)
    .mapErr((cause): DesignOpError => ({ kind: "store-error", cause }))
    .map((custom) => {
      const builtins: ListedDesign[] = listProviders().map((p) => ({ ...p, isCustom: false }))
      const customListed: ListedDesign[] = custom.map((d) => ({ ...d, isCustom: true }))
      return [...builtins, ...customListed]
    })
}

// ---------------------------------------------------------------------------
// deleteCustomDesign
// ---------------------------------------------------------------------------

/**
 * Delete a custom design — D4: only `custom:*` ids, only when UNREFERENCED.
 * "Unreferenced" checks `platform.oauthProviderId` (the ONLY source a
 * credential's OAuth design can come from as of increment 45, Slice E — the
 * legacy `credential.oauth_meta.providerId` fallback + its referrer check
 * were dropped alongside the column) — a referenced id is refused with a
 * typed error naming every referrer so the caller can show the user exactly
 * what to unlink first.
 */
export function deleteCustomDesign(
  paths: JunctionPaths,
  repos: Repositories,
  id: string,
): ResultAsync<void, DesignOpError> {
  if (!CUSTOM_OAUTH_DESIGN_ID_PATTERN.test(id)) {
    return errAsync({ kind: "not-custom", id })
  }

  return loadCustomDesigns(paths)
    .mapErr((cause): DesignOpError => ({ kind: "store-error", cause }))
    .andThen((existing) => {
      if (!existing.some((d) => d.id === id)) {
        return errAsync<CustomOAuthDesign[], DesignOpError>({ kind: "not-found", id })
      }
      return okAsync(existing)
    })
    .andThen((existing) => findReferrers(repos, id).map((referrers) => ({ existing, referrers })))
    .andThen(({ existing, referrers }) => {
      if (referrers.platformIds.length > 0 || referrers.credentialIds.length > 0) {
        return errAsync<void, DesignOpError>({
          kind: "referenced",
          id,
          platformIds: referrers.platformIds,
          credentialIds: referrers.credentialIds,
        })
      }
      const remaining = existing.filter((d) => d.id !== id)
      return saveCustomDesigns(paths, remaining).mapErr(
        (cause): DesignOpError => ({ kind: "store-error", cause }),
      )
    })
}

/**
 * Query the referrer source for a design id. Typed as a DesignOpError on DB
 * failure (mapped from the underlying DbError kind — a query failure is NOT
 * the same as "unreferenced"; fail closed by surfacing it rather than
 * treating a failed lookup as an empty referrer list, which would let a
 * REFERENCED design be deleted out from under a live credential.
 *
 * `credentialIds` is now ALWAYS empty (increment 45, Slice E — a credential
 * can no longer reference a design directly; only its PLATFORM can). The
 * shape is kept (rather than narrowed to `platformIds` alone) because
 * `DesignOpError`'s `"referenced"` variant still carries both fields —
 * narrowing that error shape is a separate, out-of-scope cleanup.
 */
function findReferrers(
  repos: Repositories,
  id: string,
): ResultAsync<{ platformIds: string[]; credentialIds: string[] }, DesignOpError> {
  return repos.platforms
    .list()
    .mapErr((cause): DesignOpError => ({ kind: "store-error", cause: toStoreError(cause) }))
    .map((platforms) => ({
      platformIds: platforms.filter((p) => p.oauthProviderId === id).map((p) => String(p.id)),
      credentialIds: [] as string[],
    }))
}

/**
 * findReferrers reuses DesignOpError's `store-error` slot to carry a DB
 * failure (rather than adding a new error kind just for this internal
 * plumbing) — this wraps a DbError into a shape DesignsStoreError-shaped
 * callers can still pattern-match structurally (`cause` carries the real
 * DbError for diagnosis; `kind` stays a literal so `store-error` remains a
 * single case for consumers to handle).
 */
function toStoreError(cause: unknown): DesignsStoreError {
  return { kind: "read-failed", cause }
}
