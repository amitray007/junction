// SPDX-License-Identifier: AGPL-3.0-only
// rotateCredential — swap a credential's secret in place.
//
// SECURITY invariants (symmetric with addCredential):
//   1. Look up the row FIRST to capture the current secretRef.
//   2. Write the NEW secret to the store under a FRESH secretRef FIRST.
//   3. Repoint the DB row to the new secretRef.
//      - On DB failure: delete the new store entry (best-effort) and return the
//        DB error, leaving the OLD secretRef intact (credential still resolves).
//   4. On DB success: delete the OLD store entry (best-effort, like removeCredential).
//
// ATOMICITY / FAIL-SAFETY: the old secret is never orphaned. If the DB update
// fails after the store write, the new store entry is cleaned up and the old
// secretRef (pointing to the old secret) remains the live reference.
//
// SECRET DISCIPLINE: `input.newSecret` is consumed ONLY by CredentialStore.set();
// it NEVER appears in the return value, any error cause, or any log.

import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { ulid } from "ulid"
import type { CredentialError, DbError } from "../errors/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential } from "../schema/credential.js"
import type { CredentialStore } from "./store.js"

export interface RotateCredentialInput {
  /** ID of the credential to rotate. */
  credentialId: string
  /**
   * The new plaintext secret. Consumed ONLY by CredentialStore.set(); never
   * returned, never included in any error cause, never written to the DB.
   */
  newSecret: string
}

/**
 * Rotate a credential's secret in place:
 *
 * 1. Look up the credential row (captures the old secretRef).
 * 2. Mint a fresh secretRef (ULID) and write the new secret to the store.
 * 3. Repoint the DB row to the new secretRef.
 *    - On DB failure: delete the new store entry (best-effort cleanup) and
 *      propagate the DB error — the OLD secretRef remains active.
 * 4. On DB success: delete the OLD store entry (best-effort; a stranded entry
 *    is preferable to surfacing a confusing error, like removeCredential).
 *
 * Returns the updated Credential (metadata only; no secret, no secretRef in
 * any error cause).
 *
 * SECURITY: `input.newSecret` never appears in the return value, error causes,
 * or logs.
 */
export function rotateCredential(
  input: RotateCredentialInput,
  store: CredentialStore,
  credentialsRepo: CredentialsRepo,
): ResultAsync<Credential, CredentialError | DbError> {
  // Step 1: fetch the row to capture the current secretRef and validate existence.
  return credentialsRepo.get(input.credentialId).andThen((existing) => {
    const oldSecretRef = existing.secretRef
    const newSecretRef = ulid()

    // Step 2: write the new secret to the store FIRST.
    return store.set(newSecretRef, input.newSecret).andThen(() =>
      // Step 3: repoint the DB row to the new secretRef.
      credentialsRepo
        .setSecretRef(input.credentialId, newSecretRef)
        .orElse(
          (dbErr): ResultAsync<Credential, CredentialError | DbError> =>
            // DB repoint failed AFTER the new store write: clean up the new entry
            // (best-effort, swallow), then propagate the original DB error.
            // Old secretRef stays live → credential still resolves.
            store
              .delete(newSecretRef)
              .orElse((): ResultAsync<void, never> => okAsync(undefined))
              .andThen(() => errAsync(dbErr)),
        )
        .andThen((updated) =>
          // Step 4: DB updated → delete the OLD store entry (best-effort, swallow).
          store
            .delete(oldSecretRef)
            .orElse((): ResultAsync<void, never> => okAsync(undefined))
            .map(() => updated),
        ),
    )
  })
}
