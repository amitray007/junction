// SPDX-License-Identifier: AGPL-3.0-only
// Server-only API-key mutation helpers — mint/revoke junction's own auth keys.
// Called exclusively from keys-mutations.functions.ts createServerFn handlers.
//
// SECURITY (§3 of docs/methods/27-junction-keys-single-endpoint.md):
// - mint is the ONE exception to metadata-only: its response carries the plaintext
//   key exactly once. secretHash NEVER appears in any response, here or elsewhere.
// - Everything else in this file returns metadata-only shapes.

import {
  type ApiKeyError,
  type ApiKeyScope,
  createRepositories,
  type DbError,
  mintApiKey,
} from "@junction/core"
import { getDb } from "./shared.server.js"

async function withKeysRepo<T>(
  fn: (repos: ReturnType<typeof createRepositories>) => Promise<T>,
): Promise<T> {
  const db = await getDb()
  if (db === null) throw new Error("Database unavailable")
  return fn(createRepositories(db))
}

// ---------------------------------------------------------------------------
// Error message helper — mintApiKey returns ApiKeyError | DbError; map both
// kind spaces to human-readable strings (exhaustive switch, no default —
// docs/rules/ bans `default` on exhaustive switches).
// ---------------------------------------------------------------------------

function apiKeyErrorMessage(kind: (ApiKeyError | DbError)["kind"]): string {
  switch (kind) {
    case "invalid-format":
      return "Invalid key or label"
    case "unknown-key":
      return "Unknown API key"
    case "revoked":
      return "API key already revoked"
    case "empty-scope":
      return "Key scope is empty"
    case "not-found":
      return "API key not found"
    case "db-error":
      return "Database error"
    case "migration-failed":
    case "constraint-violation":
    case "in-use":
    case "duplicate-namespace":
    case "query-failed":
      return "Database error"
  }
}

// ---------------------------------------------------------------------------
// Metadata-only shape — NEVER secretHash, NEVER plaintext.
// ---------------------------------------------------------------------------

export type ApiKeyMeta = {
  id: string
  label: string
  scope: ApiKeyScope
  profileIds: string[]
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export async function readApiKeys(): Promise<ApiKeyMeta[]> {
  return withKeysRepo(async (repos) => {
    const listResult = await repos.apiKeys.list()
    if (listResult.isErr()) return []

    const records = listResult.value
    const scopesByKey = await Promise.all(
      records.map(async (r) => {
        const scopeResult = await repos.apiKeys.getScopeProfileIds(r.id)
        return scopeResult.isOk() ? scopeResult.value : []
      }),
    )

    return records.map((r, i) => ({
      id: r.id,
      label: r.label,
      scope: r.scope,
      profileIds: scopesByKey[i] ?? [],
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }))
  })
}

// ---------------------------------------------------------------------------
// Mint — the ONE exception to metadata-only. Returns the plaintext key once.
// ---------------------------------------------------------------------------

export type MintKeyResult =
  | { ok: true; plaintext: string; meta: ApiKeyMeta }
  | { ok: false; error: string }

export async function mutateMintKey(input: {
  label: string
  scope: ApiKeyScope
  profileIds: string[]
}): Promise<MintKeyResult> {
  return withKeysRepo(async (repos) => {
    const result = await mintApiKey(
      { label: input.label, scope: input.scope, profileIds: input.profileIds },
      repos.apiKeys,
    )
    if (result.isErr()) {
      return { ok: false as const, error: apiKeyErrorMessage(result.error.kind) }
    }
    const { plaintext, meta } = result.value
    return {
      ok: true as const,
      plaintext,
      meta: {
        id: meta.id,
        label: meta.label,
        scope: meta.scope,
        profileIds: input.profileIds,
        createdAt: meta.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Revoke — idempotent; keyid or full token (secret discarded, keyid parsed).
// ---------------------------------------------------------------------------

export async function mutateRevokeKey(
  keyId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withKeysRepo(async (repos) => {
    const result = await repos.apiKeys.revoke(keyId)
    if (result.isErr()) {
      return {
        ok: false as const,
        error: result.error.kind === "not-found" ? "API key not found" : "Database error",
      }
    }
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------
// Diagnostic: how many keys reference a given profile (delete-profile warning).
// ---------------------------------------------------------------------------

export async function countKeysReferencingProfile(profileId: string): Promise<number> {
  return withKeysRepo(async (repos) => {
    const result = await repos.apiKeys.countReferencingProfile(profileId)
    return result.isOk() ? result.value : 0
  })
}
