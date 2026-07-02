// SPDX-License-Identifier: AGPL-3.0-only
// verifyApiKey — parse → PK lookup → revoked check → timingSafeEqual → load scope.
// Called on EVERY HTTP request to /mcp (mcp/server serve-http.ts) — must be fast
// (no KDF) and fail closed on every branch (§2.1, §3).

import { timingSafeEqual } from "node:crypto"
import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import type { ApiKeyError, DbError } from "../errors/index.js"
import type { ApiKeyScope, ApiKeysRepo } from "../repositories/api-keys.js"
import { sha256Hex } from "./hash.js"

/**
 * Token shape: `jct_<keyid>_<secret>`.
 * keyid = 26-char Crockford-base32 ULID (charset excludes `_`), so the FIRST
 * two `_` delimiters split deterministically even though base64url secrets
 * may themselves contain `_` (§2.1).
 */
const TOKEN_RE = /^jct_([0-9A-HJKMNP-TV-Z]{26})_(.+)$/

export type ResolvedKey = {
  keyId: string
  label: string
  scope: ApiKeyScope
  profileIds: string[]
}

/** Parse a `jct_<keyid>_<secret>` token into its keyid + secret parts. */
export function parseApiKeyToken(
  token: string,
): { keyId: string; secret: string } | { keyId: undefined; secret: undefined } {
  const match = TOKEN_RE.exec(token)
  if (!match) return { keyId: undefined, secret: undefined }
  const keyId = match[1]
  const secret = match[2]
  if (keyId === undefined || secret === undefined) return { keyId: undefined, secret: undefined }
  return { keyId, secret }
}

/**
 * Verify a presented token and resolve its scope.
 *
 * Order (fail closed at every step, §2.1 + §3):
 *   1. Parse — malformed token → invalid-format.
 *   2. PK lookup by keyid — unknown → unknown-key (timing on existence is
 *      acceptable; the keyid is public).
 *   3. revoked_at IS NULL — revoked → revoked.
 *   4. timingSafeEqual(sha256(secret), stored_hash) — both fixed-length
 *      Buffers (sha256 hex digests are always 64 chars) — mismatch → unknown-key
 *      (do NOT distinguish "wrong secret" from "unknown key" — uniform 401
 *      at the HTTP boundary either way).
 *   5. Load scope profile-ids. `empty-scope` fires ONLY for scope kinds
 *      'profile'/'profiles' with 0 surviving rows (cascade emptied them out).
 *      A 'global' key with 0 rows is a VALID session with an empty tool list.
 */
export function verifyApiKey(
  token: string,
  repo: ApiKeysRepo,
): ResultAsync<ResolvedKey, ApiKeyError | DbError> {
  const { keyId, secret } = parseApiKeyToken(token)
  if (keyId === undefined || secret === undefined) {
    return errAsync({
      kind: "invalid-format" as const,
      reason: "token does not match jct_<keyid>_<secret>",
    })
  }

  return repo
    .getByKeyId(keyId)
    .orElse((dbErr): ResultAsync<never, ApiKeyError | DbError> => {
      if (dbErr.kind === "not-found") return errAsync({ kind: "unknown-key" as const })
      return errAsync(dbErr)
    })
    .andThen((record) => {
      if (record.revokedAt !== null) {
        return errAsync<never, ApiKeyError | DbError>({ kind: "revoked" as const })
      }

      const presentedHash = Buffer.from(sha256Hex(secret), "utf8")
      const storedHash = Buffer.from(record.secretHash, "utf8")
      // Both are fixed-size hex digests (64 chars) — lengths are always equal,
      // but guard anyway since timingSafeEqual throws on length mismatch.
      const matches =
        presentedHash.length === storedHash.length && timingSafeEqual(presentedHash, storedHash)
      if (!matches) {
        return errAsync<never, ApiKeyError | DbError>({ kind: "unknown-key" as const })
      }

      return repo.getScopeProfileIds(record.id).andThen((profileIds) => {
        const scope = record.scope
        // empty-scope fires ONLY for 'profile'/'profiles' kinds with 0 surviving
        // rows (cascade emptied the scope out). A 'global' key with 0 rows is a
        // VALID session with an empty tool list — it grows as profiles are added.
        if ((scope === "profile" || scope === "profiles") && profileIds.length === 0) {
          return errAsync<ResolvedKey, ApiKeyError | DbError>({ kind: "empty-scope" as const })
        }
        return okAsync<ResolvedKey, ApiKeyError | DbError>({
          keyId: record.id,
          label: record.label,
          scope,
          profileIds,
        })
      })
    })
}
