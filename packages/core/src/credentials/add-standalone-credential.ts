// SPDX-License-Identifier: AGPL-3.0-only
// addStandaloneCredential — create an UNLINKED credential (increment 42,
// Phase 1): a pure secret with no platform. The web `/credentials` "Add
// Credential" dialog's ONLY create path — no platform picker, so there is no
// kind-compat matrix to validate against (that matrix is platform-derived;
// see kind-compat.ts). Every raw, non-oauth2 kind is accepted.
//
// Mirrors addCredential's lifecycle (mint secretRef, store.set FIRST, then
// one DB insert, best-effort cleanup on DB failure) minus the platform-scoped
// steps (kind-compat check, duplicate-ACCOUNT guard, profileName). `name`
// uniqueness is GLOBAL and required — see CredentialSchema's `name` field.

import { errAsync, type ResultAsync } from "neverthrow"
import { ulid } from "ulid"
import type { CredentialError, DbError } from "../errors/index.js"
import { newCredentialId } from "../ids/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential, CredentialKind } from "../schema/credential.js"
import { CredentialSchema } from "../schema/credential.js"
import { validateRawSecretAndName, writeCredential } from "./add-credential.js"
import type { CredentialStore } from "./store.js"

export interface AddStandaloneCredentialInput {
  /** The credential's identity slug — REQUIRED (no derivation path here; the
   *  web standalone dialog always collects it explicitly). */
  name: string
  /** oauth2 is excluded — see addCredential's identical exclusion rationale. */
  kind: Exclude<CredentialKind, "oauth2">
  /** Plaintext secret. Consumed ONLY by CredentialStore.set(); never returned,
   *  never included in any error cause, never written to the DB. */
  secret: string
}

/**
 * Create an unlinked (platformId: null) credential. SECURITY: `input.secret`
 * never appears in the return value, error causes, or logs — same discipline
 * as addCredential.
 */
export function addStandaloneCredential(
  input: AddStandaloneCredentialInput,
  store: CredentialStore,
  credentialsRepo: CredentialsRepo,
): ResultAsync<Credential, CredentialError | DbError> {
  // oauth2 is excluded from every raw-secret path (fixed allowed-list — no
  // platform here to derive it from; see addCredential's platform-derived case).
  if ((input.kind as CredentialKind) === "oauth2") {
    return errAsync({
      kind: "kind-incompatible" as const,
      requested: "oauth2",
      allowed: ["api-key", "bearer", "env", "file"],
    })
  }

  // Shared: 32 KiB file cap + name slug validation (name is REQUIRED here).
  const rawValid = validateRawSecretAndName(input.kind, input.secret, input.name)
  if (!rawValid.ok) return errAsync(rawValid.error)
  // name was supplied (required by AddStandaloneCredentialInput) → validated.
  const name = rawValid.name as string

  const credentialParse = CredentialSchema.safeParse({
    id: newCredentialId(),
    name,
    platformId: null,
    // profileName is write-only legacy (CredentialSchema doc-comment) — a
    // standalone credential has no account label, so this mirrors `name`
    // (never READ for identity; kept only because the column is NOT NULL).
    profileName: name,
    kind: input.kind,
    secretRef: ulid(),
  })
  if (!credentialParse.success) {
    return errAsync({
      kind: "invalid-input" as const,
      reason: credentialParse.error.issues.map((i) => i.message).join(", "),
    })
  }

  // Reuse the shared store-write + rollback primitive (see add-credential.ts).
  // The only per-caller difference is the constraint-violation mapping: this
  // path never had an account, so a name collision surfaces as invalid-input
  // with an honest reason rather than the misleading "duplicate-account" shape.
  return writeCredential(credentialParse.data, input.secret, store, credentialsRepo, (cred) => ({
    kind: "invalid-input" as const,
    reason: `a credential named "${cred.name}" already exists`,
  }))
}
