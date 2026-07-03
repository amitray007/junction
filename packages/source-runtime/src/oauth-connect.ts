// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth connect flows (increment 29, slice B) — the arctic/fetch-touching
// composition the CLI (D) and web (C) build their `junction connect` /
// "Connect" UI on top of. Exposes:
//   buildAuthorizeUrl   — browser auth-code+PKCE: authorize URL + pending state
//   exchangeCode        — browser auth-code+PKCE: code → NormalizedTokens
//   deviceAuthorize      — RFC 8628: start a device-code flow
//   devicePoll           — RFC 8628: poll the token endpoint once
//   persistOAuthTokens   — write tokens as refs (new credential OR reconnect)
//
// SECURITY: no token (access, refresh, or BYO client_secret) ever appears in
// a return value's error branch, a log, or a thrown value. Only
// persistOAuthTokens ever writes a plaintext token — into the CredentialStore.

import {
  buildAuthorizationParams,
  type Credential,
  CredentialSchema,
  type CredentialStore,
  type DbError,
  err,
  type NormalizedTokens,
  newCredentialId,
  normalizeTokenResponse,
  type OAuthProvider,
  ok,
  type Repositories,
  type Result,
  ResultAsync,
  resolveScopeString,
  toExpiresAt,
} from "@junction/core"
import {
  ArcticFetchError,
  CodeChallengeMethod,
  generateCodeVerifier,
  generateState,
  OAuth2Client,
  OAuth2RequestError,
} from "arctic"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Connect-flow errors. Deliberately small and NEVER carries a token — mirrors
 * RefreshError's discipline (core/oauth/refresh.ts). `detail` is a provider
 * error CODE or a generic constructor name only, never `.message`/`.data`.
 */
export type OAuthConnectError =
  | { kind: "unknown-provider" }
  | { kind: "state-mismatch" }
  | { kind: "exchange-failed"; reason: "invalid_grant" | "transient" | "unknown"; detail?: string }
  | { kind: "device-pending" }
  | { kind: "device-slow-down" }
  | { kind: "device-denied" }
  | { kind: "device-expired" }
  | { kind: "device-not-supported" }
  | { kind: "invalid-input"; reason: string }
  | { kind: "persist-failed"; cause: DbError }

// ---------------------------------------------------------------------------
// buildAuthorizeUrl — browser auth-code + PKCE
// ---------------------------------------------------------------------------

export interface BuildAuthorizeUrlArgs {
  provider: OAuthProvider
  clientId: string
  redirectUri: string
  scopes: string[]
}

export interface BuildAuthorizeUrlResult {
  url: string
  /** CSRF guard — the caller stashes `state → {codeVerifier, providerId, ...}`. */
  state: string
  /** PKCE verifier — the caller stashes this alongside `state`; never persisted. */
  codeVerifier: string
}

/**
 * Build the authorize URL for a browser auth-code+PKCE connect flow. Returns
 * `state` + `codeVerifier` fresh (arctic helpers) so the caller can stash
 * `state → {codeVerifier, providerId, ...}` in its OWN pending-auth store (an
 * in-memory Map in the serve process for web; the ephemeral-listener closure
 * for the CLI — see method file F8). PKCE defaults to S256 unless the
 * provider opts out (`provider.pkce === "disabled"`).
 */
export function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): BuildAuthorizeUrlResult {
  const { provider, clientId, redirectUri, scopes } = args
  const client = new OAuth2Client(clientId, null, redirectUri)
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const params = buildAuthorizationParams(provider, scopes)
  const authorizationUrl =
    typeof provider.authorizationUrl === "string" ? provider.authorizationUrl : undefined

  if (authorizationUrl === undefined) {
    // A fn-shaped authorizationUrl needs connection_config this fn doesn't
    // take — callers building against such a provider must resolve the URL
    // themselves before calling buildAuthorizeUrl. (Day-one tuned entries all
    // have a fixed string URL; only a future {subdomain}-style entry hits this.)
    throw new Error(`${provider.id}: authorizationUrl requires connection_config`)
  }

  const url =
    provider.pkce === "disabled"
      ? client.createAuthorizationURL(authorizationUrl, state, scopes)
      : client.createAuthorizationURLWithPKCE(
          authorizationUrl,
          state,
          CodeChallengeMethod.S256,
          codeVerifier,
          scopes,
        )

  // Apply the catalog's fixed authorizationParams (scope is already on the
  // URL via `scopes`; buildAuthorizationParams also folds defaultScopes into
  // it — reapply the SAME merged scope string here so defaultScopes aren't
  // silently dropped when the catalog adds one arctic didn't see).
  const scopeString = resolveScopeString(provider, [
    ...new Set([...(provider.defaultScopes ?? []), ...scopes]),
  ])
  url.searchParams.set("scope", scopeString)
  for (const [key, value] of Object.entries(params)) {
    if (key === "scope") continue
    url.searchParams.set(key, value)
  }

  return { url: url.toString(), state, codeVerifier }
}

// ---------------------------------------------------------------------------
// exchangeCode — browser auth-code + PKCE: code → tokens
// ---------------------------------------------------------------------------

export interface ExchangeCodeArgs {
  provider: OAuthProvider
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  /** The codeVerifier stashed alongside `state` at buildAuthorizeUrl time. `null` when PKCE is disabled. */
  codeVerifier: string | null
}

/**
 * Exchange an authorization code for tokens. Normalizes via the catalog's
 * `parseTokenResponse` override (e.g. Slack's `{ok:false}`-at-200 rejection)
 * or the default OAuth2 shape. Never lets a token into the error branch.
 */
export async function exchangeCode(
  args: ExchangeCodeArgs,
): Promise<Result<NormalizedTokens, OAuthConnectError>> {
  const { provider, clientId, clientSecret, redirectUri, code, codeVerifier } = args
  const tokenUrl = typeof provider.tokenUrl === "string" ? provider.tokenUrl : undefined
  if (tokenUrl === undefined) {
    return err({ kind: "unknown-provider" })
  }

  const client = new OAuth2Client(clientId, clientSecret, redirectUri)

  try {
    const tokens = await client.validateAuthorizationCode(tokenUrl, code, codeVerifier)
    // normalizeTokenResponse dispatches to the provider's override (Slack
    // rejects {ok:false}) or the default parser — both THROW on a malformed
    // body; catch below maps that the same as any other exchange failure.
    const normalized = normalizeTokenResponse(provider, tokens.data)
    return ok(normalized)
  } catch (cause) {
    return err(mapExchangeFailure(cause))
  }
}

function mapExchangeFailure(cause: unknown): OAuthConnectError {
  if (cause instanceof OAuth2RequestError) {
    if (cause.code === "invalid_grant") {
      return { kind: "exchange-failed", reason: "invalid_grant", detail: cause.code }
    }
    return { kind: "exchange-failed", reason: "unknown", detail: cause.code }
  }
  if (cause instanceof ArcticFetchError) {
    return { kind: "exchange-failed", reason: "transient", detail: cause.constructor.name }
  }
  return {
    kind: "exchange-failed",
    reason: "unknown",
    detail: cause instanceof Error ? cause.constructor.name : "unknown",
  }
}

// ---------------------------------------------------------------------------
// Device authorization grant (RFC 8628) — arctic doesn't implement this;
// junction owns it via fetch. Only offered for providers with a
// deviceAuthorizationUrl (Google, Microsoft, day-one).
// ---------------------------------------------------------------------------

export interface DeviceAuthorizeArgs {
  provider: OAuthProvider
  clientId: string
  scopes: string[]
}

export interface DeviceAuthorizeResult {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Seconds between poll attempts (RFC 8628 §3.2 default 5). */
  intervalSeconds: number
  /** Seconds until the device/user code expires. */
  expiresInSeconds: number
}

/**
 * Start a device-code flow: POST the provider's device authorization
 * endpoint. Only valid for a catalog entry with `deviceAuthorizationUrl` set.
 */
export async function deviceAuthorize(
  args: DeviceAuthorizeArgs,
): Promise<Result<DeviceAuthorizeResult, OAuthConnectError>> {
  const { provider, clientId, scopes } = args
  if (provider.deviceAuthorizationUrl === undefined) {
    return err({ kind: "device-not-supported" })
  }

  const body = new URLSearchParams({
    client_id: clientId,
    scope: resolveScopeString(provider, [
      ...new Set([...(provider.defaultScopes ?? []), ...scopes]),
    ]),
  })

  let raw: unknown
  try {
    const response = await fetch(provider.deviceAuthorizationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    })
    raw = await response.json()
    if (!response.ok) {
      return err({ kind: "exchange-failed", reason: "unknown", detail: `HTTP ${response.status}` })
    }
  } catch (cause) {
    return err({
      kind: "exchange-failed",
      reason: "transient",
      detail: cause instanceof Error ? cause.constructor.name : "unknown",
    })
  }

  const parsed = parseDeviceAuthorizeResponse(raw)
  if (parsed === undefined) {
    return err({ kind: "exchange-failed", reason: "unknown", detail: "malformed device response" })
  }
  return ok(parsed)
}

function parseDeviceAuthorizeResponse(raw: unknown): DeviceAuthorizeResult | undefined {
  // A 200 with a JSON body of literal `null` (or any non-object) passes
  // response.ok but `raw as Record` then `body.device_code` would throw a
  // TypeError — which, called outside the fetch try/catch, escapes
  // deviceAuthorize as a rejection instead of the promised typed error.
  if (raw === null || typeof raw !== "object") return undefined
  const body = raw as Record<string, unknown>
  const deviceCode = body.device_code
  const userCode = body.user_code
  const verificationUri = body.verification_uri ?? body.verification_url
  const expiresIn = body.expires_in
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof expiresIn !== "number"
  ) {
    return undefined
  }
  const interval = typeof body.interval === "number" ? body.interval : 5
  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds: interval,
    expiresInSeconds: expiresIn,
  }
}

export interface DevicePollArgs {
  provider: OAuthProvider
  clientId: string
  clientSecret: string
  deviceCode: string
}

/**
 * Poll the token endpoint ONCE for a device-code flow (grant_type=
 * device_code). The caller owns the poll LOOP (sleeping `intervalSeconds`
 * between calls, backing off on `device-slow-down`, giving up on
 * `device-expired`) — a single-poll primitive keeps the CLI's `--json`
 * headless contract simple (one call, one outcome, no hidden timers).
 */
export async function devicePoll(
  args: DevicePollArgs,
): Promise<Result<NormalizedTokens, OAuthConnectError>> {
  const { provider, clientId, clientSecret, deviceCode } = args
  const tokenUrl = typeof provider.tokenUrl === "string" ? provider.tokenUrl : undefined
  if (tokenUrl === undefined) {
    return err({ kind: "unknown-provider" })
  }

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: clientId,
    client_secret: clientSecret,
  })

  let raw: unknown
  let status: number
  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    })
    status = response.status
    raw = await response.json()
  } catch (cause) {
    return err({
      kind: "exchange-failed",
      reason: "transient",
      detail: cause instanceof Error ? cause.constructor.name : "unknown",
    })
  }

  if (status >= 200 && status < 300) {
    try {
      const normalized = normalizeTokenResponse(provider, raw)
      return ok(normalized)
    } catch (cause) {
      return err({
        kind: "exchange-failed",
        reason: "unknown",
        detail: cause instanceof Error ? cause.constructor.name : "unknown",
      })
    }
  }

  const errorCode = (raw as { error?: unknown } | undefined)?.error
  const code = typeof errorCode === "string" ? errorCode : "unknown"
  switch (code) {
    case "authorization_pending":
      return err({ kind: "device-pending" })
    case "slow_down":
      return err({ kind: "device-slow-down" })
    case "access_denied":
      return err({ kind: "device-denied" })
    case "expired_token":
      return err({ kind: "device-expired" })
    case "invalid_grant":
      return err({ kind: "exchange-failed", reason: "invalid_grant", detail: code })
    default:
      return err({ kind: "exchange-failed", reason: "unknown", detail: code })
  }
}

// ---------------------------------------------------------------------------
// persistOAuthTokens — write tokens as refs; create a new credential row OR
// repoint an existing one (reconnect). Mirrors rotateCredential/refreshIfExpired's
// atomic pattern: store writes FIRST, one DB step, best-effort delete-old.
// ---------------------------------------------------------------------------

export interface PersistOAuthTokensArgs {
  repos: Pick<Repositories, "credentials">
  store: CredentialStore
  tokens: NormalizedTokens
  providerId: string
  authMode: "authorization_code" | "device_code"
  clientId: string
  clientSecret: string
  now: number
  /** Create a new credential row. */
  mode: "create"
  platformId: string
  account: string
}

export interface PersistOAuthTokensUpdateArgs {
  repos: Pick<Repositories, "credentials">
  store: CredentialStore
  tokens: NormalizedTokens
  providerId: string
  authMode: "authorization_code" | "device_code"
  clientId: string
  clientSecret: string
  now: number
  /** Reconnect an EXISTING credential row (repoint its refs). */
  mode: "update"
  credentialId: string
}

/**
 * Persist a connect flow's tokens as CredentialStore refs, either creating a
 * new oauth2 Credential row (`mode: "create"`) or reconnecting an existing
 * one (`mode: "update"`). NEVER logs or returns a token — only the minted ref
 * IDs and metadata are visible past this function.
 *
 * Atomicity (mirrors rotateCredential / refreshIfExpired's success path):
 * mint fresh refs, write ALL new secrets to the store FIRST, then ONE DB
 * step (create or setOAuthTokens); on a DB failure, best-effort delete the
 * just-written new refs and leave any old ones (update mode) untouched.
 */
export function persistOAuthTokens(
  args: PersistOAuthTokensArgs | PersistOAuthTokensUpdateArgs,
): ResultAsync<Credential, OAuthConnectError> {
  // `written` is hoisted so the outer try/catch below can clean up any
  // just-written refs on an UNEXPECTED throw. Belt-and-suspenders: every known
  // fallible step already returns a Result (setAll, create/get/setOAuthTokens),
  // and toExpiresAt now bounds the one RangeError source — but `new
  // ResultAsync(work())` relies on work() never REJECTING (a rejection escapes
  // as an unhandled throw at every await site, not an Err — see
  // refresh-singleflight.ts). The try/catch makes that invariant STRUCTURAL, so
  // a future throw source can't silently reintroduce the escape + orphan refs.
  const { repos, store, tokens, providerId, authMode, clientId, clientSecret, now } = args
  const written: string[] = []

  const work = async (): Promise<Result<Credential, OAuthConnectError>> => {
    const accessRef = newCredentialId()
    const refreshRef = tokens.refreshToken !== undefined ? newCredentialId() : undefined
    const clientIdRef = newCredentialId()
    const clientSecretRef = newCredentialId()

    const setResult = await setAll(
      store,
      [
        [accessRef, tokens.accessToken],
        ...(refreshRef !== undefined && tokens.refreshToken !== undefined
          ? ([[refreshRef, tokens.refreshToken]] as const)
          : []),
        [clientIdRef, clientId],
        [clientSecretRef, clientSecret],
      ],
      written,
    )
    if (setResult.isErr()) {
      await cleanup(store, written)
      return err(setResult.error)
    }

    // Bound the provider-supplied expiry through core's shared guard — a
    // negative value would put expiresAt in the past (refresh storm on a
    // just-connected token) and a non-finite/huge value would overflow the
    // Date range → RangeError. toExpiresAt returns null for any unusable value
    // (connect has no prior expiry to keep — null = non-expiring, the safe
    // default). Shared with the refresh path so the two can't drift.
    const expiresAt = toExpiresAt(now, tokens.expiresInSeconds)

    if (args.mode === "create") {
      // Validate the full shape via CredentialSchema (mirrors addCredential's
      // house pattern) — brands id/platformId and catches a malformed
      // platformId BEFORE it reaches the DB layer, rather than relying on
      // repos.credentials.create's internal parse to be the only guard.
      const credentialParse = CredentialSchema.safeParse({
        id: newCredentialId(),
        platformId: args.platformId,
        profileName: args.account,
        kind: "oauth2",
        secretRef: accessRef,
        oauthMeta: {
          refreshTokenRef: refreshRef,
          clientIdRef,
          clientSecretRef,
          providerId,
          authMode,
          scopes: tokens.scopes,
          expiresAt,
          needsReauth: false,
          obtainedAt: new Date(now).toISOString(),
        },
      })
      if (!credentialParse.success) {
        await cleanup(store, written)
        return err({
          kind: "invalid-input",
          reason: credentialParse.error.issues.map((i) => i.message).join(", "),
        })
      }

      const createResult = await repos.credentials.create(credentialParse.data)
      if (createResult.isErr()) {
        await cleanup(store, written)
        return err({ kind: "persist-failed", cause: createResult.error })
      }
      return ok(createResult.value)
    }

    // mode === "update" — reconnect: repoint an EXISTING credential's refs.
    // Capture the old refs BEFORE the write so we can best-effort clean them
    // up after a successful repoint (mirrors refreshIfExpired's rotation).
    const existingResult = await repos.credentials.get(args.credentialId)
    if (existingResult.isErr()) {
      await cleanup(store, written)
      return err({ kind: "persist-failed", cause: existingResult.error })
    }
    const oldAccessRef = existingResult.value.secretRef
    const oldRefreshRef = existingResult.value.oauthMeta?.refreshTokenRef
    const oldClientIdRef = existingResult.value.oauthMeta?.clientIdRef
    const oldClientSecretRef = existingResult.value.oauthMeta?.clientSecretRef

    const setTokensResult = await repos.credentials.setOAuthTokens(args.credentialId, {
      secretRef: accessRef,
      ...(refreshRef !== undefined ? { refreshTokenRef: refreshRef } : {}),
      clientIdRef,
      clientSecretRef,
      providerId,
      authMode,
      scopes: tokens.scopes,
      expiresAt,
      needsReauth: false,
      obtainedAt: new Date(now).toISOString(),
    })
    if (setTokensResult.isErr()) {
      await cleanup(store, written)
      return err({ kind: "persist-failed", cause: setTokensResult.error })
    }

    // Repoint succeeded — best-effort delete the OLD refs (never the new ones).
    await cleanup(
      store,
      [
        oldAccessRef,
        refreshRef !== undefined ? oldRefreshRef : undefined,
        oldClientIdRef,
        oldClientSecretRef,
      ].filter((ref): ref is string => typeof ref === "string"),
    )

    return ok(setTokensResult.value)
  }

  // Guard: work() must settle to a Result, never reject (the neverthrow
  // invariant new ResultAsync relies on). On any unexpected throw, best-effort
  // clean up refs already written to the store and surface a typed Err — never
  // an escaped rejection, never an orphaned secret.
  const guarded = work().catch(async (): Promise<Result<Credential, OAuthConnectError>> => {
    await cleanup(store, written)
    return err({ kind: "persist-failed", cause: { kind: "query-failed", cause: "unexpected" } })
  })

  return new ResultAsync(guarded)
}

/** Write every [ref, value] pair to the store, stopping at the first failure. */
async function setAll(
  store: CredentialStore,
  pairs: readonly (readonly [string, string])[],
  written: string[],
): Promise<Result<void, OAuthConnectError>> {
  for (const [ref, value] of pairs) {
    const result = await store.set(ref, value)
    if (result.isErr()) {
      return err({ kind: "persist-failed", cause: { kind: "query-failed", cause: result.error } })
    }
    written.push(ref)
  }
  return ok(undefined)
}

/** Best-effort delete of a list of store refs — never throws, never rejects. */
async function cleanup(store: CredentialStore, refs: readonly string[]): Promise<void> {
  for (const ref of refs) {
    try {
      await store.delete(ref)
    } catch {
      // swallow — best-effort cleanup, mirrors rotateCredential/refreshIfExpired
    }
  }
}
