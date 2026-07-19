// SPDX-License-Identifier: AGPL-3.0-only
// renameCredential — edit a credential's identity `name` in place.
//
// This is the ONLY editable identity metadata (increment 29 follow-up, Task
// 5; re-pointed onto `name` by increment 46, Fable RA — the old profileName
// "account label" concept is gone, and a credential's account identity IS its
// `name`). It is a pure display/organization label with no token-integrity
// coupling, so it can be changed freely without touching the secret, the
// OAuth tokens, or any *Ref — but its GLOBAL uniqueness IS enforced (the
// `credentials_name_unique` index), unlike the old profileName rename.
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
import { CredentialNameSchema } from "../schema/credential.js"

export interface RenameCredentialInput {
  /** ID of the credential to rename. */
  credentialId: string
  /** The new identity name, e.g. "gh-work" → "gh-work-primary". */
  account: string
}

/**
 * Rename a credential's identity `name` in place.
 *
 * Validates the new name against `CredentialNameSchema` (trimmed first —
 * the schema itself doesn't trim), then reads the credential so a rename to
 * its OWN existing name is a no-op success (never a false "duplicate" — it
 * always collides with itself). Otherwise runs a friendly global `list()`
 * pre-check for a `duplicate-name` error BEFORE the write, with the DB's
 * `credentials_name_unique` index as the backstop for a race that slips past
 * the pre-check (surfaced via `setName`'s `constraint-violation` mapping).
 * Returns the updated Credential (metadata only — no secret ever enters this
 * path).
 */
export function renameCredential(
  input: RenameCredentialInput,
  credentialsRepo: CredentialsRepo,
): ResultAsync<Credential, CredentialError | DbError> {
  const trimmed = input.account.trim()
  const nameParse = CredentialNameSchema.safeParse(trimmed)
  if (!nameParse.success) {
    return errAsync({
      kind: "invalid-input" as const,
      reason: `invalid name: ${nameParse.error.issues.map((i) => i.message).join(", ")}`,
    })
  }
  const name = nameParse.data

  // DB backstop: a `credentials_name_unique` violation that slips past the
  // list() pre-check below (e.g. a concurrent rename racing this call's read)
  // surfaces from setName as a raw `constraint-violation` DbError — remapped
  // here to the SAME typed `duplicate-name` shape as the pre-check, so every
  // caller sees one uniform error regardless of which path caught it.
  const setNameOrDuplicate = (
    id: string,
    newName: string,
  ): ResultAsync<Credential, CredentialError | DbError> =>
    credentialsRepo.setName(id, newName).orElse((dbErr) => {
      if (dbErr.kind === "constraint-violation") {
        return errAsync({ kind: "duplicate-name" as const, name: newName })
      }
      return errAsync(dbErr)
    })

  return credentialsRepo.get(input.credentialId).andThen((current) => {
    // Rename-to-own-name is always a no-op success — never a false collision.
    if (current.name === name) {
      return setNameOrDuplicate(input.credentialId, name)
    }
    // Increment 46 — global uniqueness pre-check (name identity is no longer
    // platform-scoped; the old per-platform duplicate-account guard collapsed
    // into `credentials_name_unique`, which spans every credential).
    return credentialsRepo
      .list()
      .andThen((all): ResultAsync<Credential, CredentialError | DbError> => {
        const duplicate = all.some((c) => c.id !== current.id && c.name === name)
        if (duplicate) {
          return errAsync({ kind: "duplicate-name" as const, name })
        }
        return setNameOrDuplicate(input.credentialId, name)
      })
  })
}
