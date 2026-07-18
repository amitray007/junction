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
  /**
   * Concrete, resolved URLs only (increment 44 — the `(cfg) => string`
   * per-tenant function form was removed as dead code: the refresh path
   * (source-runtime's `resolveTokenUrl`) and connect's `buildAuthorizeUrl`
   * both already refused it, and no catalog entry ever used it. A custom
   * design for a per-tenant provider takes the user's own resolved URL
   * (e.g. `https://acme.okta.com/oauth2/v1/token`) as a plain string.
   */
  authorizationUrl: string
  tokenUrl: string
  /** RFC 8628 device endpoint. Presence = device-code flow is offered for this provider. */
  deviceAuthorizationUrl?: string
  /** "plain" added in increment 44 — arctic supports CodeChallengeMethod.Plain. */
  pkce: "S256" | "plain" | "disabled"
  scopeSeparator: " " | "," | "+"
  authorizationParams?: Record<string, string>
  /**
   * increment 44 — `tokenAuthMethod`/`bodyFormat` were removed as inert dead
   * fields: arctic (the runtime executor) always sends HTTP Basic client
   * auth when a client secret is present, and always sends a form-encoded
   * token request body, ignoring both. A provider whose token endpoint
   * rejects HTTP Basic needs a hand-rolled token client — see
   * docs/futures/revisit-when.md.
   */
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
    // Internal parser behind normalizeTokenResponse's documented @throws contract; the catch lives
    // in a DIFFERENT package (source-runtime/oauth-connect.ts), which converts to a typed Result.
    // nosemgrep: no-bare-throw-in-core -- category 4 (documented-@throws contract): caught + Result-converted by the consuming package, source-runtime/oauth-connect.ts
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
    // Same documented-@throws contract as defaultParseTokenResponse above (via normalizeTokenResponse).
    // nosemgrep: no-bare-throw-in-core -- category 4 (documented-@throws contract): caught + Result-converted by the consuming package, source-runtime/oauth-connect.ts
    throw new Error(`slack: ${body.error ?? "unknown error"}`)
  }
  const accessToken = body.access_token ?? body.authed_user?.access_token
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // nosemgrep: no-bare-throw-in-core -- category 4 (documented-@throws contract), same as above: caught + Result-converted in source-runtime/oauth-connect.ts
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
 *
 * @throws {Error} if the response is not a usable token payload (missing
 * access_token, or a provider-signaled in-body error via a custom
 * `parseTokenResponse` override). This is a documented-throwing contract: the consuming
 * wrapper (source-runtime/oauth-connect.ts) catches and converts to a typed
 * Result<Credential, OAuthConnectError>. Any future core-internal caller on
 * a Result-typed path must do the same — wrap the call in try/catch and
 * convert; never let this throw cross a Result boundary uncaught.
 */
export function normalizeTokenResponse(provider: OAuthProvider, raw: unknown): NormalizedTokens {
  if (provider.parseTokenResponse) return provider.parseTokenResponse(raw)
  return defaultParseTokenResponse(provider, raw)
}
