// SPDX-License-Identifier: AGPL-3.0-only
// Server-only mutation helpers — the ONLY place in @junction/web that calls core
// write operations (addCredential, removeCredential, rotateCredential).
// Called exclusively from mutations.functions.ts createServerFn handlers.
// SECURITY: all credential output is metadata-only — no secret, no secretRef.

import type { Credential, CredentialKind, CredentialStore, Platform } from "@junction/core"
import {
  addCredential,
  createCredentialStore,
  createRepositories,
  getPaths,
  removeCredential,
  rotateCredential,
} from "@junction/core"
import { type VerifyOutcome, verifyCredential } from "@junction/source-runtime"
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
  platformId: string
  account: string
  kind: string
}

/** Map a core Credential to the metadata-only shape returned by mutations. */
function toMutationMeta(c: Credential): CredentialMutationMeta {
  return {
    id: String(c.id),
    platformId: String(c.platformId),
    account: c.profileName,
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

export async function mutateAddCredential(input: {
  platformId: string
  account: string
  kind: Exclude<CredentialKind, "oauth2">
  secret: string
  /** Opt-in verify-on-add (28.9) — never blocks storing; a failed verify still stores. */
  verify?: boolean
}): Promise<
  | { ok: true; credential: CredentialMutationMeta; verify?: AddVerifyResult }
  | { ok: false; error: string }
> {
  return withReposAndStore(async (repos, store) => {
    // Fetch the platform — addCredential validates the requested kind against
    // its kind-compat matrix before the secret is touched (slice A of
    // increment 28.9). The kind now comes from the caller (the web dialog's
    // Select, pre-filtered to the platform's compatibleKinds).
    const platformResult = await repos.platforms.get(input.platformId)
    if (platformResult.isErr()) {
      input.secret = ""
      const error =
        platformResult.error.kind === "not-found" ? "Platform not found" : "Database error"
      return { ok: false as const, error }
    }
    const platform = platformResult.value

    const result = await addCredential(
      {
        platformId: input.platformId,
        account: input.account,
        kind: input.kind,
        secret: input.secret,
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
      const e = result.error
      if (e.kind === "invalid-input") return { ok: false as const, error: e.reason }
      if (e.kind === "kind-incompatible") {
        return {
          ok: false as const,
          error: `Credential kind "${e.requested}" not accepted for this platform; allowed: ${e.allowed.join(", ")}`,
        }
      }
      return { ok: false as const, error: e.kind }
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
    const verifyResult = (
      await verifyCredential(platform, secret, getPaths(), {
        oauthProviderId: credential.oauthMeta?.providerId,
      })
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
  | { ok: true; platform: Platform; secretRef: string; oauthProviderId?: string }
  | { ok: false; error: string }
> {
  const credResult = await repos.credentials.get(credentialId)
  if (credResult.isErr()) {
    return { ok: false, error: credentialErrorMessage(credResult.error.kind) }
  }
  const credential = credResult.value

  const platformResult = await repos.platforms.get(credential.platformId)
  if (platformResult.isErr()) {
    return {
      ok: false,
      error: platformResult.error.kind === "not-found" ? "Platform not found" : "Database error",
    }
  }

  return {
    ok: true,
    platform: platformResult.value,
    secretRef: credential.secretRef,
    oauthProviderId: credential.oauthMeta?.providerId,
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

export async function testCredential(credentialId: string): Promise<TestCredentialResult> {
  const db = await getDb()
  if (db === null) return { ok: false, error: "Database unavailable" }
  const repos = createRepositories(db)

  const loaded = await loadPlatformForCredential(repos, credentialId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const { platform, secretRef, oauthProviderId } = loaded

  const storeResult = await createCredentialStore(getPaths())
  if (storeResult.isErr()) return { ok: false, error: "Credential store unavailable" }

  const secretResult = await storeResult.value.get(secretRef)
  if (secretResult.isErr()) return { ok: false, error: "Failed to read the stored secret" }
  const secret = secretResult.value

  const result: VerifyOutcome =
    secret === null
      ? { status: "unreachable", detail: STORED_SECRET_MISSING_DETAIL }
      : (await verifyCredential(platform, secret, getPaths(), { oauthProviderId })).unwrapOr({
          status: "unreachable" as const,
          detail: "verify failed unexpectedly",
        })

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

  const detail = outcomeDetail(result)
  return { ok: true, status: result.status, ...(detail !== undefined ? { detail } : {}) }
}
