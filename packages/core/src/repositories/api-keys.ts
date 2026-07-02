// SPDX-License-Identifier: AGPL-3.0-only
// API keys repository — junction's own auth keys (increment 27).
// dry.md: no generic base; follows the same neverthrow ResultAsync<T, DbError>
// shape as the other repos. secretHash is the only secret-adjacent column —
// the plaintext secret NEVER reaches this layer (see core/src/api-keys/mint.ts).

import { eq } from "drizzle-orm"
import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { mapDbError } from "../db/errors.js"
import type { Db } from "../db/index.js"
import { apiKeyProfiles, apiKeys } from "../db/schema.js"
import type { DbError } from "../errors/index.js"

export type ApiKeyScope = "profile" | "profiles" | "global"

export type ApiKeyRecord = {
  id: string
  label: string
  secretHash: string
  scope: ApiKeyScope
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export type CreateApiKeyInput = {
  id: string
  label: string
  secretHash: string
  scope: ApiKeyScope
  createdAt: number
  /** Already-deduped distinct profile-id set — caller's responsibility (§1). */
  profileIds: string[]
}

function rowToRecord(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    secretHash: row.secretHash,
    scope: row.scope as ApiKeyScope,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
}

export function createApiKeysRepo(db: Db) {
  return {
    /**
     * Insert the key row + its scope join rows in ONE transaction.
     * The caller (core's mintApiKey) passes an already-deduped distinct
     * profile-id set — this repo does not dedupe or validate scope arity.
     */
    create(input: CreateApiKeyInput): ResultAsync<ApiKeyRecord, DbError> {
      try {
        const row = {
          id: input.id,
          label: input.label,
          secretHash: input.secretHash,
          scope: input.scope,
          createdAt: input.createdAt,
          lastUsedAt: null,
          revokedAt: null,
        }
        db.transaction((tx) => {
          tx.insert(apiKeys).values(row).run()
          for (const profileId of input.profileIds) {
            tx.insert(apiKeyProfiles).values({ apiKeyId: input.id, profileId }).run()
          }
        })
        // Single source of the record shape (rowToRecord) — the inserted row is
        // known-good (we just wrote it), so no read-back needed.
        return okAsync(rowToRecord(row))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    list(): ResultAsync<ApiKeyRecord[], DbError> {
      try {
        const rows = db.select().from(apiKeys).all()
        return okAsync(rows.map(rowToRecord))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /** PK lookup by keyid — the O(1) path `verifyApiKey` uses on every request. */
    getByKeyId(id: string): ResultAsync<ApiKeyRecord, DbError> {
      try {
        const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
        if (!row) return errAsync({ kind: "not-found" as const, entity: "api-key", id })
        return okAsync(rowToRecord(row))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /** The scope profile-ids referenced by a key (join rows). */
    getScopeProfileIds(apiKeyId: string): ResultAsync<string[], DbError> {
      try {
        const rows = db
          .select({ profileId: apiKeyProfiles.profileId })
          .from(apiKeyProfiles)
          .where(eq(apiKeyProfiles.apiKeyId, apiKeyId))
          .all()
        return okAsync(rows.map((r) => r.profileId))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Revoke a key by setting revokedAt. Idempotent: revoking an already-revoked
     * (or already-revoked-then-revoked-again) key still succeeds — the
     * timestamp is simply overwritten to "now" again. Unknown keyid → not-found.
     */
    revoke(id: string): ResultAsync<void, DbError> {
      try {
        const existing = db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, id)).get()
        if (!existing) return errAsync({ kind: "not-found" as const, entity: "api-key", id })
        db.update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, id)).run()
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Best-effort last-used bookkeeping. MUST NEVER fail or delay the auth
     * decision it follows (§2.1) — callers should fire-and-forget this and
     * swallow any Err rather than propagate it into the request path.
     */
    touchLastUsed(id: string): ResultAsync<void, DbError> {
      try {
        db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, id)).run()
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Diagnostic helper: how many DISTINCT keys reference a given profile
     * (used by the web delete-profile confirm warning — "N key(s) reference
     * this profile and will lose it"). Not part of the mint/verify/revoke
     * critical path.
     */
    countReferencingProfile(profileId: string): ResultAsync<number, DbError> {
      try {
        const rows = db
          .select({ apiKeyId: apiKeyProfiles.apiKeyId })
          .from(apiKeyProfiles)
          .where(eq(apiKeyProfiles.profileId, profileId))
          .all()
        const distinctKeyIds = new Set(rows.map((r) => r.apiKeyId))
        return okAsync(distinctKeyIds.size)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },
  }
}

export type ApiKeysRepo = ReturnType<typeof createApiKeysRepo>
