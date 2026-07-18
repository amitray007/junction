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
// fall through to the credential's legacy providerId. A misconfigured or
// maliciously-imported platform must never silently mask itself behind the
// fallback — a dangling/attacker-controlled reference could otherwise route
// a refresh token to an attacker-chosen tokenUrl. The fallback fires ONLY
// when the platform has NO provider source at all (unset field, or no
// platform in hand).

import { getProvider } from "./catalog.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why the resolution needed the credential's legacy `oauthMeta.providerId`
 * fallback (increment 42/44 transition — see docs/futures/revisit-when.md,
 * "Drop the oauthMeta.providerId fallback + column"). Two DISTINCT shapes,
 * both surfaced to `onFallback` so the drop gate's evidence is diagnosable:
 *   - "unset"    — the platform has no oauthProviderId set at all (including
 *                  an orphan credential with no platform in hand).
 *   - "conflict" — migration 0012's conflict rule left the platform's field
 *                  unset because its bound OAuth credentials disagreed; this
 *                  resolver doesn't re-detect the conflict itself (that's
 *                  0012/the inline import backfill's job) — from here it's
 *                  indistinguishable from "unset" without re-querying sibling
 *                  credentials, which this pure/single-credential resolver
 *                  deliberately does not do. Both fold to the "unset" reason.
 */
export type OAuthProviderIdFallbackReason = "unset"

/** Context tag distinguishing WHICH caller hit the fallback — refresh vs. app grouping. */
export type OAuthProviderIdContext = "refresh" | "group"

/**
 * Fired every time resolution falls back to the credential's legacy
 * `oauthMeta.providerId` — the evidence the later cleanup increment's drop
 * gate ("zero fallback hits") measures. IDS ONLY — never token material.
 */
export type OnOAuthProviderFallbackFn = (info: {
  context: OAuthProviderIdContext
  credentialId: string
  providerId: string
  reason: OAuthProviderIdFallbackReason
}) => void

export type ResolveOAuthProviderIdError =
  /**
   * platform.oauthProviderId is SET but no catalog design with that id
   * exists — SECURITY: fail closed, never fall back (R1).
   */
  | { kind: "dangling-provider-reference"; platformId: string; providerId: string }
  /** No provider source at all: no platform.oauthProviderId, no app-catalog
   *  auth[].providerId, and no credential.oauthMeta.providerId fallback. */
  | { kind: "no-provider-source"; credentialId: string }

export interface ResolveOAuthProviderIdArgs {
  /** The credential's id — for the fallback log + the no-source error, never logged with secrets. */
  credentialId: string
  /** Which caller is resolving — tags the fallback log so the drop gate's evidence is diagnosable. */
  context: OAuthProviderIdContext
  /** The bound platform, if the caller has one in hand. `null`/`undefined` = orphan credential (no platform). */
  platform?: { id: string; oauthProviderId?: string | undefined } | null | undefined
  /** The app catalog's declared oauth2 providerId for this platform, if resolvable in this context. */
  appAuthProviderId?: string | undefined
  /** The credential's legacy `oauthMeta.providerId` — the instrumented fallback's data source. */
  legacyProviderId?: string | undefined
  /** Fired when the fallback fires. Optional — a caller that doesn't care about the log may omit it. */
  onFallback?: OnOAuthProviderFallbackFn | undefined
}

// ---------------------------------------------------------------------------
// resolveOAuthProviderId
// ---------------------------------------------------------------------------

/**
 * Resolve which OAuth design id a credential's refresh/grouping should use.
 * Pure, synchronous, no I/O — a Result, not a ResultAsync (matches core's
 * "pure where possible" discipline; no caller here needs to await it).
 *
 * Fixed order (R1/R3):
 *   1. `platform.oauthProviderId` if set → use it, UNLESS it's a dangling
 *      reference (no matching catalog design) → typed error, fail closed.
 *   2. else `appAuthProviderId` (the app catalog's `auth[].providerId`),
 *      when the caller has resolved one for this context.
 *   3. else `legacyProviderId` (the credential's `oauthMeta.providerId`) →
 *      use it AND fire `onFallback` (ids only, never token material).
 *   4. none of the above → `{kind: "no-provider-source"}`.
 */
export function resolveOAuthProviderId(
  args: ResolveOAuthProviderIdArgs,
): { ok: true; providerId: string } | { ok: false; error: ResolveOAuthProviderIdError } {
  const { credentialId, context, platform, appAuthProviderId, legacyProviderId, onFallback } = args

  // 1. Platform's own reference — authoritative when set. A SET-but-invalid
  // reference fails closed (SECURITY, R1) rather than falling through to 2/3.
  const platformProviderId = platform?.oauthProviderId
  if (platformProviderId !== undefined) {
    const design = getProvider(platformProviderId)
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

  // 3. Instrumented fallback — the credential's legacy denormalized copy.
  if (legacyProviderId !== undefined) {
    onFallback?.({
      context,
      credentialId,
      providerId: legacyProviderId,
      reason: "unset",
    })
    return { ok: true, providerId: legacyProviderId }
  }

  // 4. Nothing to source from at all.
  return { ok: false, error: { kind: "no-provider-source", credentialId } }
}
