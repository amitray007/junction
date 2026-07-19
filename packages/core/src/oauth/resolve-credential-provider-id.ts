// SPDX-License-Identifier: AGPL-3.0-only
// resolveCredentialProviderId — the shared load-designs → merge → resolve →
// degrade sequence every LIVE reader of a credential's OAuth design needs
// (increment 45, Slice C). Every call site that used to read
// `credential.oauthMeta?.providerId` directly (verify-hints, display,
// reconnect) now goes through `resolveOAuthProviderId` with the credential's
// bound PLATFORM in hand — the same shared primitive refresh/grouping already
// use (increment 44 R3) — so display/verify/reconnect can never diverge from
// refresh on which design a credential belongs to.
//
// WHY A CORE HELPER (not web/cli-local): by Slice C there are ~6 call sites
// across web + cli, each doing the identical load+merge+resolve+degrade
// dance (past the rule of three — docs/principles/ DRY-eagerly for a shared
// primitive like this). `core` already owns `Repositories`/`CredentialStore`,
// so a helper that takes `repos` + `paths` + the credential/platform fits
// core's existing shape (mirrors resolve-provider-id.ts's own dependency
// list) without pulling HTTP or edge concerns into core.
//
// DEGRADE-NEVER-THROW: every failure mode (designs store load error,
// dangling reference, no provider source, platform lookup failure) resolves
// to `undefined` — the caller decides what "no providerId hint" means for
// its context (verify falls through to a normal non-OAuth-hinted verify;
// display shows null/omits the field). This helper never fails the calling
// operation — it only ever narrows "what design, if any, applies."
//
// LEGACY FALLBACK REMOVED (increment 45, Slice E): `credential.oauthMeta`
// no longer carries a `providerId` copy, and `resolveOAuthProviderId` no
// longer accepts one — resolution is platform.oauthProviderId → app-catalog
// only. A credential whose platform has no design source now degrades to
// `undefined` where it previously fell back to the legacy copy.

import type { JunctionPaths } from "../paths/index.js"
import type { Repositories } from "../repositories/index.js"
import type { Credential } from "../schema/credential.js"
import { mergeDesigns } from "./catalog.js"
import { loadCustomDesigns } from "./designs-store.js"
import { type OAuthProviderIdContext, resolveOAuthProviderId } from "./resolve-provider-id.js"

/**
 * Load custom designs + merge with built-ins, then resolve the OAuth design
 * id `credential` should use — sourced from its bound platform's
 * `oauthProviderId` (increment 42/44/45 — the only source; the credential's
 * legacy `oauthMeta.providerId` fallback was dropped in Slice E).
 *
 * DEGRADES TO `undefined` (never throws, never rejects) on:
 *   - the credential having no `platformId` (nothing to look up),
 *   - a platform lookup failure (not-found / DB error),
 *   - the designs store failing to load (fail-closed store, D1) — the
 *     resolution proceeds over BUILT-INS ONLY in that case, matching
 *     `readAppGroups`'s degrade discipline (display/verify-hint call sites
 *     are non-authoritative; a store outage must not break them),
 *   - `resolveOAuthProviderId` itself returning `{ok:false}` (dangling
 *     reference or no provider source at all).
 */
export async function resolveCredentialProviderId(
  args: {
    repos: Pick<Repositories, "platforms">
    paths: JunctionPaths
    credential: Pick<Credential, "id" | "platformId">
    context: OAuthProviderIdContext
  },
  // Test-only seam: inject a designs-loader stub without touching the real
  // filesystem. Never used by production callers (all omit it).
  deps: { loadDesigns?: typeof loadCustomDesigns } = {},
): Promise<string | undefined> {
  const { repos, paths, credential, context } = args
  const loadDesigns = deps.loadDesigns ?? loadCustomDesigns

  const designsResult = await loadDesigns(paths)
  if (designsResult.isErr()) {
    process.stderr.write(
      `resolveCredentialProviderId: custom OAuth designs store failed to load (${designsResult.error.kind}) — resolution degraded to built-in designs only (context=${context}, credentialId=${credential.id})\n`,
    )
  }
  const designs = mergeDesigns(designsResult.isOk() ? designsResult.value : [])

  // No platform bound (an orphan/unlinked credential, increment 42) — nothing
  // to look up; with the legacy fallback gone (Slice E) this always degrades
  // to undefined (resolveOAuthProviderId's documented "no platform" shape).
  let platform: { id: string; oauthProviderId?: string | undefined } | null = null
  if (credential.platformId !== null) {
    const platformResult = await repos.platforms.get(credential.platformId)
    if (platformResult.isOk()) {
      platform = {
        id: platformResult.value.id,
        oauthProviderId: platformResult.value.oauthProviderId,
      }
    }
    // A platform lookup failure (not-found / DB error) degrades the same as
    // "no platform" — no-provider-source still applies; this helper never
    // fails the caller over it.
  }

  const resolved = resolveOAuthProviderId({
    credentialId: credential.id,
    context,
    platform,
    designs,
  })

  return resolved.ok ? resolved.providerId : undefined
}
