// SPDX-License-Identifier: AGPL-3.0-only
// App grouping — pure derivation of "which App does this Platform+Credential
// belong to" (increment 30). NO I/O, NO persistence: the web/cli read layers
// load their already-fetched metadata and call this; nothing here queries a
// DB or makes a network call. See docs/design/provider-concept.md §"grouping
// is derived live" and method file §2a.

import type { PlatformKind } from "../schema/platform.js"
import type { AppDefinition } from "./catalog.js"
import { listApps } from "./catalog.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One connection = one account's access to an app via one vertical (one
 * credential + its platform). A public/no-credential platform contributes a
 * credential-less connection (account = "—").
 */
export interface Connection {
  /** Resolved app id, or "other" — NEVER undefined (see appIdForConnection). */
  appId: string
  /** Credential profileName, or "—" for a public/no-credential platform. */
  account: string
  platformId: string
  /** The chosen vertical for this connection. */
  kind: PlatformKind
}

/** A resolved App's connections (or the synthetic "other" bucket's). */
export interface AppGroup {
  appId: string
  connections: Connection[]
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Resolve ONE connection's app id. Attribution order (NO fuzzy/substring
 * matching — that rots into false positives over time):
 *   1. authoritative: `oauthProviderId` (from `oauthMeta.providerId`), if
 *      present → the app whose `auth[]` contains {mode:"oauth2", providerId}.
 *   2. exact, case-insensitive match of platform.id against AppDefinition.id.
 *   3. exact, case-insensitive match of platform.id against AppDefinition.aliases[].
 *   4. exact, case-insensitive match of platform.displayName against id/displayName.
 *   5. else → "other".
 *
 * Never returns undefined — unmatched connections land in "other" so every
 * connection is always groupable (proof-of-done: negative control).
 */
export function appIdForConnection(
  conn: {
    platformId: string
    platformDisplayName: string
    kind: PlatformKind
    oauthProviderId?: string
  },
  apps: AppDefinition[] = listApps(),
): string {
  const platformId = conn.platformId.toLowerCase()
  const platformDisplayName = conn.platformDisplayName.toLowerCase()

  // 1. Authoritative: the credential's oauthProviderId maps to an app whose
  // auth[] declares that exact oauth2 provider.
  if (conn.oauthProviderId) {
    const byProvider = apps.find((app) =>
      app.auth.some((a) => a.mode === "oauth2" && a.providerId === conn.oauthProviderId),
    )
    if (byProvider) return byProvider.id
  }

  // 2. Exact, case-insensitive id match.
  const byId = apps.find((app) => app.id.toLowerCase() === platformId)
  if (byId) return byId.id

  // 3. Exact, case-insensitive alias match.
  const byAlias = apps.find((app) =>
    (app.aliases ?? []).some((alias) => alias.toLowerCase() === platformId),
  )
  if (byAlias) return byAlias.id

  // 4. Exact, case-insensitive displayName match (against the app's id or displayName).
  const byDisplayName = apps.find(
    (app) =>
      app.id.toLowerCase() === platformDisplayName ||
      app.displayName.toLowerCase() === platformDisplayName,
  )
  if (byDisplayName) return byDisplayName.id

  // 5. Unmatched — honest bucket, not a guess.
  return "other"
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group platforms + credentials into apps. PURE — no I/O. The web/cli read
 * layers feed it their already-loaded metadata lists.
 *
 * Grain: CONNECTION level, not platform level. Each credential + its platform
 * = one connection. A platform with NO credentials contributes ONE
 * credential-less connection (account = "—"). The multi-account wedge (two
 * credentials on one platform) yields two connections. Every connection lands
 * in exactly one group (a catalog app, or the synthetic "other" group) — an
 * app in the catalog with ZERO connections is not emitted here (the /app
 * index left-joins listApps() separately, §2b).
 */
export function groupByApp(input: {
  platforms: { id: string; kind: PlatformKind; displayName: string }[]
  credentials: { platformId: string; account: string; oauthProviderId?: string }[]
}): AppGroup[] {
  const apps = listApps()
  const credentialsByPlatform = new Map<string, typeof input.credentials>()
  for (const cred of input.credentials) {
    const bucket = credentialsByPlatform.get(cred.platformId)
    if (bucket) bucket.push(cred)
    else credentialsByPlatform.set(cred.platformId, [cred])
  }

  const groups = new Map<string, Connection[]>()
  const pushConnection = (connection: Connection) => {
    const bucket = groups.get(connection.appId)
    if (bucket) bucket.push(connection)
    else groups.set(connection.appId, [connection])
  }

  for (const platform of input.platforms) {
    const creds = credentialsByPlatform.get(platform.id) ?? []
    if (creds.length === 0) {
      // Public/no-credential platform → one credential-less connection.
      const appId = appIdForConnection(
        {
          platformId: platform.id,
          platformDisplayName: platform.displayName,
          kind: platform.kind,
        },
        apps,
      )
      pushConnection({
        appId,
        account: "—",
        platformId: platform.id,
        kind: platform.kind,
      })
      continue
    }
    for (const cred of creds) {
      const appId = appIdForConnection(
        {
          platformId: platform.id,
          platformDisplayName: platform.displayName,
          kind: platform.kind,
          oauthProviderId: cred.oauthProviderId,
        },
        apps,
      )
      pushConnection({
        appId,
        account: cred.account,
        platformId: platform.id,
        kind: platform.kind,
      })
    }
  }

  // Note: we iterate `input.platforms` (not `input.credentials`) as the outer
  // loop, so a credential referencing a platformId absent from
  // `input.platforms` (shouldn't happen given the FK) is simply never
  // visited — no throwing on a caller data-shape mismatch, staying pure.

  return [...groups.entries()].map(([appId, connections]) => ({ appId, connections }))
}
