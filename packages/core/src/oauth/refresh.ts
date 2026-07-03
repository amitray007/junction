// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth refresh engine — the correctness heart of "connect once vs.
// permanent lockout" (increment 29, slice A2). Pure policy + orchestration:
// the provider refresh HTTP call is INJECTED as a RefreshTokenFn (slice B
// supplies the arctic-backed implementation); this file makes zero HTTP calls
// and imports nothing new — `store`/`repos` are the existing CredentialStore /
// CredentialsRepo interfaces, so core stays HTTP-free (the `core-not-http`
// depcruise rule still passes).
//
// SECURITY invariants (mirrors rotateCredential's atomic pattern):
//   1. Never overwrite a good refresh token with a partial/failed result —
//      transient/unknown refresh failures leave the DB untouched.
//   2. Atomic rotation, fail-safe: new store write FIRST → DB repoint →
//      delete old; on DB failure, clean up the new entries and keep the old
//      ones live.
//   3. Keep-old-refresh-if-absent: when the provider doesn't return a new
//      refresh token, OMIT refreshTokenRef from the setOAuthTokens patch
//      (omit/undefined = keep-old, per A1) — never null it.
//   4. invalid_grant → needsReauth persisted + a clear typed error, never silent.
//   5. No token ever appears in a RefreshError, a log, or a thrown value.

import { err, errAsync, ok, type Result, ResultAsync } from "neverthrow"
import { ulid } from "ulid"
import type { CredentialStore } from "../credentials/store.js"
import type { Repositories } from "../repositories/index.js"
import type { Credential, OAuthMeta } from "../schema/credential.js"
import type { NormalizedTokens } from "./catalog.js"

// ---------------------------------------------------------------------------
// RefreshTokenFn — the injected provider refresh call (slice B implements it)
// ---------------------------------------------------------------------------

/**
 * Outcome of a provider refresh HTTP call. `invalid_grant` is the special
 * case — it means the refresh token itself is dead (revoked / expired /
 * rotated out from under us) and drives `needsReauth`. `transient`/`unknown`
 * mean "try again later" — the caller must keep the old tokens live.
 *
 * `detail` is provider-supplied free text for logs/diagnostics ONLY — it MUST
 * NEVER carry a token value (slice B's responsibility when it builds the real
 * arctic-backed RefreshTokenFn).
 */
export type RefreshResult =
  | { ok: true; tokens: NormalizedTokens }
  | { ok: false; reason: "invalid_grant" | "transient" | "unknown"; detail?: string }

/**
 * Perform the provider refresh HTTP call and return normalized tokens, or a
 * typed failure. Injected so this module (and all of core) stays HTTP-free —
 * slice B supplies the arctic-backed implementation; until then,
 * source-runtime wires a placeholder stub at the resolve hot path.
 *
 * The plaintext `refreshToken`/`clientId`/`clientSecret` are resolved by the
 * orchestrator (refreshIfExpired) just-in-time and passed in; the fn MUST NOT
 * log or persist them — it returns only NormalizedTokens (or a tokenless
 * failure reason).
 */
export type RefreshTokenFn = (args: {
  providerId: string
  refreshToken: string
  clientId: string
  clientSecret: string
}) => Promise<RefreshResult>

// ---------------------------------------------------------------------------
// RefreshError
// ---------------------------------------------------------------------------

/**
 * Refresh-orchestration errors. Deliberately small — carries only
 * platformId/account/cause, NEVER a token (RefreshError may be logged or
 * surfaced to the CLI/agent).
 */
export type RefreshError =
  | { kind: "needs-reauth"; platformId: string; account: string }
  | { kind: "refresh-failed"; cause: unknown }
  | { kind: "not-oauth" }

// ---------------------------------------------------------------------------
// shouldRefresh — pure expiry decision
// ---------------------------------------------------------------------------

/** Default early-refresh buffer: refresh if expiry is within 60s. */
export const DEFAULT_REFRESH_BUFFER_MS = 60_000

/**
 * Upper bound on a trusted `expires_in` (seconds). A century — comfortably
 * larger than any real token lifetime, and small enough that `now + s*1000`
 * can never overflow the JS Date range (~±8.64e15 ms). A value above this is
 * treated as "no usable expiry" rather than allowed to overflow `.toISOString()`.
 */
const MAX_EXPIRES_IN_SECONDS = 100 * 365 * 24 * 60 * 60

/**
 * Pure decision: should this credential's access token be refreshed right now?
 *
 * - No `meta` or no `expiresAt` → false (non-expiring, e.g. GitHub OAuth App /
 *   Notion — there's nothing to refresh against).
 * - `meta.needsReauth === true` → false — a dead credential is never
 *   auto-refreshed; the caller (refreshIfExpired) surfaces needs-reauth
 *   directly instead of attempting a refresh that can only fail the same way.
 * - Otherwise: refresh if `expiresAt` falls within `bufferMs` of `now` (or has
 *   already passed).
 * - A malformed (unparseable) `expiresAt` → false. We can't reason about an
 *   expiry we can't parse; better to not refresh than to spin retrying a
 *   value that will never satisfy the check.
 */
export function shouldRefresh(meta: OAuthMeta | undefined, now: number, bufferMs: number): boolean {
  if (meta === undefined || meta.expiresAt === undefined || meta.expiresAt === null) return false
  if (meta.needsReauth === true) return false
  const expiresAtMs = Date.parse(meta.expiresAt)
  if (Number.isNaN(expiresAtMs)) return false
  return expiresAtMs - now <= bufferMs
}

// ---------------------------------------------------------------------------
// refreshIfExpired — the orchestrator
// ---------------------------------------------------------------------------

export interface RefreshIfExpiredArgs {
  credential: Credential
  store: CredentialStore
  repos: Pick<Repositories, "credentials">
  refreshFn: RefreshTokenFn
  now: number
  bufferMs?: number
}

/**
 * Return the CURRENT access token for `credential`, refreshing it first if
 * `shouldRefresh` says the expiry buffer has been entered. Owns the store
 * read for the "current" token so callers get a single source of truth
 * regardless of whether a refresh happened.
 *
 * The accessToken is `null` when the store has no value for the secretRef —
 * a lost/cleared secret. This is propagated HONESTLY (never coerced to `""`):
 * a real refresh always yields a non-empty token, so `null` can only mean
 * "there is nothing to authenticate with." Callers MUST treat `null` the
 * same as "no credential" (secret = null), NEVER as a fake empty-string
 * bearer token — mirroring the non-oauth2 resolution path's null handling.
 *
 * Mirrors rotateCredential's atomic-write pattern for the refresh-succeeded
 * path: mint fresh ref(s), write to the store FIRST, repoint the DB in ONE
 * `setOAuthTokens` call, then best-effort delete the old ref(s). On a DB
 * failure mid-rotation, the new store entries are cleaned up and the OLD
 * refs are left live — a good token is never lost.
 */
export function refreshIfExpired(
  args: RefreshIfExpiredArgs,
): ResultAsync<{ accessToken: string | null }, RefreshError> {
  const { credential, store, repos, refreshFn, now } = args
  const bufferMs = args.bufferMs ?? DEFAULT_REFRESH_BUFFER_MS

  if (credential.kind !== "oauth2") {
    // Defensive — callers only invoke this for oauth2 credentials. Read the
    // current token unchanged rather than assume the caller already has it,
    // so this function is always the single source of truth for "current".
    return readCurrentToken(store, credential.secretRef)
  }

  const meta = credential.oauthMeta

  if (meta?.needsReauth === true) {
    return errAsync({
      kind: "needs-reauth",
      platformId: credential.platformId,
      account: credential.profileName,
    })
  }

  if (!shouldRefresh(meta, now, bufferMs)) {
    return readCurrentToken(store, credential.secretRef)
  }

  return performRefresh(credential, meta, store, repos, refreshFn, now)
}

/**
 * Read the credential's current access token straight from the store.
 * `null` (a lost/cleared secret) is returned AS `null` — never coerced to
 * `""` — so callers can tell "no credential" apart from a real token.
 */
function readCurrentToken(
  store: CredentialStore,
  secretRef: string,
): ResultAsync<{ accessToken: string | null }, RefreshError> {
  return store
    .get(secretRef)
    .map((value) => ({ accessToken: value }))
    .mapErr((cause): RefreshError => ({ kind: "refresh-failed", cause }))
}

/**
 * The refresh path: resolve refresh-token + client creds, call the injected
 * refreshFn, and handle each outcome per the invariants above.
 */
function performRefresh(
  credential: Credential,
  meta: OAuthMeta | undefined,
  store: CredentialStore,
  repos: Pick<Repositories, "credentials">,
  refreshFn: RefreshTokenFn,
  now: number,
): ResultAsync<{ accessToken: string | null }, RefreshError> {
  const platformId = credential.platformId
  const account = credential.profileName
  const needsReauth = (): RefreshError => ({ kind: "needs-reauth", platformId, account })

  const refreshTokenRef = meta?.refreshTokenRef
  const clientIdRef = meta?.clientIdRef
  const clientSecretRef = meta?.clientSecretRef
  if (refreshTokenRef === undefined || clientIdRef === undefined || clientSecretRef === undefined) {
    // Nothing to refresh with — treat as needs-reauth rather than a generic
    // failure (a reconnect is the only way forward regardless).
    return errAsync(needsReauth())
  }

  return store
    .get(refreshTokenRef)
    .mapErr((cause): RefreshError => ({ kind: "refresh-failed", cause }))
    .andThen((refreshToken) => {
      // Treat an empty string the same as null — an empty refresh token can't
      // refresh anything, and passing "" to the provider would surface as a
      // confusing invalid_grant. Fail closed to needs-reauth.
      if (refreshToken === null || refreshToken === "") return errAsync(needsReauth())
      return store
        .get(clientIdRef)
        .mapErr((cause): RefreshError => ({ kind: "refresh-failed", cause }))
        .andThen((clientId) => {
          if (clientId === null || clientId === "") return errAsync(needsReauth())
          return store
            .get(clientSecretRef)
            .mapErr((cause): RefreshError => ({ kind: "refresh-failed", cause }))
            .andThen((clientSecret) => {
              if (clientSecret === null || clientSecret === "") return errAsync(needsReauth())
              return callRefreshAndPersist(
                credential,
                meta,
                store,
                repos,
                refreshFn,
                now,
                refreshToken,
                clientId,
                clientSecret,
              )
            })
        })
    })
}

/**
 * Best-effort delete of a store ref that can NEVER reject the caller's
 * promise. store.delete returns a Result, but a real keyring/file backend may
 * THROW; either way is swallowed here — a failed cleanup of an old/new ref is
 * strictly preferable to rejecting an otherwise-successful rotation (mirrors
 * rotateCredential's `.orElse(() => okAsync)` on its best-effort deletes).
 */
async function safeDelete(store: CredentialStore, ref: string): Promise<void> {
  try {
    await store.delete(ref)
  } catch {
    // swallow — best-effort cleanup, never surface
  }
}

function callRefreshAndPersist(
  credential: Credential,
  meta: OAuthMeta | undefined,
  store: CredentialStore,
  repos: Pick<Repositories, "credentials">,
  refreshFn: RefreshTokenFn,
  now: number,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): ResultAsync<{ accessToken: string }, RefreshError> {
  const platformId = credential.platformId
  const account = credential.profileName
  const providerId = meta?.providerId ?? ""
  // Capture the OLD refs at entry (mirrors rotateCredential capturing
  // oldSecretRef up front) — the final best-effort deletes below use these
  // locals, not a re-read of `credential`/`meta`, so the atomicity holds
  // regardless of whether those objects are ever mutated/aliased elsewhere.
  const oldAccessRef = credential.secretRef
  const oldRefreshRef = meta?.refreshTokenRef

  const work = async (): Promise<Result<{ accessToken: string }, RefreshError>> => {
    let result: RefreshResult
    try {
      result = await refreshFn({ providerId, refreshToken, clientId, clientSecret })
    } catch (cause) {
      // The injected fn threw instead of returning a typed failure (arctic's
      // OAuth2Tokens accessors throw on absent fields) — treat as unknown /
      // transient: keep old tokens, surface a retryable error.
      return err({ kind: "refresh-failed", cause })
    }

    if (result.ok === false) {
      if (result.reason === "invalid_grant") {
        // Persist needsReauth (merges — refs retained, per A1's keep-old
        // semantics) and surface a clear typed error. Never silent — even if
        // the DB write itself fails, the credential IS dead, so needs-reauth
        // is still the honest outcome to surface (not a confusing
        // refresh-failed that implies a retry could help).
        await repos.credentials.setOAuthTokens(credential.id, { needsReauth: true })
        return err({ kind: "needs-reauth", platformId, account })
      }
      // transient | unknown — do NOT touch the DB; old tokens stay live so a
      // retry (or the next refresh-ahead attempt) can succeed.
      return err({ kind: "refresh-failed", cause: result.detail })
    }

    // ---- Success: ATOMIC ROTATION (mirrors rotateCredential exactly) ----
    const tokens = result.tokens
    const newAccessRef = ulid()
    const setAccessResult = await store.set(newAccessRef, tokens.accessToken)
    if (setAccessResult.isErr()) {
      return err({ kind: "refresh-failed", cause: setAccessResult.error })
    }

    // Keep-old-refresh-if-absent: only mint + write a new refresh ref if the
    // provider actually rotated it; otherwise the existing ref is retained by
    // omitting refreshTokenRef from the patch below. An EMPTY STRING is
    // treated the same as absent (`!== undefined` alone would accept "",
    // minting a fresh ref that stores an empty refresh token and orphaning
    // the good old one — a keep-old-refresh violation that leads to eventual
    // lockout the next time a refresh is actually attempted).
    let newRefreshRef: string | undefined
    if (tokens.refreshToken) {
      newRefreshRef = ulid()
      const setRefreshResult = await store.set(newRefreshRef, tokens.refreshToken)
      if (setRefreshResult.isErr()) {
        await safeDelete(store, newAccessRef)
        return err({ kind: "refresh-failed", cause: setRefreshResult.error })
      }
    }

    // Validate expiresInSeconds before trusting it: a NEGATIVE value would
    // put expiresAt in the past → shouldRefresh true on every subsequent
    // resolve → a perpetual refresh storm on an actually-valid token; a HUGE
    // value overflows the Date range → `.toISOString()` throws a RangeError
    // (which would reject work() below and orphan the just-written refs).
    // A non-finite / non-positive / out-of-range value falls back to the
    // prior expiry, exactly like the absent case.
    const s = tokens.expiresInSeconds
    const expiresAt =
      typeof s === "number" && Number.isFinite(s) && s > 0 && s <= MAX_EXPIRES_IN_SECONDS
        ? new Date(now + s * 1000).toISOString()
        : (meta?.expiresAt ?? undefined)

    const setTokensResult = await repos.credentials.setOAuthTokens(credential.id, {
      secretRef: newAccessRef,
      // OMIT (not null) when not rotated — omit/undefined = keep-old (A1).
      ...(newRefreshRef !== undefined ? { refreshTokenRef: newRefreshRef } : {}),
      expiresAt,
      scopes: tokens.scopes ?? meta?.scopes,
      needsReauth: false,
      obtainedAt: new Date(now).toISOString(),
    })

    if (setTokensResult.isErr()) {
      // DB repoint failed AFTER the new store writes: clean up the new
      // entries (best-effort, throw-safe) and propagate — the OLD refs stay live.
      await safeDelete(store, newAccessRef)
      if (newRefreshRef !== undefined) await safeDelete(store, newRefreshRef)
      return err({ kind: "refresh-failed", cause: setTokensResult.error })
    }

    // DB repoint succeeded — best-effort delete the OLD refs, using the refs
    // captured at entry (never a re-read of a possibly-mutated object). Each
    // delete is throw-safe: a store.delete that THROWS (not just returns Err)
    // must not reject work() and turn a fully-successful rotation into an
    // orphaning failure (mirrors rotateCredential's swallowed cleanup).
    await safeDelete(store, oldAccessRef)
    if (newRefreshRef !== undefined && oldRefreshRef !== undefined) {
      await safeDelete(store, oldRefreshRef)
    }

    return ok({ accessToken: tokens.accessToken })
  }

  return new ResultAsync(work())
}
