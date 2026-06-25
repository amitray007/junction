// SPDX-License-Identifier: AGPL-3.0-only
// addCredential — the ONLY place where a plaintext secret flows into the credential layer.
// security.md invariant: plaintext lives only in this call's stack frame;
// never returned, never logged, never in any error cause, never in the DB.

import { errAsync, type ResultAsync } from "neverthrow"
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
 * 1. Mint an opaque secretRef (ULID) — this is what the DB row stores.
 * 2. Persist the secret in the CredentialStore (keyring or encrypted-file).
 * 3. Insert a Credential DB row with only the secretRef (never the secret).
 *
 * On DB failure: best-effort CredentialStore.delete(secretRef) to avoid orphaned
 * store entries. If the cleanup itself fails, the secretRef is unreachable but
 * the plaintext is not leaked — the store entry is simply orphaned.
 *
 * SECURITY: `input.secret` never appears in the return value, error causes, or logs.
 */
export function addCredential(
  input: AddCredentialInput,
  store: CredentialStore,
  credentialsRepo: CredentialsRepo,
): ResultAsync<Credential, CredentialError | DbError> {
  const secretRef = ulid()
  const credentialId = newCredentialId()
  const platformId = PlatformIdSchema.parse(input.platformId)

  const credential = CredentialSchema.parse({
    id: credentialId,
    platformId,
    profileName: input.account,
    kind: input.kind,
    secretRef,
  })

  return store.set(secretRef, input.secret).andThen(() =>
    credentialsRepo
      .create(credential)
      .orElse((dbErr): ResultAsync<Credential, CredentialError | DbError> => {
        // Best-effort cleanup: remove the orphaned store entry.
        // We ignore the cleanup result — the DB error is what we propagate.
        void store.delete(secretRef)
        return errAsync(dbErr)
      }),
  )
}
