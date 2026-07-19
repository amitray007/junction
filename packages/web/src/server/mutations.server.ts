// SPDX-License-Identifier: AGPL-3.0-only
// Server-only mutation helpers — the ONLY place in @junction/web that calls core
// write operations (addCredential, removeCredential, rotateCredential).
// Called exclusively from mutations.functions.ts createServerFn handlers.
// SECURITY: all credential output is metadata-only — no secret, no secretRef.

import type {
  Credential,
  CredentialError,
  CredentialKind,
  CredentialStore,
  DbError,
  Platform,
} from "@junction/core"
import {
  addCredential,
  addStandaloneCredential,
  createCredentialStore,
  createRepositories,
  getPaths,
  loadCustomDesigns,
  mergeDesigns,
  refreshIfExpired,
  removeCredential,
  renameCredential,
  resolveCredentialProviderId,
  rotateCredential,
} from "@junction/core"
import {
  oauthRefreshFn,
  refreshIfExpiredSingleFlight,
  type VerifyOutcome,
  verifyCredential,
} from "@junction/source-runtime"
import { getDb } from "./shared.server.js"

// ---------------------------------------------------------------------------
// Shared helper: open memoised DB + fresh store, call fn, propagate errors.
// ---------------------------------------------------------------------------

async function withReposAndStore<T>(
  fn: (repos: ReturnType<typeof createRepositories>, store: CredentialStore) => Promise<T>,
): Promise<T> {
  const db = await getDb()
  if (db === null) throw new Error("Database unavailable")

  const storeResult = await createCredentialStore(getPaths())
  if (storeResult.isErr()) throw storeResult.error

  return fn(createRepositories(db), storeResult.value)
}

// ---------------------------------------------------------------------------
// Credential metadata shape — never includes secret or secretRef
// ---------------------------------------------------------------------------

export type CredentialMutationMeta = {
  id: string
  /** Increment 42 — the credential's identity slug, shown everywhere. */
  name: string
  /** Increment 42 — null for an UNLINKED (standalone) credential. */
  platformId: string | null
  account: string
  kind: string
}

/** Map a core Credential to the metadata-only shape returned by mutations. */
function toMutationMeta(c: Credential): CredentialMutationMeta {
  return {
    id: String(c.id),
    name: c.name,
    platformId: c.platformId === null ? null : String(c.platformId),
    account: c.name,
    kind: c.kind,
  }
}

// ---------------------------------------------------------------------------
// Error message helper — map internal error kinds to human-readable strings.
// Used by remove + rotate error paths so raw enum tokens never reach the UI.
// ---------------------------------------------------------------------------

function credentialErrorMessage(kind: string): string {
  switch (kind) {
    case "not-found":
      return "Credential not found"
    case "in-use":
      return "Credential is in use by a profile source"
    case "query-failed":
      return "Database error"
    case "kind-incompatible":
      return "Credential kind not accepted for this platform"
    default:
      return "Operation failed"
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** The verify outcome shape surfaced to the UI alongside a successful add — metadata only. */
export type AddVerifyResult =
  | { status: "ok" }
  | { status: "auth-failed" }
  | { status: "unreachable"; detail: string }
  | { status: "not-verifiable"; reason: string }

/**
 * Map an addCredential/addStandaloneCredential/bindCredentialToPlatform
 * failure to a human-readable message — shared by mutateAddCredential's two
 * branches (standalone vs. platform-linked) so the mapping can't drift
 * between them (increment 42 introduced the standalone branch; this
 * factor-out is what keeps the two from becoming near-duplicate switch
 * statements). Increment 43 — exported so platform-mutations.server.ts's
 * bind path reuses the SAME kind-incompatible/duplicate-name copy rather
 * than inventing new wording (bindCredentialToPlatform's core error shapes
 * are identical to addCredential's). `scope` tailors the kind-incompatible
 * wording to whether a platform is in play — pass "" for the standalone
 * (no-platform) path. Increment 46 (RC) — the old platform-scoped
 * `duplicate-account` guard is GONE; `duplicate-name` is now the DB-backed,
 * globally-unique collision (a credential with this `name` already exists),
 * reachable from BOTH the standalone and platform-linked branches.
 */
export function addCredentialErrorMessage(
  e: CredentialError | DbError,
  scope: "platform" | "",
): string {
  if (e.kind === "invalid-input") return e.reason
  if (e.kind === "kind-incompatible") {
    const suffix = scope === "platform" ? " for this platform" : ""
    return `Credential kind "${e.requested}" not accepted${suffix}; allowed: ${e.allowed.join(", ")}`
  }
  if (e.kind === "duplicate-name") {
    return `a credential named "${e.name}" already exists`
  }
  return e.kind
}

export async function mutateAddCredential(input: {
  /** Increment 42 — OPTIONAL. Absent → creates an UNLINKED (standalone) credential. */
  platformId?: string
  /** Required when platformId is present; ignored (must be absent) otherwise. */
  account?: string
  /** Increment 42 — the credential's identity slug. Required for a standalone
   *  create; optional (derived) for a platform-linked create — see addCredential. */
  name?: string
  kind: Exclude<CredentialKind, "oauth2">
  secret: string
  /** Opt-in verify-on-add (28.9) — never blocks storing; a failed verify still stores.
   *  Meaningless for a standalone credential (no platform to verify against). */
  verify?: boolean
}): Promise<
  | { ok: true; credential: CredentialMutationMeta; verify?: AddVerifyResult }
  | { ok: false; error: string }
> {
  // Increment 42 — no platformId → the standalone (unlinked) vault create
  // path. No kind-compat matrix, no verify (nothing to test against).
  if (input.platformId === undefined) {
    return withReposAndStore(async (repos, store) => {
      if (input.name === undefined || input.name.trim() === "") {
        input.secret = ""
        return { ok: false as const, error: "name is required for a standalone credential" }
      }
      const result = await addStandaloneCredential(
        { name: input.name, kind: input.kind, secret: input.secret },
        store,
        repos.credentials,
      )
      input.secret = ""
      if (result.isErr()) {
        return { ok: false as const, error: addCredentialErrorMessage(result.error, "") }
      }
      return { ok: true as const, credential: toMutationMeta(result.value) }
    })
  }

  const platformId = input.platformId
  return withReposAndStore(async (repos, store) => {
    if (input.account === undefined || input.account.trim() === "") {
      input.secret = ""
      return { ok: false as const, error: "account is required when platformId is given" }
    }
    const account = input.account

    // Fetch the platform — addCredential validates the requested kind against
    // its kind-compat matrix before the secret is touched (slice A of
    // increment 28.9). The kind now comes from the caller (the web dialog's
    // Select, pre-filtered to the platform's compatibleKinds).
    const platformResult = await repos.platforms.get(platformId)
    if (platformResult.isErr()) {
      input.secret = ""
      const error =
        platformResult.error.kind === "not-found" ? "Platform not found" : "Database error"
      return { ok: false as const, error }
    }
    const platform = platformResult.value

    const result = await addCredential(
      {
        platformId,
        account,
        kind: input.kind,
        secret: input.secret,
        // Explicit name passes through (validated inside addCredential);
        // absent → addCredential derives one, keeping back-compat callers
        // (this same fn, pre-42 shape) byte-identical in behavior.
        ...(input.name !== undefined && input.name.trim() !== "" ? { name: input.name } : {}),
      },
      platform,
      store,
      repos.credentials,
    )
    const secret = input.secret
    // Drop our reference to the secret (best-effort hygiene; JS strings are
    // immutable and not zeroable — the real guarantee is that the secret never
    // enters the return value or error).
    input.secret = ""
    if (result.isErr()) {
      return { ok: false as const, error: addCredentialErrorMessage(result.error, "platform") }
    }

    const credential = result.value
    if (!input.verify) {
      return { ok: true as const, credential: toMutationMeta(credential) }
    }

    // Verify never blocks storing — the credential is already persisted above.
    // verifyCredential's contract is ALWAYS Ok(VerifyOutcome) (error type is
    // `never`) — unwrapOr's fallback is unreachable but keeps this call-site
    // total without an unsafe cast.
    // `secret` here is `input.secret`, sourced from the request body — it is
    // a string by the input type, never null, so the lost-secret handling in
    // testCredential (above, keyed off store.get's stored-secretRef lookup)
    // does not apply on this path. No change needed here (verify-honesty
    // review, see STORED_SECRET_MISSING_DETAIL).
    //
    // Increment 45 (Slice C) — source the userinfo-probe providerId hint via
    // the SAME shared resolver refresh/grouping use (resolveCredentialProviderId),
    // not `credential.oauthMeta.providerId` directly. This credential's kind
    // is never oauth2 here (input.kind excludes it) — the hint only matters
    // when the platform itself declares an oauth2 catalog design (a non-oauth2
    // credential can still be probed against a platform's userinfoUrl). A
    // `{ok:false}`/degraded resolution yields `undefined`, which verifyCredential
    // already treats as "no OAuth userinfo hint" — verify falls through to the
    // normal per-kind verify, never fails outright over a missing hint.
    const oauthProviderId = await resolveCredentialProviderId({
      repos,
      paths: getPaths(),
      credential,
      context: "group",
    })
    const verifyResult = (
      await verifyCredential(platform, secret, getPaths(), { oauthProviderId })
    ).unwrapOr({
      status: "unreachable" as const,
      detail: "verify failed unexpectedly",
    })
    if (verifyResult.status === "ok" || verifyResult.status === "auth-failed") {
      await repos.credentials.setVerifyState(credential.id, verifyResult.status, Date.now())
    } else if (verifyResult.status === "unreachable") {
      await repos.credentials.setVerifyState(credential.id, "unreachable", Date.now())
    }
    // "not-verifiable" is never persisted — it's a property of the platform, not an event.

    return {
      ok: true as const,
      credential: toMutationMeta(credential),
      verify: verifyResult,
    }
  })
}

export async function mutateRenameCredential(input: {
  credentialId: string
  account: string
}): Promise<{ ok: true; credential: CredentialMutationMeta } | { ok: false; error: string }> {
  const db = await getDb()
  if (db === null) return { ok: false, error: "Database unavailable" }
  const repos = createRepositories(db)

  const result = await renameCredential(
    { credentialId: input.credentialId, account: input.account },
    repos.credentials,
  )
  if (result.isErr()) {
    const e = result.error
    if (e.kind === "invalid-input") return { ok: false, error: e.reason }
    return { ok: false, error: credentialErrorMessage(e.kind) }
  }
  return { ok: true, credential: toMutationMeta(result.value) }
}

export async function mutateRemoveCredential(
  credentialId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withReposAndStore(async (repos, store) => {
    const result = await removeCredential(credentialId, store, repos.credentials)
    if (result.isErr()) {
      return { ok: false as const, error: credentialErrorMessage(result.error.kind) }
    }
    return { ok: true as const }
  })
}

export async function mutateRotateCredential(input: {
  credentialId: string
  newSecret: string
}): Promise<{ ok: true; credential: CredentialMutationMeta } | { ok: false; error: string }> {
  return withReposAndStore(async (repos, store) => {
    const result = await rotateCredential(
      { credentialId: input.credentialId, newSecret: input.newSecret },
      store,
      repos.credentials,
    )
    // Drop our reference to the new secret (best-effort hygiene; JS strings are
    // immutable and not zeroable — the real guarantee is that the secret never
    // enters the return value or error).
    input.newSecret = ""
    if (result.isErr()) {
      return { ok: false as const, error: credentialErrorMessage(result.error.kind) }
    }
    return { ok: true as const, credential: toMutationMeta(result.value) }
  })
}

// ---------------------------------------------------------------------------
// testCredential — Test Connection (28.9). Re-verifies an EXISTING credential
// on demand (the row-menu action; distinct from verify-ON-ADD above, which
// runs inline during addCredential). Persists the outcome the same way.
// ---------------------------------------------------------------------------

export type TestCredentialResult =
  | { ok: true; status: "ok" | "auth-failed" | "unreachable" | "not-verifiable"; detail?: string }
  | { ok: false; error: string }

/**
 * Look up `platform` for a resolved credential row. Small local helper (not
 * withReposAndStore, which throws on store failure) so a store failure here
 * surfaces as a clean `{ok:false}` string per the method file's contract for
 * this endpoint, rather than a thrown 500.
 */
async function loadPlatformForCredential(
  repos: ReturnType<typeof createRepositories>,
  credentialId: string,
): Promise<
  | {
      ok: true
      platform: Platform
      credential: Credential
      secretRef: string
      oauthProviderId?: string
    }
  | { ok: false; error: string }
> {
  const credResult = await repos.credentials.get(credentialId)
  if (credResult.isErr()) {
    return { ok: false, error: credentialErrorMessage(credResult.error.kind) }
  }
  const credential = credResult.value

  // Increment 42 — an UNLINKED credential (platformId: null) has no platform
  // to test against. testCredential's caller (the web ⋯ menu) should already
  // disable "Test Connection" for an unlinked row, but this is the honest
  // server-side backstop.
  if (credential.platformId === null) {
    return { ok: false, error: "This credential is not linked to a platform — nothing to verify" }
  }

  const platformResult = await repos.platforms.get(credential.platformId)
  if (platformResult.isErr()) {
    return {
      ok: false,
      error: platformResult.error.kind === "not-found" ? "Platform not found" : "Database error",
    }
  }

  // Increment 45 (Slice C) — source the verify-hint providerId via the shared
  // resolver (resolveCredentialProviderId), not `credential.oauthMeta.providerId`
  // directly. Degrades to `undefined` on a dangling/no-source resolution —
  // verifyCredential treats that as "no OAuth userinfo hint" and falls
  // through to the normal per-kind verify; Test Connection is never failed
  // outright over an unresolvable hint.
  const oauthProviderId = await resolveCredentialProviderId({
    repos,
    paths: getPaths(),
    credential,
    context: "group",
  })

  return {
    ok: true,
    platform: platformResult.value,
    credential,
    secretRef: credential.secretRef,
    oauthProviderId,
  }
}

/** Map a VerifyOutcome to the minimal detail/reason string TestCredentialResult carries. */
function outcomeDetail(outcome: VerifyOutcome): string | undefined {
  if (outcome.status === "unreachable") return outcome.detail
  if (outcome.status === "not-verifiable") return outcome.reason
  return undefined
}

// A STORED credential (reached via credentialId → secretRef) whose secret
// resolves to null is a LOST secret, not a public/no-auth source — never let
// this fall into verifyCredential, which treats null as "no credential to
// send" and could verify "ok" anonymously against a lax upstream. Same
// wording as the CLI's STORED_SECRET_MISSING_DETAIL
// (packages/cli/src/commands/credential.ts) — duplicated short literal per
// the method file (rule-of-three not yet hit at 2 sites).
const STORED_SECRET_MISSING_DETAIL = "stored secret missing — rotate this credential"

/** An honest "can't get a trustworthy token right now" detail for Test. */
const NEEDS_REAUTH_DETAIL = "needs reconnect"

/**
 * Resolve the token to hand `verifyCredential` for Test Connection.
 *
 * For an oauth2 credential this mirrors the runtime's refresh-ahead path
 * (source-runtime's resolve-provider.ts L126–172, single-flighted on the same
 * `credential.id` key) so Test reports the credential's TRUE current status,
 * not the status of a possibly-expired access token. Non-oauth2 credentials
 * never reach this helper — `testCredential` keeps their plain `store.get`
 * path unchanged.
 *
 * Returns a small tagged union rather than a `VerifyOutcome` directly: the
 * caller still has to call `verifyCredential` with the resolved token, so
 * this only decides WHICH token (or terminal outcome) feeds that call.
 *
 * FIXED (increment 45, Slice C): this call site now passes `platform` — the
 * gap noted in Slice A (this refresh-ahead helper only ever exercised
 * `resolveOAuthProviderId`'s legacy-fallback arm, since `platform` was never
 * threaded through) is closed here. `testCredential` already resolves the
 * platform via `loadPlatformForCredential` before calling this helper, so it
 * costs nothing extra to pass it in. Custom designs are loaded + merged the
 * same way refresh's real caller (source-runtime's resolve-provider.ts)
 * does — a `custom:*` platform reference is now reachable from Test
 * Connection too, not just live refresh via `mcp serve`/`serve`.
 * (Slice E note: the legacy-fallback arm referenced above no longer exists
 * at all — resolution is platform.oauthProviderId → app-catalog only.)
 */
async function resolveTokenForTest(
  credential: Credential,
  platform: Platform,
  store: CredentialStore,
  repos: ReturnType<typeof createRepositories>,
): Promise<
  { kind: "token"; value: string } | { kind: "lost" } | { kind: "auth-failed"; detail?: string }
> {
  const designsResult = await loadCustomDesigns(getPaths())
  if (designsResult.isErr()) {
    process.stderr.write(
      `resolveTokenForTest: custom OAuth designs store failed to load (${designsResult.error.kind}) — refresh skipped\n`,
    )
    return { kind: "auth-failed" }
  }
  const designs = mergeDesigns(designsResult.value)
  const refreshResult = await refreshIfExpiredSingleFlight(credential.id, () =>
    refreshIfExpired({
      credential,
      store,
      repos,
      refreshFn: oauthRefreshFn,
      now: Date.now(),
      platform,
      designs,
    }),
  )

  if (refreshResult.isErr()) {
    const error = refreshResult.error
    if (error.kind === "needs-reauth") {
      return { kind: "auth-failed", detail: NEEDS_REAUTH_DETAIL }
    }
    // refresh-failed | not-oauth (defensive) — can't get a trustworthy token
    // right now; matches resolve-provider's mapping (L152–163). Must NOT be
    // reported as a false "ok".
    return { kind: "auth-failed" }
  }

  const { accessToken } = refreshResult.value
  // null accessToken = a lost/cleared secret (refreshIfExpired's own
  // readCurrentToken/rotation both propagate this honestly) — never coerce
  // to "" and never hand it to verifyCredential.
  return accessToken === null ? { kind: "lost" } : { kind: "token", value: accessToken }
}

export async function testCredential(credentialId: string): Promise<TestCredentialResult> {
  const db = await getDb()
  if (db === null) return { ok: false, error: "Database unavailable" }
  const repos = createRepositories(db)

  const loaded = await loadPlatformForCredential(repos, credentialId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const { platform, credential, secretRef, oauthProviderId } = loaded

  const storeResult = await createCredentialStore(getPaths())
  if (storeResult.isErr()) return { ok: false, error: "Credential store unavailable" }
  const store = storeResult.value

  let result: VerifyOutcome
  // Set only for the oauth2 refresh-ahead's needs-reauth outcome — a detail
  // string `VerifyOutcome`'s `auth-failed` variant has no room for (it's
  // `verify-credential.ts`'s type, out of scope for this fix), but
  // `TestCredentialResult` can carry regardless of status. Undefined for
  // every other path (including a directly auth-failed verify, which stays
  // detail-less exactly as it reports today).
  let authFailedDetail: string | undefined

  if (credential.kind === "oauth2") {
    // oauth2: refresh-ahead so Test reports the TRUE status, not the stale
    // token's — see resolveTokenForTest for the full rationale. This is the
    // ONE oauth2-specific branch in testCredential; non-oauth2 credentials
    // fall through to the unchanged plain-store-read path below.
    const resolved = await resolveTokenForTest(credential, platform, store, repos)
    if (resolved.kind === "auth-failed") {
      result = { status: "auth-failed" }
      authFailedDetail = resolved.detail
    } else if (resolved.kind === "lost") {
      result = { status: "unreachable", detail: STORED_SECRET_MISSING_DETAIL }
    } else {
      result = (
        await verifyCredential(platform, resolved.value, getPaths(), { oauthProviderId })
      ).unwrapOr({
        status: "unreachable" as const,
        detail: "verify failed unexpectedly",
      })
    }
  } else {
    const secretResult = await store.get(secretRef)
    if (secretResult.isErr()) return { ok: false, error: "Failed to read the stored secret" }
    const secret = secretResult.value

    result =
      secret === null
        ? { status: "unreachable", detail: STORED_SECRET_MISSING_DETAIL }
        : (await verifyCredential(platform, secret, getPaths(), { oauthProviderId })).unwrapOr({
            status: "unreachable" as const,
            detail: "verify failed unexpectedly",
          })
  }

  if (
    result.status === "ok" ||
    result.status === "auth-failed" ||
    result.status === "unreachable"
  ) {
    // Best-effort persistence: testCredential has no stderr/warning channel to
    // surface a setVerifyState failure to the caller distinctly from the
    // verify outcome itself (unlike the CLI, which prints to stderr and sets
    // --json's `persisted:false`). The verify still ran and its outcome is
    // still returned; only the DB write is silently best-effort here.
    await repos.credentials.setVerifyState(credentialId, result.status, Date.now())
  }
  // "not-verifiable" is never persisted — a property of the platform, not an event.

  const detail = authFailedDetail ?? outcomeDetail(result)
  return { ok: true, status: result.status, ...(detail !== undefined ? { detail } : {}) }
}
