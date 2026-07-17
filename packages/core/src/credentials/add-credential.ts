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
import { CredentialNameSchema, CredentialSchema } from "../schema/credential.js"
import type { Platform } from "../schema/platform.js"
import { PlatformIdSchema } from "../schema/primitives.js"
import { deriveCredentialName } from "./derive-name.js"
import { compatibleCredentialKinds, isKindAccepted } from "./kind-compat.js"
import type { CredentialStore } from "./store.js"

/**
 * 32 KiB cap on kind "file" credential content — fits macOS Keychain AND
 * Linux keyutils' ~32 KiB item ceiling (see method file 28.9). Shared with
 * import-vault.ts (which validates the same cap for imported "file" secrets
 * before addCredential is ever reached) so the two enforcement points can
 * never drift out of sync (rule-of-three DRY, method file 33.1 fix 4).
 */
export const FILE_SECRET_MAX_BYTES = 32 * 1024

/**
 * Shared raw-secret validation PRIMITIVE (DRY, docs/principles/dry.md) used by
 * BOTH addCredential and addStandaloneCredential: enforce the 32 KiB file-kind
 * cap and validate an explicit `name` slug — BEFORE any store write. Returns the
 * validated explicit name (or `undefined` when none was supplied, so the caller
 * derives one). The oauth2 exclusion is NOT here — its `allowed` list differs
 * per caller (platform-derived vs fixed) — so each caller keeps its own guard.
 */
export function validateRawSecretAndName(
  kind: Exclude<CredentialKind, "oauth2">,
  secret: string,
  name: string | undefined,
): { ok: true; name: string | undefined } | { ok: false; error: CredentialError } {
  if (kind === "file") {
    const byteLength = Buffer.byteLength(secret, "utf8")
    if (byteLength > FILE_SECRET_MAX_BYTES) {
      return {
        ok: false,
        error: {
          kind: "invalid-input" as const,
          reason: `file credential exceeds 32 KiB (got ${byteLength} bytes)`,
        },
      }
    }
  }
  if (name !== undefined) {
    const nameParse = CredentialNameSchema.safeParse(name)
    if (!nameParse.success) {
      return {
        ok: false,
        error: {
          kind: "invalid-input" as const,
          reason: `invalid name: ${nameParse.error.issues.map((i) => i.message).join(", ")}`,
        },
      }
    }
    return { ok: true, name: nameParse.data }
  }
  return { ok: true, name: undefined }
}

export interface AddCredentialInput {
  /** FK → Platform */
  platformId: string
  /**
   * Logical account label, e.g. "work", "personal", "client-acme".
   * Stored as profileName in the Credential row (increment 42: WRITE-ONLY
   * legacy — see CredentialSchema's profileName doc-comment).
   */
  account: string
  /**
   * The credential's identity slug (increment 42). OPTIONAL — callers that
   * don't take a user-supplied name (legacy CLI `credential add --account`
   * with no `--name`) get one DERIVED deterministically as
   * `<platformId>-<account>`, `-2`/`-3` suffixed on collision (see
   * deriveCredentialName). Callers WITH a user-supplied name (the CLI's new
   * `--name` flag) pass it through, validated against CredentialNameSchema.
   */
  name?: string
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

  // Shared: 32 KiB file cap + explicit-name slug validation, BEFORE any store
  // write. (oauth2 exclusion stays above — its allowed-list is platform-derived.)
  const rawValid = validateRawSecretAndName(input.kind, input.secret, input.name)
  if (!rawValid.ok) return errAsync(rawValid.error)
  const explicitName = rawValid.name

  // One list() read serves BOTH the duplicate-account guard (platform-scoped
  // subset) and name derivation (global uniqueness) — a single DB round-trip
  // rather than two.
  return credentialsRepo
    .list()
    .andThen((all): ResultAsync<Credential, CredentialError | DbError> => {
      const existingForPlatform = all.filter((c) => c.platformId === platformParse.data)

      // Duplicate-account guard (increment 30.12) — BEFORE the secret ever
      // touches the store. Compares the EXACT stored `profileName` against the
      // EXACT `input.account` as this call will store it (post-Zod-parse but
      // otherwise untrimmed) — addCredential does NOT trim `account` today, so
      // the guard must not trim either. Case-SENSITIVE by deliberate decision:
      // profileName is case-preserving with no case rule at the store, so
      // "Work" and "work" are legitimately distinct accounts.
      const duplicateAccount = existingForPlatform.some((c) => c.profileName === input.account)
      if (duplicateAccount) {
        return errAsync({
          kind: "duplicate-account" as const,
          platformId: platformParse.data,
          account: input.account,
        })
      }

      // Increment 42: derive a name when the caller didn't supply one — the
      // SAME rule migration 0011's backfill uses (see deriveCredentialName).
      const existingNames = new Set(all.map((c) => c.name))
      const name =
        explicitName ?? deriveCredentialName(platformParse.data, input.account, existingNames)

      // Validate the full credential shape (defensive; CLI pre-validates, but
      // we must not trust the caller).
      const credentialParse = CredentialSchema.safeParse({
        id: newCredentialId(),
        name,
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

      return writeCredential(
        credentialParse.data,
        input.secret,
        store,
        credentialsRepo,
        // DB-level backstop: the 30.12 app-level duplicate-ACCOUNT guard above
        // already rejects most collisions before the store is touched, but a
        // violation that slips past it (e.g. a concurrent create between the
        // guard's read and the write) surfaces as SQLITE_CONSTRAINT via
        // `credentials_name_unique`. This call always has platformId+account, so
        // "duplicate-account" is the more actionable shape for its callers.
        (cred) => ({
          kind: "duplicate-account" as const,
          platformId: cred.platformId ?? "",
          account: cred.profileName,
        }),
      )
    })
}

/**
 * The shared credential store-write + rollback PRIMITIVE (DRY per
 * docs/principles/dry.md — a mechanical primitive, not a business policy).
 * Used by BOTH addCredential (platform-linked) and addStandaloneCredential
 * (unlinked). Sequence: store.set(secret) FIRST, then one DB insert; on DB
 * failure, await a best-effort store.delete(secretRef) so no orphan secret
 * outlives a failed row, then propagate.
 *
 * The ONLY per-caller difference is how a unique-constraint violation is
 * surfaced (a name collision vs a duplicate-account), so that mapping is
 * injected as `onConstraintViolation`. A fresh-ULID PK collision would also map
 * to "constraint-violation" and get remapped — astronomically unlikely (26-char
 * Crockford ULID) and harmless. FK failures map to "in-use" separately, so they
 * never reach this branch.
 *
 * SECURITY: `secret` is consumed only by store.set(); never returned, logged,
 * or placed in any error cause.
 */
export function writeCredential(
  credential: Credential,
  secret: string,
  store: CredentialStore,
  credentialsRepo: CredentialsRepo,
  onConstraintViolation: (credential: Credential) => CredentialError,
): ResultAsync<Credential, CredentialError | DbError> {
  return store.set(credential.secretRef, secret).andThen(() =>
    credentialsRepo
      .create(credential)
      .orElse((dbErr): ResultAsync<Credential, CredentialError | DbError> => {
        return store
          .delete(credential.secretRef)
          .orElse((_cleanupErr): ResultAsync<void, never> => okAsync(undefined))
          .andThen(() => {
            if (dbErr.kind === "constraint-violation") {
              return errAsync(onConstraintViolation(credential))
            }
            return errAsync(dbErr)
          })
      }),
  )
}
