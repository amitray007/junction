// SPDX-License-Identifier: AGPL-3.0-only
// mintApiKey — the ONLY place a junction API key's plaintext is assembled.
// security.md invariant (mirrors credentials/add-credential.ts): plaintext
// exists only in this call's stack frame + its single return value; never
// stored, never logged, never in any error cause.

import { randomBytes } from "node:crypto"
import { errAsync, type ResultAsync } from "neverthrow"
import type { ApiKeyError, DbError } from "../errors/index.js"
import { newApiKeyId } from "../ids/index.js"
import type { ApiKeyScope, ApiKeysRepo } from "../repositories/api-keys.js"
import { ApiKeyLabelSchema } from "../schema/primitives.js"
import { sha256Hex } from "./hash.js"

export type MintApiKeyInput = {
  label: string
  scope: ApiKeyScope
  /** Already-deduped distinct profile-id set (§1) — caller's responsibility.
   *  'profile' → exactly 1; 'profiles' → ≥2; 'global' → any (typically 0+). */
  profileIds: string[]
}

export type MintedApiKey = {
  /** The full `jct_<keyid>_<secret>` token. Returned ONCE — never persisted. */
  plaintext: string
  meta: {
    id: string
    label: string
    scope: ApiKeyScope
    createdAt: number
  }
}

/**
 * Mint a new junction API key.
 *
 * 1. Validate the label (ApiKeyLabelSchema).
 * 2. Mint a fresh ApiKeyId (keyid) + a 256-bit random secret
 *    (base64url(randomBytes(32))).
 * 3. Hash the secret (sha256 hex) — the DB row stores ONLY the hash.
 * 4. Persist the key row + scope join rows in one transaction (repo.create).
 * 5. Assemble the plaintext token ONCE and return it — never logged, never
 *    stored, never included in any error.
 */
export function mintApiKey(
  input: MintApiKeyInput,
  repo: ApiKeysRepo,
): ResultAsync<MintedApiKey, ApiKeyError | DbError> {
  const labelParse = ApiKeyLabelSchema.safeParse(input.label)
  if (!labelParse.success) {
    return errAsync({
      kind: "invalid-format" as const,
      reason: labelParse.error.issues.map((i) => i.message).join(", "),
    })
  }

  const keyId = newApiKeyId()
  const secret = randomBytes(32).toString("base64url")
  const secretHash = sha256Hex(secret)
  const createdAt = Date.now()

  return repo
    .create({
      id: keyId,
      label: labelParse.data,
      secretHash,
      scope: input.scope,
      createdAt,
      profileIds: input.profileIds,
    })
    .map((record) => ({
      // Assembled once, returned once — the ONLY place this string exists.
      plaintext: `jct_${keyId}_${secret}`,
      meta: {
        id: record.id,
        label: record.label,
        scope: record.scope,
        createdAt: record.createdAt,
      },
    }))
    .mapErr((dbErr): ApiKeyError | DbError => dbErr)
}
