// SPDX-License-Identifier: AGPL-3.0-only
// resolveOAuthProviderId — the ONE shared primitive that decides which OAuth
// design (catalog.ts's OAuthProvider.id) a credential's refresh/grouping
// should use (increment 44 Phase 3, R3). Refresh and grouping diverging on
// this would be a correctness bug (a connection grouped under one app but
// refreshed via another), not mere duplication — so this is DRY-eagerly, not
// rule-of-three.
//
// SECURITY (R1 — fail closed): if platform.oauthProviderId is SET but points
// at a design that doesn't exist, this returns a typed error and does NOT
// fall through to any other source. A misconfigured or maliciously-imported
// platform must never silently mask itself behind a lower-precedence source —
// a dangling/attacker-controlled reference could otherwise route a refresh
// token to an attacker-chosen tokenUrl.
//
// DESIGNS-AS-DATA (increment 45, Fable D2): this resolver takes the merged
// built-in + custom design lookup as a PARAM (`designs`), not a catalog
// import — it stays pure/synchronous/no-I/O. The caller loads custom designs
// at the I/O edge (`loadCustomDesigns`), merges via `mergeDesigns`, and
// passes the result in. A per-process cache here would be WRONG — junction
// is multi-process (CLI / web / `mcp serve`), and a CLI-created custom
// design must be visible to an already-running web server without a
// restart; re-reading the small designs file per resolve call (rare — only
// on refresh/grouping) is the correct cost to pay for that, and it's the
// CALLER's job (not this function's) to do that re-read.
//
// LEGACY FALLBACK REMOVED (increment 45, Slice E / Fable E1): the credential's
// `oauthMeta.providerId` denormalized copy — and the instrumented fallback
// arm that read it — are GONE. The resolver is now platform.oauthProviderId
// → app-catalog auth[].providerId only. Migration 0013 verifies every
// existing credential resolves via this narrower path BEFORE dropping the
// column (see db/migrations/0013_drop_oauth_meta_provider_id.sql +
// verify-provider-id-drop-safe.ts) — a platform with no provider source at
// all now surfaces `no-provider-source` where it previously fell back.

import type { OAuthProvider } from "./catalog.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context tag distinguishing WHICH caller hit resolution — refresh vs. app grouping. */
export type OAuthProviderIdContext = "refresh" | "group"

export type ResolveOAuthProviderIdError =
  /**
   * platform.oauthProviderId is SET but no catalog design with that id
   * exists — SECURITY: fail closed, never fall back (R1).
   */
  | { kind: "dangling-provider-reference"; platformId: string; providerId: string }
  /**
   * No provider source at all: no platform.oauthProviderId and no app-catalog
   * auth[].providerId. (Increment 45, Slice E — previously this also meant
   * "no credential.oauthMeta.providerId fallback either"; that fallback no
   * longer exists, so this fires strictly more often than before the drop.)
   */
  | { kind: "no-provider-source"; credentialId: string }

export interface ResolveOAuthProviderIdArgs {
  /** The credential's id — for the no-source error, never logged with secrets. */
  credentialId: string
  /** Which caller is resolving — refresh vs. grouping (kept for future diagnostics). */
  context: OAuthProviderIdContext
  /** The bound platform, if the caller has one in hand. `null`/`undefined` = orphan credential (no platform). */
  platform?: { id: string; oauthProviderId?: string | undefined } | null | undefined
  /** The app catalog's declared oauth2 providerId for this platform, if resolvable in this context. */
  appAuthProviderId?: string | undefined
  /**
   * The merged built-in + custom design lookup (increment 45, D2) — the
   * SOLE source this resolver consults to decide whether
   * `platform.oauthProviderId` is a real, resolvable design (step 1's
   * dangling-reference guard). Built by the caller via `mergeDesigns` over
   * whatever `loadCustomDesigns` returned for THIS call; this function does
   * no I/O and no per-process caching of its own.
   */
  designs: ReadonlyMap<string, OAuthProvider>
}

// ---------------------------------------------------------------------------
// resolveOAuthProviderId
// ---------------------------------------------------------------------------

/**
 * Resolve which OAuth design id a credential's refresh/grouping should use.
 * Pure, synchronous, no I/O — a Result, not a ResultAsync (matches core's
 * "pure where possible" discipline; no caller here needs to await it).
 *
 * Fixed order (R1/R3, narrowed in increment 45 Slice E):
 *   1. `platform.oauthProviderId` if set → use it, UNLESS it's a dangling
 *      reference (no matching design in the MERGED set — built-in or
 *      `custom:<slug>`) → typed error, fail closed.
 *   2. else `appAuthProviderId` (the app catalog's `auth[].providerId`),
 *      when the caller has resolved one for this context.
 *   3. none of the above → `{kind: "no-provider-source"}`.
 */
export function resolveOAuthProviderId(
  args: ResolveOAuthProviderIdArgs,
): { ok: true; providerId: string } | { ok: false; error: ResolveOAuthProviderIdError } {
  const { credentialId, platform, appAuthProviderId, designs } = args

  // 1. Platform's own reference — authoritative when set. A SET-but-invalid
  // reference fails closed (SECURITY, R1) rather than falling through to 2.
  // "invalid" is checked against the MERGED set (increment 45, D2) — a
  // `custom:<slug>` platform reference is just as valid here as a built-in.
  const platformProviderId = platform?.oauthProviderId
  if (platformProviderId !== undefined) {
    const design = designs.get(platformProviderId)
    if (design === undefined) {
      return {
        ok: false,
        error: {
          kind: "dangling-provider-reference",
          platformId: platform?.id ?? "",
          providerId: platformProviderId,
        },
      }
    }
    return { ok: true, providerId: platformProviderId }
  }

  // 2. App catalog's declared oauth2 provider for this platform (when the
  // caller has resolved one — e.g. via the app that declares this platform's
  // auth[]). Not a fallback — this is as authoritative as the catalog itself.
  if (appAuthProviderId !== undefined) {
    return { ok: true, providerId: appAuthProviderId }
  }

  // 3. Nothing to source from at all.
  return { ok: false, error: { kind: "no-provider-source", credentialId } }
}
