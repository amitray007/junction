// SPDX-License-Identifier: AGPL-3.0-only
// removeCredential — the reverse of addCredential.
//
// SECURITY invariants (symmetric with addCredential):
//   1. Fetch the credential row FIRST (to capture secretRef before any deletion).
//   2. Attempt the DB delete FIRST (enforces RESTRICT).
//      - On in-use (RESTRICT): return the typed error; do NOT touch the store.
//        The credential still exists and is referenced by a source_ref.
//      - On not-found: return the typed not-found error; nothing to clean up.
//   3. Only on a successful DB delete: delete the secret from the store (best-effort).
//      A store-delete failure is ignored — the DB row is already gone and is the
//      authority; a stranded store entry is preferable to a broken operation.
//
// SECRET DISCIPLINE: secretRef is captured internally and passed to store.delete.
// It never appears in any error cause, log, or return value.

import { okAsync, type ResultAsync } from "neverthrow"
import type { DbError } from "../errors/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { CredentialStore } from "./store.js"

/**
 * Remove a credential by ID: delete the DB row (enforces RESTRICT FK), then
 * delete its secret from the store on success.
 *
 * Error paths:
 *   - not-found → credential does not exist (DbError)
 *   - in-use    → a source_ref still references this credential (DbError);
 *                 the secret is NOT deleted
 *   - query-failed → unexpected DB error (DbError)
 *
 * Store-delete failures are best-effort ignored (the DB row is authoritative).
 */
export function removeCredential(
  id: string,
  store: CredentialStore,
  credentialsRepo: CredentialsRepo,
): ResultAsync<void, DbError> {
  // Step 1: fetch the row to get the secretRef (needed for store cleanup).
  return credentialsRepo.get(id).andThen((credential) => {
    const secretRef = credential.secretRef
    // Step 2: attempt the DB delete (RESTRICT FK enforced here).
    // On in-use or not-found error → chain short-circuits; store NOT touched.
    return credentialsRepo.delete(id).andThen(() => {
      // Step 3: DB row gone → delete the secret from the store (best-effort).
      return store
        .delete(secretRef)
        .orElse((_cleanupErr): ResultAsync<void, never> => okAsync(undefined))
    })
  })
}
