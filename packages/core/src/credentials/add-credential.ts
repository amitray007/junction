// SPDX-License-Identifier: AGPL-3.0-only
// addCredential — the ONLY place where a plaintext secret flows into the credential layer.
// security.md invariant: plaintext lives only in this call's stack frame;
// never returned, never logged, never in any error cause, never in the DB.

import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { ulid } from "ulid"
import type { CredentialError, DbError } from "../errors/index.js"
import { newCredentialId } from "../ids/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Credential, CredentialKind } from "../schema/credential.js"
import { CredentialSchema } from "../schema/credential.js"
import type { Platform } from "../schema/platform.js"
import { PlatformIdSchema } from "../schema/primitives.js"
import { compatibleCredentialKinds, isKindAccepted } from "./kind-compat.js"
import type { CredentialStore } from "./store.js"

export interface AddCredentialInput {
  /** FK → Platform */
  platformId: string
  /**
   * Logical account label, e.g. "work", "personal", "client-acme".
   * Stored as profileName in the Credential row.
   */
  account: string
  /**
   * Authentication kind. oauth2 is excluded from this path DELIBERATELY, even
   * though the kind-compat MATRIX accepts it as of inc 29 (a platform can
   * declare oauth2 and the web picker can show it): there is no single
   * plaintext "secret" for OAuth — access token, refresh token, and BYO
   * client_secret are three separate refs (OAuthMetaSchema), not one string
   * this call's shape can carry. OAuth credentials are minted via a separate
   * connect/addOAuthCredential entry path (source-runtime/cli, inc 29 slice
   * B+), never through this plaintext-secret path. Every other kind is
   * validated against the platform's kind-compat matrix (see kind-compat.ts)
   * before the secret is touched.
   */
  kind: Exclude<CredentialKind, "oauth2">
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
  platform: Platform,
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

  // Runtime belt-and-suspenders: input.kind's TYPE excludes "oauth2" (see the
  // Exclude<CredentialKind,"oauth2"> comment above), but a caller can bypass
  // the type system (e.g. `as never`). isKindAccepted no longer special-cases
  // oauth2 — the matrix is honest about it (inc 29) — so an oauth2-scheme
  // platform's matrix WOULD accept "oauth2" if this guard didn't exist here.
  // This path stores exactly one plaintext secret at one ref; OAuth needs
  // three (access/refresh/client_secret), so oauth2 must never reach the
  // store write below regardless of what the matrix says.
  if ((input.kind as CredentialKind) === "oauth2") {
    return errAsync({
      kind: "kind-incompatible" as const,
      requested: "oauth2",
      allowed: Array.from(new Set([...compatibleCredentialKinds(platform), "bearer"])),
    })
  }

  // Kind-compat validation BEFORE the secret is touched — security-relevant
  // validation lives here (not duplicated at the cli/web edges). "bearer" is
  // always accepted (legacy back-compat), handled inside isKindAccepted.
  if (!isKindAccepted(platform, input.kind)) {
    return errAsync({
      kind: "kind-incompatible" as const,
      requested: input.kind,
      allowed: Array.from(new Set([...compatibleCredentialKinds(platform), "bearer"])),
    })
  }

  // 32 KiB cap on kind "file" content, BEFORE any store write — fits macOS
  // Keychain AND Linux keyutils' ~32 KiB item ceiling (see method file 28.9).
  // Reuses "invalid-input" (least invasive — avoids widening the exhaustive
  // CredentialError formatters for a single new variant).
  if (input.kind === "file") {
    const byteLength = Buffer.byteLength(input.secret, "utf8")
    const FILE_SECRET_MAX_BYTES = 32 * 1024
    if (byteLength > FILE_SECRET_MAX_BYTES) {
      return errAsync({
        kind: "invalid-input" as const,
        reason: `file credential exceeds 32 KiB (got ${byteLength} bytes)`,
      })
    }
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

  // Duplicate-account guard (increment 30.12) — BEFORE the secret ever
  // touches the store. Compares the EXACT stored `profileName` against the
  // EXACT `input.account` as this call will store it (credential.profileName,
  // post-Zod-parse but otherwise untrimmed) — addCredential does NOT trim
  // `account` today, so the guard must not trim either; trimming here while
  // the write doesn't would let a trailing-space label slip past the guard
  // and then store a DIFFERENT string than what was checked. Case-SENSITIVE
  // by deliberate decision: profileName is case-preserving with no case rule
  // at the store, so "Work" and "work" are legitimately distinct accounts.
  return credentialsRepo
    .forPlatform(platformParse.data)
    .andThen((existing): ResultAsync<Credential, CredentialError | DbError> => {
      const duplicate = existing.some((c) => c.profileName === credential.profileName)
      if (duplicate) {
        return errAsync({
          kind: "duplicate-account" as const,
          platformId: platformParse.data,
          account: credential.profileName,
        })
      }
      return writeCredential(credential, input.secret, store, credentialsRepo)
    })
}

function writeCredential(
  credential: Credential,
  secret: string,
  store: CredentialStore,
  credentialsRepo: CredentialsRepo,
): ResultAsync<Credential, CredentialError | DbError> {
  return store.set(credential.secretRef, secret).andThen(() =>
    credentialsRepo
      .create(credential)
      .orElse((dbErr): ResultAsync<Credential, CredentialError | DbError> => {
        // Best-effort cleanup: await the delete so cleanup is deterministic.
        // A delete failure is ignored (best-effort) — the original DB error is
        // what we propagate; don't mask it with a cleanup error.
        return store
          .delete(credential.secretRef)
          .orElse((_cleanupErr): ResultAsync<void, never> => okAsync(undefined))
          .andThen(() => {
            // DB-level backstop (increment 32.9): the 30.12 app-level guard
            // above already rejects most duplicate-account attempts before
            // the store is ever touched, but a violation that slips past it
            // (e.g. a concurrent create landing between the guard's read and
            // this write) surfaces here as SQLITE_CONSTRAINT via the
            // credentials_platform_profile_unique index, mapped to
            // "constraint-violation" by mapDbError. Remap it to the same
            // typed duplicate-account CredentialError the app-level guard
            // produces, so callers see one consistent error shape either way.
            // Accepted false-positive: a fresh-ULID primary-key collision
            // would ALSO map to "constraint-violation" and get remapped here
            // — astronomically unlikely (26-char Crockford ULID space) and
            // harmless (the caller retries with a plain "duplicate account"
            // message). FK failures are mapped to "in-use" separately by
            // mapDbError, so they never reach this branch.
            if (dbErr.kind === "constraint-violation") {
              return errAsync({
                kind: "duplicate-account" as const,
                platformId: credential.platformId,
                account: credential.profileName,
              })
            }
            return errAsync(dbErr)
          })
      }),
  )
}
