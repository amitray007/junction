// SPDX-License-Identifier: AGPL-3.0-only
// FROZEN FIXTURE — a verbatim snapshot of packages/core/src/apps/catalog.ts as
// it stood immediately BEFORE increment 30.8's JSON migration (the file at
// HEAD when 30.8 started). NOT live code, NOT exported from index.ts, NOT
// consumed by any runtime path — its only purpose is catalog.migration.test.ts's
// diff: it lets the migration correctness test compare the NEW listApps()
// against the OLD APPS array COMPUTED FROM SOURCE (this file's own
// getApp/listApps), so the test can never silently hardcode or drift from a
// magic count (method file §6 proof-of-done).
//
// DO NOT update this file when catalog.ts changes going forward — it is a
// point-in-time historical snapshot, intentionally frozen.
//
// Original header (verbatim, for provenance):
// App catalog — the "which real-world service is this" concept (increment 30).
// Mirrors oauth/catalog.ts's pure, divergence-as-data style: no HTTP, no I/O.
// An App is orthogonal to auth mechanism (design doc §6) — the SAME real
// service can appear here with an oauth2 auth entry, a token entry, or both,
// independent of which Platform.kinds junction can stand up for it.
//
// Seeded from docs/design/app-catalog-data.md (inc 30 research — every entry
// verified against an official source; ⚠️-flagged/unverified data was either
// re-confirmed or omitted — see the omission notes below each entry group).

import type { PlatformKind } from "../../schema/platform.js"

// ---------------------------------------------------------------------------
// Types
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
// The catalog — seeded from the inc-30 research (app-catalog-data.md).
//
// Omissions (do NOT ship unverified/dead data — method file §5):
//  - Slack's MCP variant: the exact npm package (@slack/mcp-server) is
//    NOT confirmed by fetching the package page (⚠️ flagged in the research
//    doc) — Slack ships here via OAuth + token only, no "mcp" in
//    supportedKinds. If the package is confirmed later, add "mcp".
//  - SpaceX GraphQL: the community endpoint is confirmed DEAD — dropped
//    entirely, no app entry.
//  - Hashnode GraphQL: public API now paid + auth header unconfirmed against
//    official docs (⚠️ flagged) — omitted entirely rather than guess.
//  - Notion OpenAPI: no stable canonical raw spec URL (JS-rendered portal) —
//    Notion ships here via MCP + OAuth only, no "openapi".
//  - Figma's MCP (Dev Mode local server) has NO credential — modeled as
//    supportedKinds:["mcp"] with a {mode:"none"} entry alongside the OAuth
//    REST-API entry; the MCP transport itself is not vault-backed.
// ---------------------------------------------------------------------------

const APPS: readonly AppDefinition[] = [
  // --- Apps with a shipped or inc-30-added oauth2 provider -----------------
  {
    id: "github",
    displayName: "GitHub",
    supportedKinds: ["mcp", "cli", "openapi", "graphql"],
    auth: [
      { mode: "oauth2", providerId: "github" },
      { mode: "oauth2", providerId: "github-app" },
      { mode: "token" },
    ],
    aliases: ["gh"],
    iconSlug: "github",
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    supportedKinds: ["cli", "openapi", "graphql"],
    auth: [{ mode: "oauth2", providerId: "gitlab" }, { mode: "token" }],
    aliases: ["glab"],
    iconSlug: "gitlab",
  },
  // The three remaining SHIPPED OAuth providers (google/slack/microsoft) get
  // first-class App entries so a real OAuth connection attributes to its own
  // App instead of landing in "Other" (caught in inc-30 real-server QA against
  // a dogfooded Google connection). supportedKinds reflect what junction can
  // stand up today via a bearer/OAuth token over HTTP; kept conservative and
  // honest rather than claiming every vertical each vendor offers.
  {
    id: "google",
    displayName: "Google",
    // Google's APIs (Drive, Gmail, Calendar, …) are REST/OpenAPI-shaped over an
    // OAuth bearer; the token is protocol-agnostic. No single junction-standable
    // MCP/GraphQL/CLI vertical is asserted here without verified connection data.
    supportedKinds: ["openapi"],
    auth: [{ mode: "oauth2", providerId: "google" }],
    iconSlug: "google",
  },
  {
    id: "slack",
    displayName: "Slack",
    // Slack ships via OAuth (bot/user token) + its Web API (REST). The MCP
    // variant is omitted until the package is confirmed (see the omission note).
    // iconSlug added in v2 (inc 30.5): @thesvg/icons carries "slack" (full-color
    // "default" variant, no light/dark/mono) — simple-icons had removed it on
    // trademark request; @thesvg/icons still has it. See docs/futures/gotchas.md.
    supportedKinds: ["openapi"],
    auth: [{ mode: "oauth2", providerId: "slack" }, { mode: "token" }],
    iconSlug: "slack",
  },
  {
    id: "microsoft",
    displayName: "Microsoft",
    // Microsoft Graph is a REST/OpenAPI surface over an OAuth bearer.
    // iconSlug added in v2 (inc 30.5): @thesvg/icons carries "microsoft"
    // (full-color "default" variant only) — simple-icons had removed it.
    supportedKinds: ["openapi"],
    auth: [{ mode: "oauth2", providerId: "microsoft" }],
    iconSlug: "microsoft",
  },
  {
    id: "notion",
    displayName: "Notion",
    supportedKinds: ["mcp"],
    // Public OAuth is Notion's hosted-integration path; internal integrations
    // authenticate with a static internal-integration bearer token, so both
    // paths are offered (OAuth first = default).
    auth: [{ mode: "oauth2", providerId: "notion" }, { mode: "token" }],
    iconSlug: "notion",
  },
  {
    id: "linear",
    displayName: "Linear",
    supportedKinds: ["mcp", "graphql"],
    // Linear accepts OAuth 2.1 (DCR) or a bearer PAT — both vault-friendly.
    auth: [{ mode: "oauth2", providerId: "linear" }, { mode: "token" }],
    iconSlug: "linear",
  },
  {
    id: "atlassian",
    displayName: "Atlassian",
    supportedKinds: ["mcp"],
    // Atlassian's remote MCP accepts OAuth 2.1 or an API token.
    auth: [{ mode: "oauth2", providerId: "atlassian" }, { mode: "token" }],
    setupHints: ["Covers Jira and Confluence Cloud sites via the shared Atlassian OAuth app."],
    iconSlug: "atlassian",
  },
  {
    id: "discord",
    displayName: "Discord",
    supportedKinds: ["openapi"],
    auth: [{ mode: "oauth2", providerId: "discord" }, { mode: "token" }],
    iconSlug: "discord",
  },
  {
    id: "spotify",
    displayName: "Spotify",
    // OAuth-only in the research data — no MCP/CLI/OpenAPI/GraphQL entry for
    // Spotify was verified this pass.
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "spotify" }],
    iconSlug: "spotify",
  },
  {
    id: "zoom",
    displayName: "Zoom",
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "zoom" }],
    iconSlug: "zoom",
  },
  {
    id: "dropbox",
    displayName: "Dropbox",
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "dropbox" }],
    iconSlug: "dropbox",
  },
  {
    id: "figma",
    displayName: "Figma",
    // The Dev Mode MCP server trusts the locally-running desktop app (no
    // credential); the REST API is OAuth. Both are real, junction-standable
    // surfaces for the SAME app — proving App ⊥ auth-mechanism.
    supportedKinds: ["mcp"],
    auth: [{ mode: "oauth2", providerId: "figma" }, { mode: "none" }],
    setupHints: [
      "The Figma Dev Mode MCP server requires no credential — it trusts the locally-running desktop app.",
      "The REST API (file/comment access) uses OAuth.",
    ],
    iconSlug: "figma",
  },

  // --- Apps with NO oauth2 catalog provider (token / byo) -------------------
  {
    id: "stripe",
    displayName: "Stripe",
    supportedKinds: ["mcp", "cli", "openapi"],
    auth: [{ mode: "token" }],
    setupHints: ["Use a Restricted Key for the MCP/CLI path."],
    iconSlug: "stripe",
  },
  {
    id: "sentry",
    displayName: "Sentry",
    supportedKinds: ["mcp", "cli"],
    auth: [{ mode: "token" }],
    iconSlug: "sentry",
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    supportedKinds: ["mcp", "cli"],
    auth: [{ mode: "token" }],
    iconSlug: "cloudflare",
  },
  {
    id: "supabase",
    displayName: "Supabase",
    supportedKinds: ["mcp", "cli"],
    auth: [{ mode: "token" }],
    setupHints: ["Supabase's own OAuth browser flow is not junction's vault — use a PAT instead."],
    iconSlug: "supabase",
  },
  {
    id: "vercel",
    displayName: "Vercel",
    supportedKinds: ["cli", "openapi"],
    auth: [{ mode: "token" }],
    iconSlug: "vercel",
  },
  {
    id: "railway",
    displayName: "Railway",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
    setupHints: ["RAILWAY_API_TOKEN is the account-scoped token; RAILWAY_TOKEN is project-scoped."],
    iconSlug: "railway",
  },
  {
    id: "heroku",
    displayName: "Heroku",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
    setupHints: ["`heroku config` prints secret values — treat reads as sensitive."],
    // iconSlug added in v2 (inc 30.5): @thesvg/icons carries "heroku"
    // (full-color "default" variant only) — simple-icons did not have it.
    iconSlug: "heroku",
  },
  {
    id: "doppler",
    displayName: "Doppler",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
    setupHints: ["`doppler secrets` prints secret values — treat reads as sensitive."],
    // NO iconSlug: no "doppler" export in the installed simple-icons version
    // (verified inc 30.5) — falls back to the letter tile.
  },
  {
    id: "digitalocean",
    displayName: "DigitalOcean",
    supportedKinds: ["cli", "openapi"],
    auth: [{ mode: "token" }],
    iconSlug: "digitalocean",
  },
  {
    id: "aws",
    displayName: "AWS",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
    // iconSlug added in v2 (inc 30.5): @thesvg/icons carries "aws" (full-color
    // "default" variant; also has "color"/"mono"/"icon" but none add themed
    // light/dark, so this stays category "color").
    iconSlug: "aws",
  },
  {
    id: "brave-search",
    displayName: "Brave Search",
    supportedKinds: ["mcp"],
    auth: [{ mode: "token" }],
    // Uses the parent-brand "brave" logo (@thesvg/icons has no Brave-Search-
    // specific mark; Brave Search is Brave's own product — user-approved
    // related-logo use, inc 30.5 v2).
    iconSlug: "brave",
  },
  {
    id: "playwright",
    displayName: "Playwright",
    supportedKinds: ["mcp"],
    auth: [{ mode: "none" }],
    iconSlug: "playwright",
  },
  {
    id: "filesystem",
    displayName: "Filesystem",
    supportedKinds: ["mcp"],
    auth: [{ mode: "none" }],
    // No brand logo — generic capability, not a vendor. Letter tile.
  },
  {
    id: "openai",
    displayName: "OpenAI",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    // iconSlug added in v2 (inc 30.5): @thesvg/icons carries "openai" with
    // both light+dark variants (category "themed") — simple-icons only had
    // the unrelated "openaigym" slug.
    iconSlug: "openai",
  },
  {
    id: "box",
    displayName: "Box",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    iconSlug: "box",
  },
  {
    id: "adyen",
    displayName: "Adyen",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    iconSlug: "adyen",
  },
  {
    id: "pagerduty",
    displayName: "PagerDuty",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    iconSlug: "pagerduty",
  },
  {
    id: "asana",
    displayName: "Asana",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    iconSlug: "asana",
  },
  {
    id: "twilio",
    displayName: "Twilio",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    aliases: ["twilio-accounts"],
    // iconSlug added in v2 (inc 30.5): @thesvg/icons carries "twilio"
    // (full-color "default" variant only) — simple-icons did not have it.
    iconSlug: "twilio",
  },
  {
    id: "sendgrid",
    displayName: "SendGrid",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    aliases: ["sendgrid-mail"],
    // NO iconSlug: no "sendgrid" export in the installed simple-icons version
    // (verified inc 30.5) — falls back to the letter tile.
  },
  {
    id: "shopify",
    displayName: "Shopify",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
    aliases: ["shopify-admin", "shopify-storefront"],
    iconSlug: "shopify",
  },
  {
    id: "contentful",
    displayName: "Contentful",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
    iconSlug: "contentful",
  },
  {
    id: "yelp",
    displayName: "Yelp",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
    iconSlug: "yelp",
  },
  {
    id: "datocms",
    displayName: "DatoCMS",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
    iconSlug: "datocms",
  },
  {
    id: "braintree",
    displayName: "Braintree",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
    iconSlug: "braintree",
  },
  {
    id: "monday",
    displayName: "monday.com",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
    // NO iconSlug: @thesvg/icons only has monday as a WIDE WORDMARK (viewBox
    // ~467×46, all variants) — squeezed into the compact square glyph slot it
    // renders as an illegible sliver. A clean letter tile beats a broken
    // wordmark, so monday stays on the fallback (verified inc 30.5 v2).
  },
  {
    id: "wpgraphql",
    displayName: "WPGraphQL",
    supportedKinds: ["graphql"],
    auth: [{ mode: "byo" }],
    setupHints: ["Self-hosted WordPress site — the endpoint host is user-supplied."],
    // Uses the parent-brand "wordpress" logo (WPGraphQL is a WordPress GraphQL
    // plugin; @thesvg/icons has no WPGraphQL-specific mark — user-approved
    // related-logo use, inc 30.5 v2).
    iconSlug: "wordpress",
  },
  {
    id: "saleor",
    displayName: "Saleor",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }, { mode: "none" }],
    setupHints: ["The public demo endpoint needs no auth; authed queries use a Bearer token."],
    // NO iconSlug: no "saleor" export in the installed simple-icons version
    // (verified inc 30.5) — falls back to the letter tile.
  },

  // --- No-auth public demo/reference apps ------------------------------------
  {
    id: "petstore",
    displayName: "Swagger Petstore",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    setupHints: ["Public demo API — an api_key header is accepted but not required for reads."],
    // Uses the "swagger" logo — the Petstore is Swagger's own canonical demo
    // API (user-approved related-logo use, inc 30.5 v2).
    iconSlug: "swagger",
  },
  {
    id: "countries",
    displayName: "Countries (trevorblades)",
    supportedKinds: ["graphql"],
    auth: [{ mode: "none" }],
    // No brand logo — community reference API. Letter tile.
  },
  {
    id: "rickandmorty",
    displayName: "Rick and Morty API",
    supportedKinds: ["graphql"],
    auth: [{ mode: "none" }],
    // NO iconSlug: no "rickandmorty" export in the installed simple-icons
    // version (verified inc 30.5) — falls back to the letter tile.
  },
  {
    id: "anilist",
    displayName: "AniList",
    supportedKinds: ["graphql"],
    auth: [{ mode: "none" }],
    setupHints: ["Public reads need no auth; mutations require OAuth (not modeled here)."],
    iconSlug: "anilist",
  },
]

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
