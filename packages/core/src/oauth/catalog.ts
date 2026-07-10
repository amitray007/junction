// SPDX-License-Identifier: AGPL-3.0-only
// OAuth provider catalog — the "just works" heart of increment 29.
// A Nango-shaped registry: mostly defaults + the handful of per-provider
// overrides research shows each divergent provider needs. Divergence is DATA,
// not branching code — everything here is pure (no HTTP, no I/O); the
// arctic/fetch calls that use this catalog live in source-runtime.

// The fixed loopback callback URI the user pre-registers in their OAuth app —
// single source of truth shared with the web connect flow's redirect_uri (they
// must be byte-identical or the registered redirect won't match). See config.
import { OAUTH_CALLBACK_URI } from "../config/index.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A transient, in-memory, normalized token shape returned by parsing a
 * provider's token-endpoint HTTP response. NOT arctic's type (arctic isn't a
 * core dependency — core stays HTTP-free). Carries token VALUES, but only as
 * a parse result held for the duration of a connect/refresh call — nothing
 * here is persisted or logged; persistence goes through refs
 * (see OAuthMetaSchema / setOAuthTokens).
 */
export interface NormalizedTokens {
  accessToken: string
  /** Absent → the provider didn't rotate the refresh token; keep the old one (e.g. Google). */
  refreshToken?: string
  /** Seconds until expiry, from the response's `expires_in`. */
  expiresInSeconds?: number
  scopes?: string[]
}

export interface OAuthProvider {
  id: string
  displayName: string
  /** Catalog-supplied for tuned providers; a function for {subdomain}-style connection_config. */
  authorizationUrl: string | ((cfg: Record<string, string>) => string)
  tokenUrl: string | ((cfg: Record<string, string>) => string)
  /** RFC 8628 device endpoint. Presence = device-code flow is offered for this provider. */
  deviceAuthorizationUrl?: string
  pkce: "S256" | "disabled"
  scopeSeparator: " " | "," | "+"
  authorizationParams?: Record<string, string>
  tokenAuthMethod: "client_secret_basic" | "client_secret_post" | "none"
  bodyFormat: "form" | "json"
  expiryStrategy: "expires_in" | "expires_at" | "none"
  /** Override the default token-response parse (e.g. Slack's {ok:false}-at-200). */
  parseTokenResponse?: (raw: unknown) => NormalizedTokens
  redirectMode: "loopback-fixed" | "loopback-ephemeral"
  defaultScopes?: string[]
  /** The "guided BYO client" text — exact redirect URI + scopes to register, plus docs. */
  registrationHint: { redirectUri: string; scopes: string; docsUrl: string }
  supportsRefresh: boolean
  /**
   * A stable identity/token-introspection GET — bearer the access token at
   * this URL to prove the token is live (Test Connection, increment 29.1).
   * DATA ONLY: the catalog stays pure/HTTP-free; the actual `fetch` call
   * lives in source-runtime's verifyCredential. Absent for "generic"
   * (user-supplied provider — no stable endpoint junction can assume).
   */
  userinfoUrl?: string
  /** Non-auth headers the userinfo GET needs beyond `Authorization: Bearer <token>` (e.g. GitHub's User-Agent, Notion's Notion-Version). */
  userinfoHeaders?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Default token-response parser — standard OAuth2 {access_token, refresh_token?,
// expires_in?, scope?}. This is the ONE place the default-vs-override split lives.
// ---------------------------------------------------------------------------

function defaultParseTokenResponse(provider: OAuthProvider, raw: unknown): NormalizedTokens {
  const body = raw as Record<string, unknown>
  const accessToken = body.access_token
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // Internal parser: caught + converted to a typed Result at the source-runtime/oauth-connect.ts boundary.
    // nosemgrep: no-bare-throw-in-core -- caught by oauth-connect.ts's try/catch, converted to a typed Result there
    throw new Error(`${provider.id}: token response missing access_token`)
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : undefined
  const expiresInSeconds = typeof body.expires_in === "number" ? body.expires_in : undefined
  const scope = typeof body.scope === "string" ? body.scope : undefined
  const scopes = scope ? scope.split(provider.scopeSeparator) : undefined
  return { accessToken, refreshToken, expiresInSeconds, scopes }
}

/**
 * Slack's token endpoint always returns HTTP 200 — a failed exchange is
 * signaled by `{ok:false, error:"..."}` in the BODY, which arctic (and every
 * generic OAuth2 client) will happily treat as a success. Reject it here so
 * the failure surfaces as a typed error, not a "successful" empty token.
 *
 * Slack's v2 OAuth response nests the bot token at the top level
 * (`access_token`) and the user token under `authed_user.access_token`. For
 * junction's purposes (a single bearer credential per connect) we normalize
 * to the top-level `access_token`, falling back to `authed_user.access_token`
 * when the top-level one is absent (e.g. a user-token-only app config).
 */
function parseSlackTokenResponse(raw: unknown): NormalizedTokens {
  const body = raw as {
    ok?: boolean
    error?: string
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    authed_user?: { access_token?: string }
  }
  if (body.ok === false) {
    // Same escape hatch as defaultParseTokenResponse above.
    // nosemgrep: no-bare-throw-in-core -- caught by oauth-connect.ts's try/catch, converted to a typed Result there
    throw new Error(`slack: ${body.error ?? "unknown error"}`)
  }
  const accessToken = body.access_token ?? body.authed_user?.access_token
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // nosemgrep: no-bare-throw-in-core -- same escape hatch as above, caught by oauth-connect.ts's try/catch
    throw new Error("slack: token response missing access_token")
  }
  return {
    accessToken,
    refreshToken: body.refresh_token,
    expiresInSeconds: body.expires_in,
    // Slack's scope separator is a comma, not a space (see the "slack"
    // catalog entry's scopeSeparator) — this parser is Slack-specific so the
    // separator is hardcoded here rather than threaded through as a param.
    scopes: body.scope ? body.scope.split(",") : undefined,
  }
}

// ---------------------------------------------------------------------------
// The catalog — day-one tuned entries + the generic escape hatch.
// ---------------------------------------------------------------------------

const PROVIDERS: readonly OAuthProvider[] = [
  {
    id: "google",
    displayName: "Google",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    deviceAuthorizationUrl: "https://oauth2.googleapis.com/device/code",
    pkce: "S256",
    scopeSeparator: " ",
    // access_type:offline + prompt:consent are REQUIRED or Google never issues
    // a refresh token (only on first consent otherwise).
    authorizationParams: { access_type: "offline", prompt: "consent" },
    tokenAuthMethod: "client_secret_basic",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    // Desktop-app pattern: no fixed registered redirect, a per-flow ephemeral
    // loopback port (RFC 8252).
    redirectMode: "loopback-ephemeral",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: "http://127.0.0.1:<ephemeral-port>/",
      scopes: "offline access requires access_type=offline + prompt=consent (handled by junction)",
      docsUrl: "https://developers.google.com/identity/protocols/oauth2",
    },
    // Google's OpenID Connect userinfo endpoint — a plain bearer GET, no
    // extra headers. Dogfooded this session: a stored Google token
    // authenticated against it with a 200.
    userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
  },
  {
    // GitHub OAuth App: token never expires, no refresh — the historical
    // GitHub OAuth flow. GitHub added mandatory PKCE (S256) for OAuth Apps in
    // July 2025 (confirmed against GitHub's OAuth Apps docs, inc 30 research)
    // — S256 here is correct and required, not just harmlessly accepted.
    id: "github",
    displayName: "GitHub",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_basic",
    // GitHub's token endpoint defaults to form-encoded responses unless asked
    // for JSON via an Accept header — that's an HTTP-layer concern (B), not a
    // catalog concern. `bodyFormat` here describes the REQUEST body shape.
    bodyFormat: "form",
    expiryStrategy: "none",
    redirectMode: "loopback-fixed",
    supportsRefresh: false,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "repo read:user (adjust per platform)",
      docsUrl: "https://docs.github.com/en/apps/oauth-apps",
    },
    // GitHub's REST API requires a User-Agent on every request (undocumented
    // reject-if-missing behavior in practice) and recommends the versioned
    // Accept header. Dogfooded this session: a stored GitHub gho_ token
    // authenticated against this endpoint with a 200.
    userinfoUrl: "https://api.github.com/user",
    userinfoHeaders: {
      Accept: "application/vnd.github+json",
      "User-Agent": "junction",
    },
  },
  {
    // GitHub App (as opposed to OAuth App): tokens rotate/expire and refresh
    // is supported. Modeled as a separate catalog entry rather than a variant
    // flag on "github" — the two are registered as different app types on
    // GitHub's side with different token lifecycles, so a single entry with a
    // boolean would just move the branching into the catalog anyway.
    id: "github-app",
    displayName: "GitHub App",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_basic",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "permissions are configured on the GitHub App itself, not via scopes",
      docsUrl: "https://docs.github.com/en/apps/creating-github-apps",
    },
    // Same identity endpoint as the "github" OAuth App entry — a GitHub App
    // user-to-server token authenticates against /user the same way.
    userinfoUrl: "https://api.github.com/user",
    userinfoHeaders: {
      Accept: "application/vnd.github+json",
      "User-Agent": "junction",
    },
  },
  {
    id: "slack",
    displayName: "Slack",
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    pkce: "S256",
    scopeSeparator: ",",
    tokenAuthMethod: "client_secret_post",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    parseTokenResponse: parseSlackTokenResponse,
    redirectMode: "loopback-fixed",
    // Only true when the workspace/app has token rotation enabled — junction
    // can't detect this ahead of time; a refresh attempt with no refresh
    // token on file simply no-ops (needsReauth is not forced).
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "channels:read,chat:write (comma-separated; adjust per platform)",
      docsUrl: "https://api.slack.com/authentication/oauth-v2",
    },
    // auth.test: confirms the token is live and identifies the bot/user +
    // team. Slack's usual 200-with-{ok:false} pattern applies here too — the
    // identity-check branch in source-runtime must reject ok:false at 200,
    // same as parseSlackTokenResponse above.
    userinfoUrl: "https://slack.com/api/auth.test",
  },
  {
    id: "microsoft",
    displayName: "Microsoft",
    authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    deviceAuthorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_post",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    // Microsoft wants offline_access in the SCOPE list (not an authorization
    // param) or no refresh token is issued — encoded as a default scope
    // rather than an authorizationParams entry.
    defaultScopes: ["offline_access"],
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "offline_access is added automatically by junction",
      docsUrl: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    },
    // Microsoft Graph "me". A plain bearer GET; needs a User.Read-class scope —
    // if the connected token lacks it this 403s, which the verifier maps to
    // auth-failed (honest: junction can't confirm the token that way).
    userinfoUrl: "https://graph.microsoft.com/v1.0/me",
  },
  {
    id: "notion",
    displayName: "Notion",
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_basic",
    bodyFormat: "json",
    // Notion tokens don't currently expire, so there's nothing to refresh.
    expiryStrategy: "none",
    redirectMode: "loopback-fixed",
    supportsRefresh: false,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "Notion scopes are configured on the integration itself, not via the authorize URL",
      docsUrl: "https://developers.notion.com/docs/authorization",
    },
    // Notion "get self" — a bearer GET that requires the Notion-Version header
    // (the API rejects requests without it). Version pinned to a current, stable
    // release; bump when Notion deprecates it.
    userinfoUrl: "https://api.notion.com/v1/users/me",
    userinfoHeaders: { "Notion-Version": "2022-06-28" },
  },
  {
    id: "atlassian",
    displayName: "Atlassian",
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    pkce: "S256",
    scopeSeparator: " ",
    authorizationParams: { audience: "api.atlassian.com", prompt: "consent" },
    tokenAuthMethod: "client_secret_post",
    bodyFormat: "json",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    // The {subdomain}/site connection_config (which Jira/Confluence site to
    // hit) is a per-connection concern resolved at connect time, not an
    // endpoint the catalog carries.
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "read:jira-work offline_access (adjust per product)",
      docsUrl: "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
    },
    // NO userinfoUrl: Atlassian's identity endpoint (`api.atlassian.com/me`)
    // needs the `read:me` scope AND the "User Identity API" enabled in the dev
    // console — neither of which junction's connect flow requests/guarantees.
    // A userinfo check that 403s for a validly-connected token would be a
    // misleading auth-failed, so we omit it and let Test Connection fall
    // through to the source-verify / not-verifiable (honest > confidently wrong).
  },
  {
    // Discord OAuth2 — standard authorization-code flow, PKCE S256, refresh
    // supported. Authorize/token URLs confirmed against Discord's OAuth2 docs
    // (inc 30 research).
    id: "discord",
    displayName: "Discord",
    authorizationUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_post",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "identify email (adjust per platform)",
      docsUrl: "https://discord.com/developers/docs/topics/oauth2",
    },
    // Discord's own-identity endpoint — a plain bearer GET.
    userinfoUrl: "https://discord.com/api/users/@me",
  },
  {
    // Spotify Accounts service — standard authorization-code flow, PKCE S256,
    // refresh supported. Confirmed against Spotify's Authorization Code docs.
    id: "spotify",
    displayName: "Spotify",
    authorizationUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_basic",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "user-read-email user-read-private (adjust per platform)",
      docsUrl: "https://developer.spotify.com/documentation/web-api/tutorials/code-flow",
    },
    userinfoUrl: "https://api.spotify.com/v1/me",
  },
  {
    // Zoom OAuth2 — standard authorization-code flow, PKCE S256, refresh
    // supported. Confirmed against Zoom's OAuth docs.
    id: "zoom",
    displayName: "Zoom",
    authorizationUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_basic",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "user:read:user (adjust per platform)",
      docsUrl: "https://developers.zoom.us/docs/integrations/oauth/",
    },
    userinfoUrl: "https://api.zoom.us/v2/users/me",
  },
  {
    // Dropbox OAuth2 — standard authorization-code flow, PKCE S256, refresh
    // supported. NOTE the token host is api.dropboxapi.com, NOT
    // api.dropbox.com (confirmed against Dropbox's OAuth guide).
    id: "dropbox",
    displayName: "Dropbox",
    authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_basic",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "account_info.read files.content.read (adjust per platform)",
      docsUrl: "https://developers.dropbox.com/oauth-guide",
    },
    userinfoUrl: "https://api.dropboxapi.com/2/users/get_current_account",
  },
  {
    // Linear OAuth 2.1 (DCR) — also accepts a bearer PAT, but this entry
    // covers the OAuth path. Confirmed against Linear's MCP/OAuth docs.
    id: "linear",
    displayName: "Linear",
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_post",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "read write issues:create (adjust per platform)",
      docsUrl: "https://linear.app/docs/mcp",
    },
    // Linear's GraphQL "viewer" query is the identity check, not a REST GET —
    // no stable bearer-GET userinfo endpoint to assume here (honest > guessed).
  },
  {
    // GitLab.com OAuth2 — standard authorization-code flow, PKCE S256,
    // refresh supported. Confirmed against GitLab's OAuth2 docs.
    id: "gitlab",
    displayName: "GitLab",
    authorizationUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_post",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "read_user read_api read_repository (adjust per platform)",
      docsUrl: "https://docs.gitlab.com/ee/api/oauth2.html",
    },
    userinfoUrl: "https://gitlab.com/api/v4/user",
  },
  {
    // Figma OAuth2 — standard authorization-code flow, PKCE S256, refresh
    // supported. Token host is api.figma.com, NOT figma.com (confirmed
    // against Figma's OAuth docs). NOTE: the Figma Dev Mode MCP server itself
    // uses NO credential (trusts the local desktop app) — this OAuth entry is
    // for the REST API vault path, a separate connection from that MCP.
    id: "figma",
    displayName: "Figma",
    authorizationUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_post",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "file_content:read current_user:read (files:read is deprecated)",
      docsUrl: "https://www.figma.com/developers/api#oauth2",
    },
    userinfoUrl: "https://api.figma.com/v1/me",
  },
  {
    // The escape hatch: user supplies authorizationUrl/tokenUrl (and scopes)
    // when registering a generic-oauth2 platform; the catalog entry carries
    // sensible defaults and placeholder (empty) endpoints — the connection
    // descriptor fills them in from user input at connect time.
    id: "generic",
    displayName: "Generic OAuth2",
    authorizationUrl: "",
    tokenUrl: "",
    pkce: "S256",
    scopeSeparator: " ",
    tokenAuthMethod: "client_secret_basic",
    bodyFormat: "form",
    expiryStrategy: "expires_in",
    redirectMode: "loopback-fixed",
    supportsRefresh: true,
    registrationHint: {
      redirectUri: OAUTH_CALLBACK_URI,
      scopes: "user-supplied — see the platform's own OAuth documentation",
      docsUrl: "",
    },
  },
]

const PROVIDERS_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/** Catalog lookup by provider id. */
export function getProvider(id: string): OAuthProvider | undefined {
  return PROVIDERS_BY_ID.get(id)
}

/** All catalog entries, for the web provider picker. */
export function listProviders(): OAuthProvider[] {
  return [...PROVIDERS]
}

/** Join scopes with the provider's separator. */
export function resolveScopeString(provider: OAuthProvider, scopes: string[]): string {
  return scopes.join(provider.scopeSeparator)
}

/**
 * Build the authorization-request query params for a provider: the catalog's
 * fixed `authorizationParams` merged with the assembled scope string. Purely
 * catalog-derived — per-flow params (client_id, redirect_uri, state, PKCE
 * challenge) are NOT catalog concerns; the connect flow (B) adds those.
 *
 * Scopes are DEDUPED: a caller may pass a scope that's already one of the
 * provider's `defaultScopes` (e.g. explicitly requesting Microsoft's
 * `offline_access`, which junction also adds by default) — duplicates are
 * RFC-idempotent so this isn't a correctness bug, but dedupe removes the
 * sharp edge of a doubled-up scope string.
 */
export function buildAuthorizationParams(
  provider: OAuthProvider,
  scopes: string[],
): Record<string, string> {
  const allScopes = [...new Set([...(provider.defaultScopes ?? []), ...scopes])]
  return {
    ...provider.authorizationParams,
    scope: resolveScopeString(provider, allScopes),
  }
}

/**
 * Normalize a provider's raw token-endpoint response into NormalizedTokens.
 * Dispatches to the provider's `parseTokenResponse` override if present, else
 * the default OAuth2 `{access_token, refresh_token?, expires_in?, scope?}`
 * parser. This is the ONE place the default-vs-override split lives.
 */
export function normalizeTokenResponse(provider: OAuthProvider, raw: unknown): NormalizedTokens {
  if (provider.parseTokenResponse) return provider.parseTokenResponse(raw)
  return defaultParseTokenResponse(provider, raw)
}
