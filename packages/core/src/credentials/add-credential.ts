// SPDX-License-Identifier: AGPL-3.0-only
// addCredential — the ONLY place where a plaintext secret flows into the credential layer.
// security.md invariant: plaintext lives only in this call's stack frame;
// never returned, never logged, never in any error cause, never in the DB.

import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { ulid } from "ulid"
import type { CredentialError, DbError } from "../errors/index.js"
import { newCredentialId } from "../ids/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential } from "../schema/credential.js"
import { CredentialSchema } from "../schema/credential.js"
import { PlatformIdSchema } from "../schema/primitives.js"
import type { CredentialStore } from "./store.js"

export interface AddCredentialInput {
  /** FK → Platform */
  platformId: string
  /**
   * Logical account label, e.g. "work", "personal", "client-acme".
   * Stored as profileName in the Credential row.
   */
  account: string
  /** Authentication kind — "bearer" for PAT/API-token flow */
  kind: "bearer"
  /**
   * Plaintext secret. Consumed ONLY by CredentialStore.set(); never returned,
   * never included in any error cause, never written to the DB.
   */
  secret: string
}

/**
 * Orchestrates the credential creation lifecycle:
 *
 * 1. Validate platformId and account — return a typed Err on invalid input
 *    (so bad input is caught BEFORE the secret is ever touched by the store).
 * 2. Mint an opaque secretRef (ULID) — this is what the DB row stores.
 * 3. Persist the secret in the CredentialStore (keyring or encrypted-file).
 * 4. Insert a Credential DB row with only the secretRef (never the secret).
 *
 * On DB failure: awaits CredentialStore.delete(secretRef) before propagating
 * the original dbErr (cleanup is deterministic; cleanup failure is ignored but
 * the await ensures it completes).
 *
 * SECURITY: `input.secret` never appears in the return value, error causes, or logs.
 */
export function addCredential(
  input: AddCredentialInput,
  store: CredentialStore,
  credentialsRepo: CredentialsRepo,
): ResultAsync<Credential, CredentialError | DbError> {
  // Validate platform ID before touching the secret — bad input exits early.
  const platformParse = PlatformIdSchema.safeParse(input.platformId)
  if (!platformParse.success) {
    return errAsync({
      kind: "invalid-input" as const,
      reason: `invalid platformId: ${platformParse.error.issues.map((i) => i.message).join(", ")}`,
    })
  }

  // Validate the full credential shape (defensive; CLI pre-validates, but we
  // must not trust the caller).
  const credentialParse = CredentialSchema.safeParse({
    id: newCredentialId(),
    platformId: platformParse.data,
    profileName: input.account,
    kind: input.kind,
    secretRef: ulid(), // mint secretRef here so it's validated too
  })
  if (!credentialParse.success) {
    return errAsync({
      kind: "invalid-input" as const,
      reason: credentialParse.error.issues.map((i) => i.message).join(", "),
    })
  }

  const credential = credentialParse.data

  return store.set(credential.secretRef, input.secret).andThen(() =>
    credentialsRepo
      .create(credential)
      .orElse((dbErr): ResultAsync<Credential, CredentialError | DbError> => {
        // Best-effort cleanup: await the delete so cleanup is deterministic.
        // A delete failure is ignored (best-effort) — the original DB error is
        // what we propagate; don't mask it with a cleanup error.
        return store
          .delete(credential.secretRef)
          .orElse((_cleanupErr): ResultAsync<void, never> => okAsync(undefined))
          .andThen(() => errAsync(dbErr))
      }),
  )
}
