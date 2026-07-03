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
  createCredentialStore,
  createRepositories,
  getPaths,
  getProvider,
  OAUTH_CALLBACK_URI,
} from "@junction/core"
import {
  buildAuthorizeUrl,
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
  platformId: string
}

export type StartConnectResult = { ok: true; authorizeUrl: string } | { ok: false; error: string }

export async function startConnect(input: StartConnectInput): Promise<StartConnectResult> {
  const provider = getProvider(input.providerId)
  if (provider === undefined) {
    return { ok: false, error: "unknown-provider" }
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
    intent: { mode: "create", platformId: input.platformId, account: input.account },
  })

  // Metadata only — state/codeVerifier/clientSecret stay server-side in the
  // pending-auth Map; the browser only ever sees the authorize URL.
  return { ok: true, authorizeUrl: url }
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

  const providerId = credential.oauthMeta?.providerId
  if (providerId === undefined) {
    return { ok: false, error: "Credential has no OAuth provider on file" }
  }
  const provider = getProvider(providerId)
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
  const persistArgs =
    pendingAuth.intent.mode === "create"
      ? ({
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
        } satisfies Parameters<typeof persistOAuthTokens>[0])
      : ({
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
        } satisfies Parameters<typeof persistOAuthTokens>[0])

  const persistResult = await persistOAuthTokens(persistArgs)
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
  return error.kind
}
