// SPDX-License-Identifier: AGPL-3.0-only
// Server-only OAuth connect helpers (increment 29, slice C) — the ONLY web
// module that imports @junction/source-runtime's connect engine. Called
// exclusively from oauth-connect.functions.ts createServerFn handlers.
//
// SECURITY (metadata-only, mirrors mutations.server.ts's discipline): every
// return here is `{authorizeUrl}` or a credential DTO — NEVER the state,
// codeVerifier, client_secret, access token, or refresh token. Those live
// ONLY in the pending-auth Map (server memory) and the CredentialStore.

import {
  type AppSurface,
  createCredentialStore,
  createRepositories,
  getCatalogEntry,
  getPaths,
  getProvider,
  loadCustomDesigns,
  mergeDesigns,
  OAUTH_CALLBACK_URI,
  type Platform,
  type PlatformInput,
  planConnect,
  resolveOAuthProviderId,
} from "@junction/core"
import {
  assemblePlatform,
  buildAuthorizeUrl,
  type ConnectError,
  checkCollision,
  exchangeCode,
  type OAuthConnectError,
  persistOAuthTokens,
} from "@junction/source-runtime"
import { putPending, takePending } from "./pending-auth.server.js"
import { getDb } from "./shared.server.js"

// The registered redirect for ALL web-connected providers — the running
// `junction web` server's fixed loopback callback route. Sourced from core's
// OAUTH_CALLBACK_URI so it stays byte-identical to the registrationHint the
// catalog prints to the user for BYO client registration (a divergence would
// break the pre-registered redirect). The web server warns if PORT != the
// default port this URI encodes (see serve.mjs).
const WEB_REDIRECT_URI = OAUTH_CALLBACK_URI

// ---------------------------------------------------------------------------
// startConnect — new credential (mode:create)
// ---------------------------------------------------------------------------

export interface StartConnectInput {
  providerId: string
  clientId: string
  clientSecret: string
  scopes: string[]
  account: string
  /**
   * The raw `/credentials` OAuth flow (ConnectOAuthDialog picks an EXISTING
   * platform from a dropdown — there is no catalog surface to re-derive from)
   * supplies platformId directly. EXACTLY ONE of `platformId` /
   * `surfaceSelector` must be present — see the trust-boundary note below.
   */
  platformId?: string
  /**
   * SECURITY (post-38 fix — trust boundary): a catalog-originated connect
   * (connect-panel.tsx's guided oauth2 mode) supplies ONLY this minimal
   * SELECTOR (appId + surfaceKind + authMode) — never an assembled
   * platformInput. `startConnect` re-runs the SAME server-authoritative
   * `planConnect` path that `connectSurfaceFn` uses (keyed by this selector)
   * to RE-DERIVE platformInput/platformId/displayName from the catalog here,
   * on the server. This is what makes the pending-auth "server-authoritative,
   * not client-controlled" claim actually true: nothing about the assembled
   * connection (baseUrl/specUrl/endpoint/descriptor) is ever accepted from
   * the client at this boundary. When present, `startConnect` pre-checks a
   * platform-kind collision against the RE-DERIVED platformId BEFORE
   * redirecting to the OAuth provider — never strand a completed OAuth grant
   * with nowhere to bind.
   */
  surfaceSelector?: { appId: string; surfaceKind: string; authMode: "oauth2" | "token" | "byo" }
}

export type StartConnectResult =
  | { ok: true; authorizeUrl: string }
  | { ok: false; error: string }
  | { ok: false; conflict: { existingKind: string } }

export async function startConnect(input: StartConnectInput): Promise<StartConnectResult> {
  const provider = getProvider(input.providerId)
  if (provider === undefined) {
    return { ok: false, error: "unknown-provider" }
  }

  // Re-derive the authoritative platformId/platformInput/displayName from the
  // catalog — see the surfaceSelector doc comment above for why this can
  // never be trusted from the client.
  let platformId: string
  let surfacePlatform: { platformInput: PlatformInput; displayName: string } | undefined

  if (input.surfaceSelector !== undefined) {
    const derived = derivePlatformFromSelector(input.surfaceSelector)
    if (derived === undefined) {
      return { ok: false, error: "unknown-surface" }
    }
    platformId = derived.platformId
    if (derived.platformInput !== undefined) {
      surfacePlatform = { platformInput: derived.platformInput, displayName: derived.displayName }
    }
  } else if (input.platformId !== undefined) {
    platformId = input.platformId
  } else {
    return { ok: false, error: "platformId or surfaceSelector is required" }
  }

  // Increment 38 D2 — collision pre-check BEFORE the redirect, when a surface
  // payload is present. A platform-kind conflict must fail early: sending the
  // user to the OAuth provider and only discovering the conflict at callback
  // would strand a completed grant with nowhere to bind (the credential path
  // already checks at write time; oauth2 needs the SAME guard before the
  // round-trip, plus a re-check at callback since state may change meanwhile).
  if (surfacePlatform !== undefined) {
    const db = await getDb()
    if (db === null) return { ok: false, error: "Database unavailable" }
    const repos = createRepositories(db)
    const collision = await checkCollision(repos, platformId, surfacePlatform.platformInput.kind)
    if (collision.isErr()) {
      return mapCollisionError(collision.error)
    }
  }

  const { url, state, codeVerifier } = buildAuthorizeUrl({
    provider,
    clientId: input.clientId,
    redirectUri: WEB_REDIRECT_URI,
    scopes: input.scopes,
  })

  putPending(state, {
    codeVerifier: provider.pkce === "disabled" ? null : codeVerifier,
    providerId: input.providerId,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes: input.scopes,
    createdAt: Date.now(),
    intent: {
      mode: "create",
      platformId,
      account: input.account,
      ...(surfacePlatform !== undefined ? { surfacePlatform } : {}),
    },
  })

  // Metadata only — state/codeVerifier/clientSecret stay server-side in the
  // pending-auth Map; the browser only ever sees the authorize URL.
  return { ok: true, authorizeUrl: url }
}

/**
 * Re-run planConnect server-side (the SAME authoritative path connectSurfaceFn
 * uses) keyed by the client's minimal selector, to produce the platformId +
 * (when the recipe supports it) the platformInput/displayName. Returns
 * undefined for an unknown appId/surfaceKind, or when the selector's authMode
 * doesn't resolve to an "oauth-handoff" plan (a mismatched/forged authMode —
 * fail closed rather than trust the client's claim that this is an oauth2
 * surface).
 */
function derivePlatformFromSelector(selector: {
  appId: string
  surfaceKind: string
  authMode: "oauth2" | "token" | "byo"
}):
  | { platformId: string; platformInput: PlatformInput | undefined; displayName: string }
  | undefined {
  const entry = getCatalogEntry(selector.appId)
  if (entry === undefined || entry.surfaces === undefined) return undefined
  const surface: AppSurface | undefined = entry.surfaces.find(
    (s) => s.kind === selector.surfaceKind,
  )
  if (surface === undefined) return undefined

  const plan = planConnect(entry, surface, { authMode: selector.authMode })
  if (!("path" in plan) || plan.path !== "oauth-handoff") return undefined

  return {
    platformId: plan.platformId,
    platformInput: plan.platformInput,
    displayName: plan.displayName,
  }
}

/** Map a checkCollision ConnectError to a StartConnectResult — never a token/secret. */
function mapCollisionError(error: ConnectError): StartConnectResult {
  if (error.kind === "platform-kind-conflict") {
    return { ok: false, conflict: { existingKind: error.existingKind } }
  }
  return { ok: false, error: "Failed to check for an existing platform" }
}

// ---------------------------------------------------------------------------
// startReconnect — re-run connect for an existing needsReauth credential
// (mode:update). Reads providerId/scopes from the credential's own oauthMeta
// so the reconnect targets the SAME provider/platform; BYO client creds are
// re-entered (arctic's OAuth2Client needs them fresh — they are not re-read
// from the old clientIdRef/clientSecretRef here, matching the CLI's reconnect
// contract of re-prompting for client creds on reconnect).
// ---------------------------------------------------------------------------

export interface StartReconnectInput {
  credentialId: string
  /**
   * BYO client creds — OPTIONAL. Omitted (the default) → reconnect REUSES the
   * credential's already-stored client_id/secret (read server-side from the
   * store, never re-typed). Supplied → swap to a DIFFERENT OAuth app (e.g. the
   * provider-side secret was rotated). Both must be present together to swap.
   */
  clientId?: string
  clientSecret?: string
}

export type StartReconnectResult = { ok: true; authorizeUrl: string } | { ok: false; error: string }

export async function startReconnect(input: StartReconnectInput): Promise<StartReconnectResult> {
  const db = await getDb()
  if (db === null) return { ok: false, error: "Database unavailable" }
  const repos = createRepositories(db)

  const credResult = await repos.credentials.get(input.credentialId)
  if (credResult.isErr()) return { ok: false, error: "Credential not found" }
  const credential = credResult.value

  // Increment 45 (Slice C/E) — source the reconnect-target providerId via the
  // shared resolver (platform's design — the legacy `credential.oauthMeta
  // .providerId` fallback is gone as of Slice E), not
  // `credential.oauthMeta.providerId` directly — mirrors the CLI's
  // `credential reconnect` fix so web and CLI reconnect can never target a
  // different design for the same credential. A resolvable providerId must
  // still map to a REAL design in the merged (built-in + custom) set to
  // actually drive the flow — on failure, report the same honest errors.
  const paths = getPaths()
  const designsResult = await loadCustomDesigns(paths)
  if (designsResult.isErr()) {
    return {
      ok: false,
      error: `Custom OAuth designs store failed to load (${designsResult.error.kind})`,
    }
  }
  const designs = mergeDesigns(designsResult.value)
  let platform: Platform | null = null
  if (credential.platformId !== null) {
    const platformResult = await repos.platforms.get(credential.platformId)
    if (platformResult.isOk()) platform = platformResult.value
  }
  const resolved = resolveOAuthProviderId({
    credentialId: credential.id,
    context: "group",
    platform,
    designs,
  })
  if (!resolved.ok) {
    return { ok: false, error: "Credential has no OAuth provider on file" }
  }
  const providerId = resolved.providerId
  const provider = designs.get(providerId)
  if (provider === undefined) return { ok: false, error: "Unknown OAuth provider" }

  // Reconnect REUSES the stored client_id/secret by default — resolve them
  // server-side from the store (never returned to the browser, never re-typed).
  // The caller supplies clientId/clientSecret ONLY to swap to a different OAuth
  // app (e.g. the provider-side secret was rotated); those take precedence.
  //
  // Reject a PARTIAL swap (exactly one of the two supplied) rather than silently
  // discarding the typed value and reusing the stored pair — that would be a
  // dishonest swap. This mirrors the CLI's honest error and keeps the CLI↔web
  // contract symmetric. (The UI always sends the pair or neither, so this is
  // reachable only by a direct server-fn call.)
  if ((input.clientId === undefined) !== (input.clientSecret === undefined)) {
    return {
      ok: false,
      error: "Supply both client ID and client secret to swap credentials, or neither to reuse",
    }
  }

  let clientId: string
  let clientSecret: string
  if (input.clientId !== undefined && input.clientSecret !== undefined) {
    clientId = input.clientId
    clientSecret = input.clientSecret
  } else {
    const clientIdRef = credential.oauthMeta?.clientIdRef
    const clientSecretRef = credential.oauthMeta?.clientSecretRef
    if (clientIdRef === undefined || clientSecretRef === undefined) {
      return { ok: false, error: "Credential has no stored client credentials" }
    }
    const storeResult = await createCredentialStore(getPaths())
    if (storeResult.isErr()) return { ok: false, error: "Credential store unavailable" }
    const store = storeResult.value
    const idResult = await store.get(clientIdRef)
    const secretResult = await store.get(clientSecretRef)
    if (idResult.isErr() || secretResult.isErr()) {
      return { ok: false, error: "Failed to read the stored client credentials" }
    }
    if (idResult.value === null || secretResult.value === null) {
      return { ok: false, error: "Credential has lost its stored client credentials" }
    }
    clientId = idResult.value
    clientSecret = secretResult.value
  }

  const scopes = credential.oauthMeta?.scopes ?? provider.defaultScopes ?? []

  const { url, state, codeVerifier } = buildAuthorizeUrl({
    provider,
    clientId,
    redirectUri: WEB_REDIRECT_URI,
    scopes,
  })

  putPending(state, {
    codeVerifier: provider.pkce === "disabled" ? null : codeVerifier,
    providerId,
    clientId,
    clientSecret,
    scopes,
    createdAt: Date.now(),
    intent: { mode: "update", credentialId: input.credentialId },
  })

  return { ok: true, authorizeUrl: url }
}

// ---------------------------------------------------------------------------
// completeOAuthCallback — the /oauth/callback loader's server-fn. Consumes
// the pending state (single-use), exchanges the code, persists tokens.
// Returns a small outcome (never a token/secret) so the loader can redirect.
// ---------------------------------------------------------------------------

export type OAuthCallbackOutcome =
  | { outcome: "ok" }
  | { outcome: "error-state" }
  | { outcome: "error"; reason: string }

export async function completeOAuthCallback(
  code: string,
  state: string,
): Promise<OAuthCallbackOutcome> {
  // Single-use: a miss covers unknown state, an already-consumed state (a
  // duplicate/replayed callback nav), AND an expired one — takePending
  // deletes on read so a second call for the same state always misses.
  const pendingAuth = takePending(state)
  if (pendingAuth === undefined) {
    return { outcome: "error-state" }
  }

  const provider = getProvider(pendingAuth.providerId)
  if (provider === undefined) {
    return { outcome: "error", reason: "unknown-provider" }
  }

  const exchangeResult = await exchangeCode({
    provider,
    clientId: pendingAuth.clientId,
    clientSecret: pendingAuth.clientSecret,
    redirectUri: WEB_REDIRECT_URI,
    code,
    codeVerifier: pendingAuth.codeVerifier,
  })
  if (exchangeResult.isErr()) {
    return { outcome: "error", reason: exchangeErrorReason(exchangeResult.error) }
  }

  const db = await getDb()
  if (db === null) return { outcome: "error", reason: "database unavailable" }
  const repos = createRepositories(db)

  const storeResult = await createCredentialStore(getPaths())
  if (storeResult.isErr()) return { outcome: "error", reason: "credential store unavailable" }

  const now = Date.now()

  if (pendingAuth.intent.mode === "update") {
    const persistResult = await persistOAuthTokens({
      repos,
      store: storeResult.value,
      tokens: exchangeResult.value,
      providerId: pendingAuth.providerId,
      authMode: "authorization_code" as const,
      clientId: pendingAuth.clientId,
      clientSecret: pendingAuth.clientSecret,
      now,
      mode: "update" as const,
      credentialId: pendingAuth.intent.credentialId,
    })
    if (persistResult.isErr()) {
      return { outcome: "error", reason: persistErrorReason(persistResult.error) }
    }
    return { outcome: "ok" }
  }

  // mode === "create" — increment 38 D1: when the pending intent carries a
  // catalog surface payload, assemble the Platform (pure, credential-
  // independent) and re-check the collision (state may change during the
  // authorize→callback round-trip — the startConnect pre-check does not
  // guarantee the state is still collision-free by the time the user
  // returns). ABSENT surfacePlatform (raw /credentials flow, CLI) →
  // platformBuild stays undefined and persistOAuthTokens's create branch is
  // byte-identical to pre-inc-38 behavior.
  const { surfacePlatform } = pendingAuth.intent
  let platformBuild: { platform: Platform; preExisting: boolean } | undefined

  if (surfacePlatform !== undefined) {
    const collision = await checkCollision(
      repos,
      pendingAuth.intent.platformId,
      surfacePlatform.platformInput.kind,
    )
    if (collision.isErr()) {
      return { outcome: "error", reason: collisionErrorReason(collision.error) }
    }
    const preExisting = collision.value.existing !== undefined
    const assembled = await assemblePlatform(
      pendingAuth.intent.platformId,
      surfacePlatform.displayName,
      surfacePlatform.platformInput,
    )
    if (assembled.isErr()) {
      return { outcome: "error", reason: assembleErrorReason(assembled.error) }
    }
    platformBuild = { platform: assembled.value, preExisting }
  }

  const persistResult = await persistOAuthTokens({
    repos,
    store: storeResult.value,
    tokens: exchangeResult.value,
    providerId: pendingAuth.providerId,
    authMode: "authorization_code" as const,
    clientId: pendingAuth.clientId,
    clientSecret: pendingAuth.clientSecret,
    now,
    mode: "create" as const,
    platformId: pendingAuth.intent.platformId,
    account: pendingAuth.intent.account,
    ...(platformBuild !== undefined ? { platformBuild } : {}),
  })
  if (persistResult.isErr()) {
    return { outcome: "error", reason: persistErrorReason(persistResult.error) }
  }

  return { outcome: "ok" }
}

/** Map an OAuthConnectError to a short, non-secret reason string for the redirect query. */
function exchangeErrorReason(error: OAuthConnectError): string {
  if (error.kind === "exchange-failed") return `exchange-failed-${error.reason}`
  return error.kind
}

function persistErrorReason(error: OAuthConnectError): string {
  if (error.kind === "persist-failed") return "persist-failed"
  // 32.13 Slice B1 (RETIRED by increment 46, RC): explicit branch (rather
  // than relying on the `return error.kind` fallback) so the duplicate-name
  // reason string is a deliberate, reviewed choice — not an accident of the
  // fallback shape.
  if (error.kind === "duplicate-name") return "duplicate-name"
  return error.kind
}

/** Increment 38 D2 — map the callback-time collision re-check's ConnectError to a redirect reason. */
function collisionErrorReason(error: ConnectError): string {
  if (error.kind === "platform-kind-conflict") return "platform-kind-conflict"
  return error.kind
}

/** Increment 38 D1 — map an assemblePlatform failure (rare: bad catalog data) to a redirect reason. */
function assembleErrorReason(error: ConnectError): string {
  if (error.kind === "assemble-failed") return "assemble-failed"
  return error.kind
}
