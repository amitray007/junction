// SPDX-License-Identifier: AGPL-3.0-only
// App catalog — the "which real-world service is this" concept (increment 30).
// getApp()/listApps() now resolve from the richer, JSON-authored catalog
// (increment 30.8 — packages/core/src/apps/catalog/<id>/catalog.json, compiled
// to catalog.generated.ts, loaded + re-validated by ./catalog/index.ts). This
// module keeps the ORIGINAL AppDefinition/AppAuth surface (byte-identical
// fields) so every existing consumer (group.ts, web's readApps) is unaffected —
// it simply projects the richer AppCatalogEntry down to the legacy shape.
// See docs/methods/30.8-app-catalog-schema.md §4.

import type { PlatformKind } from "../schema/platform.js"
import { listCatalogEntries } from "./catalog/index.js"

// ---------------------------------------------------------------------------
// Types (unchanged from pre-30.8 — see catalog-schema.ts for the richer shape)
// ---------------------------------------------------------------------------

/**
 * How you authenticate to an app. An app may list several (first = default).
 * "oauth2" links to an `oauth/catalog.ts` OAuthProvider by id (catalog-integrity
 * tested — a typo here would dead-link the connect CTA). "token" = a pasted
 * bearer/API-key/PAT (vault-backed, no OAuth dance). "byo" = a generic escape
 * hatch — user supplies full connection details (e.g. a self-hosted instance).
 * "none" = no credential at all (junction can't vault anything for this app —
 * e.g. Figma's locally-running Dev Mode MCP server).
 */
export type AppAuth =
  | { mode: "oauth2"; providerId: string }
  | { mode: "token" }
  | { mode: "byo" }
  | { mode: "none" }

export interface AppDefinition {
  /** App id, e.g. "github" | "google" | … — NOT a Platform.id. */
  id: string
  displayName: string
  /** Which Platform.kinds junction can STAND UP for this app (capability, not vendor surface). */
  supportedKinds: PlatformKind[]
  /** How you authenticate to this app (may be several ways; first = default). */
  auth: AppAuth[]
  /** Well-known alternate platform-ids this app is also reachable under (exact match only). */
  aliases?: string[]
  /** Short guided-setup hints shown on the /app/:id empty state. */
  setupHints?: string[]
  /**
   * @thesvg/icons slug for this app's brand glyph (e.g. "github", "gitlab") —
   * NOT a Platform.id. Verified against the installed @thesvg/icons package
   * (increment 30.5 v2 — see docs/methods/30.5-app-lifecycle.md §4); omit
   * rather than guess — apps without a verified slug fall back to a
   * first-letter tile in the web UI (packages/web/src/ui/brand-icon.tsx).
   * The codegen at packages/web/scripts/gen-brand-icons.mjs fails the build
   * loudly if a slug set here has no matching @thesvg/icons module — see
   * docs/futures/gotchas.md.
   */
  iconSlug?: string
}

// ---------------------------------------------------------------------------
// Projection: richer AppCatalogEntry -> legacy AppDefinition
// ---------------------------------------------------------------------------

function toAppDefinition(entry: ReturnType<typeof listCatalogEntries>[number]): AppDefinition {
  const def: AppDefinition = {
    id: entry.id,
    displayName: entry.displayName,
    supportedKinds: entry.supportedKinds,
    auth: entry.auth,
  }
  if (entry.aliases) def.aliases = entry.aliases
  if (entry.setupHints) def.setupHints = entry.setupHints
  if (entry.iconSlug) def.iconSlug = entry.iconSlug
  return def
}

const APPS: readonly AppDefinition[] = listCatalogEntries().map(toAppDefinition)
const APPS_BY_ID = new Map(APPS.map((a) => [a.id, a]))

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/** Catalog lookup by app id. */
export function getApp(id: string): AppDefinition | undefined {
  return APPS_BY_ID.get(id)
}

/** All catalog entries, for the /app index (design §7). */
export function listApps(): AppDefinition[] {
  return [...APPS]
}
