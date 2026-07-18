// SPDX-License-Identifier: AGPL-3.0-only
// The arctic-backed RefreshTokenFn (increment 29, slice B) — replaces the
// resolve-provider.ts placeholder. This is the ONLY place a provider refresh
// HTTP call is made; core's refreshIfExpired (the orchestrator) injects this
// fn and never makes the call itself, keeping core HTTP-free.
//
// SECURITY: never let a token reach `detail` or a log. `detail` may only
// carry a provider error CODE or a short generic string — never `.message`
// on an unknown/thrown error (arctic's own accessor-throw messages are safe
// generic strings, e.g. "Missing or invalid 'access_token' field", but any
// OTHER thrown value is treated as opaque and never stringified), never
// `.data` (arctic's raw response — carries tokens), never
// `JSON.stringify(err)`. Map failures via `.code` / `.constructor.name` only.

import { getProvider, type RefreshResult, type RefreshTokenFn } from "@junction/core"
import { ArcticFetchError, OAuth2Client, OAuth2RequestError } from "arctic"

/**
 * Resolve a provider's token endpoint to a plain string, or `undefined` if
 * it's unset (increment 44 — `tokenUrl` is a concrete string; the fn-shaped
 * per-tenant form was removed as dead code — see catalog.ts). Only the
 * "generic" catalog placeholder is ever empty before a connect descriptor
 * fills it in.
 */
function resolveTokenUrl(tokenUrl: string): string | undefined {
  return tokenUrl.length > 0 ? tokenUrl : undefined
}

/**
 * The arctic-backed RefreshTokenFn: implements the injected HTTP call that
 * core's refreshIfExpired orchestrates. HARD-FAILS (never throws) on an
 * empty or unknown providerId — the orchestrator relies on this to route
 * straight to `needs-reauth`/`refresh-failed` rather than attempt a refresh
 * with no valid catalog entry to guide it.
 */
export const oauthRefreshFn: RefreshTokenFn = async (args) => {
  const providerId = args.providerId.trim()
  if (providerId.length === 0) {
    return { ok: false, reason: "unknown", detail: "empty providerId" }
  }

  const provider = getProvider(providerId)
  if (provider === undefined) {
    return { ok: false, reason: "unknown", detail: "unknown provider" }
  }

  const tokenUrl = resolveTokenUrl(provider.tokenUrl)
  if (tokenUrl === undefined) {
    return { ok: false, reason: "unknown", detail: "token endpoint unresolvable" }
  }

  const client = new OAuth2Client(args.clientId, args.clientSecret, null)

  let tokens: Awaited<ReturnType<typeof client.refreshAccessToken>>
  try {
    // Empty scopes: keep whatever scopes were already granted rather than
    // re-request a (possibly narrower) set.
    tokens = await client.refreshAccessToken(tokenUrl, args.refreshToken, [])
  } catch (cause) {
    return mapRefreshFailure(cause)
  }

  // Guarded accessor reads — arctic's OAuth2Tokens THROWS on an absent field.
  // accessToken() is REQUIRED by a successful refresh response; if it's
  // absent the response is malformed, not a token to trust.
  let accessToken: string
  try {
    accessToken = tokens.accessToken()
  } catch {
    return { ok: false, reason: "unknown", detail: "refresh response missing access_token" }
  }

  const refreshToken = tokens.hasRefreshToken() ? tokens.refreshToken() : undefined

  let expiresInSeconds: number | undefined
  try {
    expiresInSeconds = tokens.accessTokenExpiresInSeconds()
  } catch {
    expiresInSeconds = undefined
  }

  const scopes = tokens.hasScopes() ? tokens.scopes() : undefined

  return {
    ok: true,
    tokens: { accessToken, refreshToken, expiresInSeconds, scopes },
  }
}

/**
 * Map an arctic refresh-call failure to a typed, tokenless RefreshResult.
 * `detail` is provider-error-CODE or a generic constructor name only — never
 * `.message` (could echo request/response fragments) and never `.data`.
 */
function mapRefreshFailure(cause: unknown): RefreshResult {
  if (cause instanceof OAuth2RequestError) {
    if (cause.code === "invalid_grant") {
      return { ok: false, reason: "invalid_grant", detail: cause.code }
    }
    return { ok: false, reason: "unknown", detail: cause.code }
  }
  // ArcticFetchError (a network/fetch-level failure) is transient → keep the
  // old tokens and retry. Use `instanceof` (the documented, robust check) not a
  // constructor.name string-match, which a minifier/bundler or a cross-realm
  // error could break — misclassifying a genuine network blip as "unknown".
  // (`detail` stays the class name — a leak-safe diagnostic label, never the cause.)
  if (cause instanceof ArcticFetchError) {
    return { ok: false, reason: "transient", detail: "ArcticFetchError" }
  }
  return {
    ok: false,
    reason: "unknown",
    detail: cause instanceof Error ? cause.constructor.name : "unknown",
  }
}
