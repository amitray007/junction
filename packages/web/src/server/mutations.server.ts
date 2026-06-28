// SPDX-License-Identifier: AGPL-3.0-only
// Server-only mutation helpers — the ONLY place in @junction/web that calls core
// write operations (addCredential, removeCredential, rotateCredential).
// Called exclusively from mutations.functions.ts createServerFn handlers.
// SECURITY: all credential output is metadata-only — no secret, no secretRef.

import {
  addCredential,
  type Credential,
  type CredentialStore,
  createCredentialStore,
  createRepositories,
  getPaths,
  removeCredential,
  rotateCredential,
} from "@junction/core"
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
    default:
      return "Operation failed"
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function mutateAddCredential(input: {
  platformId: string
  account: string
  kind: "bearer"
  secret: string
}): Promise<{ ok: true; credential: CredentialMutationMeta } | { ok: false; error: string }> {
  return withReposAndStore(async (repos, store) => {
    const result = await addCredential(
      {
        platformId: input.platformId,
        account: input.account,
        kind: "bearer",
        secret: input.secret,
      },
      store,
      repos.credentials,
    )
    // Drop our reference to the secret (best-effort hygiene; JS strings are
    // immutable and not zeroable — the real guarantee is that the secret never
    // enters the return value or error).
    input.secret = ""
    if (result.isErr()) {
      const e = result.error
      return { ok: false as const, error: e.kind === "invalid-input" ? e.reason : e.kind }
    }
    return { ok: true as const, credential: toMutationMeta(result.value) }
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
