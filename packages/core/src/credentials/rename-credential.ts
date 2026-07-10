// SPDX-License-Identifier: AGPL-3.0-only
// renameCredential — edit a credential's account LABEL (profileName) in place.
//
// This is the ONLY editable metadata (increment 29 follow-up, Task 5). It is a
// pure display/organization label with no token-integrity coupling and no
// uniqueness constraint, so it can be changed freely without touching the
// secret, the OAuth tokens, or any *Ref.
//
// DELIBERATELY NOT editable in place:
//   - the secret            → rotate-only (rotateCredential); a deliberate boundary.
//   - the oauth client_id    → changing it orphans the tokens minted against the
//                              old client_id; that is really "swap OAuth app",
//                              which `credential reconnect --client-id` / the web
//                              "use different credentials" flow already handles
//                              (Task 4), re-minting tokens against the new app.
//   - platformId / kind      → structural identity; a different platform/kind is
//                              a different credential (add a new one).

import { errAsync, type ResultAsync } from "neverthrow"
import type { CredentialError, DbError } from "../errors/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential } from "../schema/credential.js"

export interface RenameCredentialInput {
  /** ID of the credential to rename. */
  credentialId: string
  /** The new account label (profileName), e.g. "work" → "work-primary". */
  account: string
}

/**
 * Rename a credential's account label (profileName) in place.
 *
 * Validates the new label (non-empty after trim), then reads the credential
 * (to learn its platformId, so the duplicate-account guard below can scope
 * correctly) before writing via the repo's setProfileName (read-before-write,
 * so a missing credential surfaces as not-found). Returns the updated
 * Credential (metadata only — no secret ever enters this path).
 *
 * DUPLICATE-ACCOUNT GUARD (32.13 Slice B2): mirrors addCredential's
 * forPlatform pre-check, but EXCLUDES the credential's OWN id from the
 * collision set — renaming a credential to its EXISTING label must be a
 * no-op success, not a false "duplicate" (it always collides with itself).
 * Without this guard, the rename write would fall through to the DB's
 * `credentials_platform_profile_unique` index (32.9) and surface the
 * generic/wrong "constraint violation (check that referenced
 * platform/credential/profile exists)" — actively misleading, since nothing
 * referenced is missing; the real cause is a sibling credential already
 * holding that label.
 */
export function renameCredential(
  input: RenameCredentialInput,
  credentialsRepo: CredentialsRepo,
): ResultAsync<Credential, CredentialError | DbError> {
  const account = input.account.trim()
  if (account === "") {
    return errAsync({
      kind: "invalid-input" as const,
      reason: "account label must not be empty",
    })
  }
  return credentialsRepo.get(input.credentialId).andThen((current) => {
    // Rename-to-own-label is always a no-op success — never a false collision.
    if (current.profileName === account) {
      return credentialsRepo.setProfileName(input.credentialId, account)
    }
    return credentialsRepo
      .forPlatform(current.platformId)
      .andThen((existing): ResultAsync<Credential, CredentialError | DbError> => {
        const duplicate = existing.some((c) => c.id !== current.id && c.profileName === account)
        if (duplicate) {
          return errAsync({
            kind: "duplicate-account" as const,
            platformId: String(current.platformId),
            account,
          })
        }
        return credentialsRepo.setProfileName(input.credentialId, account)
      })
  })
}
