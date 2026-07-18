// SPDX-License-Identifier: AGPL-3.0-only
// bind-credential.ts — the verify-then-commit wrappers around core's
// bindCredentialToPlatform (increment 43, Phase 2 of
// docs/specs/2026-07-17-credential-platform-normalization.md). Mirrors
// connect-from-catalog.ts's verifyThenAdd/confirmThenAdd precedent exactly,
// but binds an EXISTING credential (resolved from the store by its
// secretRef) to a platform instead of minting a fresh one.
//
// verifyThenBind  — resolve the credential's stored secret, verify it against
//   the TARGET platform BEFORE any write, and only on {status:"ok"} call core
//   bindCredentialToPlatform + persist setVerifyState. On auth-failed/
//   unreachable/not-verifiable: ZERO writes (no setPlatformId, no
//   setVerifyState) — same "one clean write or none" discipline as
//   verifyThenAdd; there is no rollback.
// confirmThenBind — the not-verifiable-surface path: skip verify entirely and
//   call core bindCredentialToPlatform directly (honestly unverified),
//   exactly as confirmThenAdd handles verify:none surfaces today. Kept as a
//   SEPARATE, explicitly-named function so a caller can never accidentally
//   skip verification on a surface that actually offers it.
//
// BOUNDARY: source-runtime may import core but core must NEVER import
// source-runtime or verifyCredential — see bind-credential-to-platform.ts's
// header comment. depcruise enforces this.
//
// SECRET DISCIPLINE: the resolved plaintext secret is consumed ONLY by
// verifyCredential (in-memory check) — never logged, never returned, never
// part of any error cause. It never touches core's bindCredentialToPlatform,
// which takes no secret at all (it only repoints a DB row).

import type {
  Credential,
  CredentialError,
  DbError,
  JunctionPaths,
  Repositories,
  ResultAsync,
} from "@junction/core"
import { bindCredentialToPlatform, createCredentialStore, errAsync, okAsync } from "@junction/core"
import { verifyCredential } from "./verify-credential.js"

export type BindError =
  | { kind: "bind-failed"; cause: CredentialError | DbError }
  | { kind: "store-unavailable"; cause: CredentialError }
  | { kind: "secret-unresolvable"; cause: CredentialError }

export type BindResult =
  | { verified: true; checkedAt: number; credential: Credential }
  | {
      verified: false
      outcome: { status: "auth-failed" } | { status: "unreachable"; detail: string }
    }
  | { unverified: true; credential: Credential }

export interface VerifyThenBindArgs {
  credentialId: string
  platformId: string
  paths: JunctionPaths
  repos: Pick<Repositories, "platforms" | "credentials">
}

export type ConfirmThenBindArgs = Omit<VerifyThenBindArgs, "paths">

/**
 * Resolve `credentialId`'s stored plaintext secret via its secretRef. Shared
 * by verifyThenBind (needs the secret to verify) — confirmThenBind never
 * calls this, since it skips verify entirely.
 *
 * The store returns `Ok(null)` for a secretRef that resolves to nothing (a
 * missing/orphaned ref — the store's documented miss contract). For a BIND
 * flow that is NOT a verifiable input: verifying with a `null` secret builds
 * an unauthenticated provider, which for an endpoint reachable WITHOUT auth
 * would return `{status:"ok"}` and commit a FALSE-verified bind (credential-
 * security review, inc 43). So a null resolution is refused here as a typed
 * `secret-unresolvable` error — a credential with no retrievable secret must
 * never verify-ok against anything. (This differs from verifyThenAdd, whose
 * secret is the just-entered plaintext and is never null.)
 */
function resolveSecret(
  credential: Credential,
  paths: JunctionPaths,
): ResultAsync<string, BindError> {
  return createCredentialStore(paths)
    .mapErr((cause): BindError => ({ kind: "store-unavailable", cause }))
    .andThen((store) =>
      store
        .get(credential.secretRef)
        .mapErr((cause): BindError => ({ kind: "secret-unresolvable", cause }))
        .andThen(
          (secret): ResultAsync<string, BindError> =>
            secret === null
              ? errAsync({
                  kind: "secret-unresolvable",
                  // A null resolution is a miss, not a store failure — wrap it
                  // as a typed CredentialError (the cause shape this BindError
                  // kind carries) so no plaintext or raw string leaks the shape.
                  cause: {
                    kind: "invalid-input",
                    reason: `credential ${credential.id}: secretRef resolved to no stored secret`,
                  },
                })
              : okAsync(secret),
        ),
    )
}

/**
 * Verify `credentialId`'s existing secret against `platformId`'s target
 * Platform BEFORE binding. Only {status:"ok"} commits (core bind +
 * setVerifyState); auth-failed/unreachable/not-verifiable write NOTHING.
 */
export function verifyThenBind(
  args: VerifyThenBindArgs,
): ResultAsync<BindResult, BindError | CredentialError | DbError> {
  return args.repos.credentials
    .get(args.credentialId)
    .mapErr((cause): BindError | CredentialError | DbError => cause)
    .andThen((credential) =>
      args.repos.platforms
        .get(args.platformId)
        .mapErr((cause): BindError | CredentialError | DbError => cause)
        .andThen((platform) =>
          resolveSecret(credential, args.paths).andThen(
            (secret): ResultAsync<BindResult, BindError | CredentialError | DbError> =>
              verifyCredential(platform, secret, args.paths).andThen((outcome) => {
                if (outcome.status === "auth-failed") {
                  return okAsync({
                    verified: false as const,
                    outcome: { status: "auth-failed" as const },
                  })
                }
                if (outcome.status === "unreachable") {
                  return okAsync({
                    verified: false as const,
                    outcome: { status: "unreachable" as const, detail: outcome.detail },
                  })
                }
                // "not-verifiable" is treated the same as a non-"ok" outcome
                // here — only a genuine {status:"ok"} commits. A caller with
                // a not-verifiable surface should use confirmThenBind
                // instead (the deliberate, explicitly-chosen skip-verify
                // path), mirroring verifyThenAdd/confirmThenAdd.
                if (outcome.status !== "ok") {
                  return okAsync({
                    verified: false as const,
                    outcome: { status: "unreachable" as const, detail: outcome.reason },
                  })
                }

                return bindCredentialToPlatform(
                  { credentialsRepo: args.repos.credentials, platformsRepo: args.repos.platforms },
                  args.credentialId,
                  args.platformId,
                )
                  .mapErr((cause): BindError => ({ kind: "bind-failed", cause }))
                  .andThen((bound) => {
                    const checkedAt = Date.now()
                    return args.repos.credentials
                      .setVerifyState(args.credentialId, "ok", checkedAt)
                      .mapErr((cause): BindError => ({ kind: "bind-failed", cause }))
                      .map(() => ({ verified: true as const, checkedAt, credential: bound }))
                  })
              }),
          ),
        ),
    )
}

/**
 * Bind `credentialId` to `platformId` WITHOUT verifying — the not-verifiable-
 * surface path (http/cli, verify:none). The caller's explicit choice to call
 * this function IS the confirm gate; core's bindCredentialToPlatform still
 * runs its full structural gate stack (not-found/kind-compat/duplicate-
 * account).
 */
export function confirmThenBind(
  args: ConfirmThenBindArgs,
): ResultAsync<BindResult, CredentialError | DbError> {
  return bindCredentialToPlatform(
    { credentialsRepo: args.repos.credentials, platformsRepo: args.repos.platforms },
    args.credentialId,
    args.platformId,
  ).map((credential) => ({ unverified: true as const, credential }))
}
