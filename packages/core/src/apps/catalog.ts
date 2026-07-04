// SPDX-License-Identifier: AGPL-3.0-only
// App catalog — the "which real-world service is this" concept (increment 30).
// Mirrors oauth/catalog.ts's pure, divergence-as-data style: no HTTP, no I/O.
// An App is orthogonal to auth mechanism (design doc §6) — the SAME real
// service can appear here with an oauth2 auth entry, a token entry, or both,
// independent of which Platform.kinds junction can stand up for it.
//
// Seeded from docs/design/app-catalog-data.md (inc 30 research — every entry
// verified against an official source; ⚠️-flagged/unverified data was either
// re-confirmed or omitted — see the omission notes below each entry group).

import type { PlatformKind } from "../schema/platform.js"

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
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    supportedKinds: ["cli", "openapi", "graphql"],
    auth: [{ mode: "oauth2", providerId: "gitlab" }, { mode: "token" }],
    aliases: ["glab"],
  },
  {
    id: "notion",
    displayName: "Notion",
    supportedKinds: ["mcp"],
    // Notion is OAuth-mandatory — no bearer path (research doc, cross-cutting note).
    auth: [{ mode: "oauth2", providerId: "notion" }],
  },
  {
    id: "linear",
    displayName: "Linear",
    supportedKinds: ["mcp", "graphql"],
    // Linear accepts OAuth 2.1 (DCR) or a bearer PAT — both vault-friendly.
    auth: [{ mode: "oauth2", providerId: "linear" }, { mode: "token" }],
  },
  {
    id: "atlassian",
    displayName: "Atlassian",
    supportedKinds: ["mcp"],
    // Atlassian's remote MCP accepts OAuth 2.1 or an API token.
    auth: [{ mode: "oauth2", providerId: "atlassian" }, { mode: "token" }],
    setupHints: ["Covers Jira and Confluence Cloud sites via the shared Atlassian OAuth app."],
  },
  {
    id: "discord",
    displayName: "Discord",
    supportedKinds: ["openapi"],
    auth: [{ mode: "oauth2", providerId: "discord" }, { mode: "token" }],
  },
  {
    id: "spotify",
    displayName: "Spotify",
    // OAuth-only in the research data — no MCP/CLI/OpenAPI/GraphQL entry for
    // Spotify was verified this pass.
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "spotify" }],
  },
  {
    id: "zoom",
    displayName: "Zoom",
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "zoom" }],
  },
  {
    id: "dropbox",
    displayName: "Dropbox",
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "dropbox" }],
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
  },

  // --- Apps with NO oauth2 catalog provider (token / byo) -------------------
  {
    id: "stripe",
    displayName: "Stripe",
    supportedKinds: ["mcp", "cli", "openapi"],
    auth: [{ mode: "token" }],
    setupHints: ["Use a Restricted Key for the MCP/CLI path."],
  },
  {
    id: "sentry",
    displayName: "Sentry",
    supportedKinds: ["mcp", "cli"],
    auth: [{ mode: "token" }],
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    supportedKinds: ["mcp", "cli"],
    auth: [{ mode: "token" }],
  },
  {
    id: "supabase",
    displayName: "Supabase",
    supportedKinds: ["mcp", "cli"],
    auth: [{ mode: "token" }],
    setupHints: ["Supabase's own OAuth browser flow is not junction's vault — use a PAT instead."],
  },
  {
    id: "vercel",
    displayName: "Vercel",
    supportedKinds: ["cli", "openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "railway",
    displayName: "Railway",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
    setupHints: ["RAILWAY_API_TOKEN is the account-scoped token; RAILWAY_TOKEN is project-scoped."],
  },
  {
    id: "heroku",
    displayName: "Heroku",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
    setupHints: ["`heroku config` prints secret values — treat reads as sensitive."],
  },
  {
    id: "doppler",
    displayName: "Doppler",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
    setupHints: ["`doppler secrets` prints secret values — treat reads as sensitive."],
  },
  {
    id: "digitalocean",
    displayName: "DigitalOcean",
    supportedKinds: ["cli", "openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "aws",
    displayName: "AWS",
    supportedKinds: ["cli"],
    auth: [{ mode: "token" }],
  },
  {
    id: "brave-search",
    displayName: "Brave Search",
    supportedKinds: ["mcp"],
    auth: [{ mode: "token" }],
  },
  {
    id: "playwright",
    displayName: "Playwright",
    supportedKinds: ["mcp"],
    auth: [{ mode: "none" }],
  },
  {
    id: "filesystem",
    displayName: "Filesystem",
    supportedKinds: ["mcp"],
    auth: [{ mode: "none" }],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "box",
    displayName: "Box",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "adyen",
    displayName: "Adyen",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "pagerduty",
    displayName: "PagerDuty",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "asana",
    displayName: "Asana",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
  },
  {
    id: "twilio",
    displayName: "Twilio",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    aliases: ["twilio-accounts"],
  },
  {
    id: "sendgrid",
    displayName: "SendGrid",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    aliases: ["sendgrid-mail"],
  },
  {
    id: "shopify",
    displayName: "Shopify",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
    aliases: ["shopify-admin", "shopify-storefront"],
  },
  {
    id: "contentful",
    displayName: "Contentful",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
  },
  {
    id: "yelp",
    displayName: "Yelp",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
  },
  {
    id: "datocms",
    displayName: "DatoCMS",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
  },
  {
    id: "braintree",
    displayName: "Braintree",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
  },
  {
    id: "monday",
    displayName: "monday.com",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }],
  },
  {
    id: "wpgraphql",
    displayName: "WPGraphQL",
    supportedKinds: ["graphql"],
    auth: [{ mode: "byo" }],
    setupHints: ["Self-hosted WordPress site — the endpoint host is user-supplied."],
  },
  {
    id: "saleor",
    displayName: "Saleor",
    supportedKinds: ["graphql"],
    auth: [{ mode: "token" }, { mode: "none" }],
    setupHints: ["The public demo endpoint needs no auth; authed queries use a Bearer token."],
  },

  // --- No-auth public demo/reference apps ------------------------------------
  {
    id: "petstore",
    displayName: "Swagger Petstore",
    supportedKinds: ["openapi"],
    auth: [{ mode: "token" }],
    setupHints: ["Public demo API — an api_key header is accepted but not required for reads."],
  },
  {
    id: "countries",
    displayName: "Countries (trevorblades)",
    supportedKinds: ["graphql"],
    auth: [{ mode: "none" }],
  },
  {
    id: "rickandmorty",
    displayName: "Rick and Morty API",
    supportedKinds: ["graphql"],
    auth: [{ mode: "none" }],
  },
  {
    id: "anilist",
    displayName: "AniList",
    supportedKinds: ["graphql"],
    auth: [{ mode: "none" }],
    setupHints: ["Public reads need no auth; mutations require OAuth (not modeled here)."],
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
