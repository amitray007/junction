// SPDX-License-Identifier: AGPL-3.0-only
// bindCredentialToPlatform — associate an existing (typically unlinked)
// credential with a platform (increment 43, Phase 2 of
// docs/specs/2026-07-17-credential-platform-normalization.md). This is
// STRUCTURAL policy only — not-found, kind-compat, duplicate-account — plus
// the write. It does NOT verify the credential's secret against the target
// platform: core is HTTP-free and must never import verifyCredential (that
// lives in @junction/source-runtime, one-way dependency). The verify-then-
// commit wrapper (source-runtime's verifyThenBind/confirmThenBind) calls this
// function only AFTER a successful verify (or for a not-verifiable kind).
//
// Deliberately NOT folded into addCredential: create (mint a new secret) and
// associate (point an existing secret at a platform) are different
// operations with different inputs (no plaintext secret flows through this
// path at all) — keeping the seam clean per docs/principles (architecture
// over expedience).

import { errAsync, type ResultAsync } from "neverthrow"
import type { CredentialError, DbError } from "../errors/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { PlatformsRepo } from "../repositories/platforms.js"
import type { Credential } from "../schema/credential.js"
import { PlatformIdSchema } from "../schema/primitives.js"
import { compatibleCredentialKinds, isKindAccepted } from "./kind-compat.js"

/**
 * Bind an existing credential to a platform.
 *
 * Gate stack, in order, each returning a typed error, then the write:
 *   1. not-found        — the credential id doesn't exist (repo's typed
 *                          not-found, entity "credential").
 *   2. not-found         — the target platform id doesn't exist (repo's typed
 *                          not-found, entity "platform").
 *   3. kind-incompatible — the credential's `kind` isn't accepted by the
 *                          target platform's kind-compat matrix (the SAME
 *                          isKindAccepted gate addCredential uses).
 *   4. duplicate-account — another credential already bound to this platform
 *                          shares the EXACT (case-sensitive, untrimmed)
 *                          profileName (the app-level guard; see
 *                          docs/futures/gotchas.md — migration 0011 dropped
 *                          the DB-level unique, so every platformId/
 *                          profileName-mutating op must carry this manually).
 *   5. write             — credentialsRepo.setPlatformId(id, platformId).
 *
 * No plaintext secret is touched or read here — this only repoints a DB row.
 */
export function bindCredentialToPlatform(
  deps: { credentialsRepo: CredentialsRepo; platformsRepo: PlatformsRepo },
  id: string,
  platformId: string,
): ResultAsync<Credential, CredentialError | DbError> {
  // Validate + brand platformId up front (mirrors addCredential) — a bad id
  // is caught before either repo is touched, and forPlatform below needs the
  // branded PlatformId type.
  const platformIdParse = PlatformIdSchema.safeParse(platformId)
  if (!platformIdParse.success) {
    return errAsync({
      kind: "invalid-input" as const,
      reason: `invalid platformId: ${platformIdParse.error.issues.map((i) => i.message).join(", ")}`,
    })
  }
  const brandedPlatformId = platformIdParse.data

  return deps.credentialsRepo.get(id).andThen((credential) =>
    deps.platformsRepo.get(platformId).andThen((platform) => {
      if (!isKindAccepted(platform, credential.kind)) {
        return errAsync<Credential, CredentialError | DbError>({
          kind: "kind-incompatible" as const,
          requested: credential.kind,
          allowed: Array.from(new Set([...compatibleCredentialKinds(platform), "bearer"])),
        })
      }

      return deps.credentialsRepo
        .forPlatform(brandedPlatformId)
        .andThen((existingForPlatform): ResultAsync<Credential, CredentialError | DbError> => {
          // Same exact-match comparison as addCredential (add-credential.ts)
          // and renameCredential (rename-credential.ts): case-sensitive,
          // untrimmed. No own-row-on-platform to exclude here — the
          // credential being bound is, by definition, not yet on this
          // platform (or is being re-pointed from elsewhere), so unlike
          // renameCredential there is no "rename to own label" no-op case.
          const duplicateAccount = existingForPlatform.some(
            (c) => c.profileName === credential.profileName,
          )
          if (duplicateAccount) {
            return errAsync({
              kind: "duplicate-account" as const,
              platformId,
              account: credential.profileName,
            })
          }

          return deps.credentialsRepo.setPlatformId(id, platformId)
        })
    }),
  )
}
