// SPDX-License-Identifier: AGPL-3.0-only
// exportVault — build a portable, passphrase-wrapped `.jvlt` archive of the operator's
// credentials (secrets resolved) + the platforms they reference. Backend-agnostic: reads
// plaintext via the live CredentialStore.get(secretRef), which works identically on the
// keyring and encrypted-file backends. See docs/methods/32.4-vault-backup-recovery.md §1-2.

import { randomBytes } from "node:crypto"
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import type { Repositories } from "../repositories/index.js"
import type { Credential } from "../schema/credential.js"
import type { Platform } from "../schema/platform.js"
import type { CredentialStore } from "./store.js"
import { deriveKeyFromPassphrase, gcmEncrypt } from "./vault-crypto.js"
import {
  describeDbError,
  VAULT_KDF,
  VAULT_MAGIC,
  VAULT_VERSION,
  type VaultManifest,
} from "./vault-manifest.js"

export interface ExportVaultInput {
  repos: Pick<Repositories, "credentials" | "platforms" | "profiles">
  store: CredentialStore
  passphrase: string
  includeProfiles?: boolean
  skipMissing?: boolean
}

export interface ExportVaultResult {
  archive: Buffer
  credentialsExported: number
  platformsExported: number
  profilesExported?: number
  skipped: Array<{ platformId: string | null; account: string; reason: string }>
}

/**
 * Export every credential + the platforms it references into a passphrase-wrapped
 * `.jvlt` archive Buffer. Missing secrets FAIL the export by default (a credential's
 * secret vanished from the store) — pass `skipMissing` to skip-and-continue instead.
 */
export function exportVault(
  input: ExportVaultInput,
): ResultAsync<ExportVaultResult, CredentialError> {
  const { repos, store, passphrase, includeProfiles = false, skipMissing = false } = input

  if (passphrase.length === 0) {
    return errAsync({ kind: "export-failed", reason: "passphrase must not be empty" })
  }

  return repos.credentials
    .list()
    .mapErr(
      (dbErr): CredentialError => ({
        kind: "export-failed",
        reason: `failed to list credentials: ${describeDbError(dbErr)}`,
      }),
    )
    .andThen((allCredentials) =>
      repos.platforms
        .list()
        .mapErr(
          (dbErr): CredentialError => ({
            kind: "export-failed",
            reason: `failed to list platforms: ${describeDbError(dbErr)}`,
          }),
        )
        .andThen((allPlatforms) =>
          resolveCredentials(allCredentials, allPlatforms, store, skipMissing),
        ),
    )
    .andThen(({ manifestCredentials, referencedPlatforms, skipped }) => {
      if (!includeProfiles) {
        return buildArchive(
          {
            v: 1,
            exportedAt: new Date().toISOString(),
            platforms: referencedPlatforms,
            credentials: manifestCredentials,
          },
          passphrase,
        ).map((archive) => ({
          archive,
          credentialsExported: manifestCredentials.length,
          platformsExported: referencedPlatforms.length,
          skipped,
        }))
      }

      return repos.profiles
        .list()
        .mapErr(
          (dbErr): CredentialError => ({
            kind: "export-failed",
            reason: `failed to list profiles: ${describeDbError(dbErr)}`,
          }),
        )
        .andThen((allProfiles) =>
          buildArchive(
            {
              v: 1,
              exportedAt: new Date().toISOString(),
              platforms: referencedPlatforms,
              credentials: manifestCredentials,
              profiles: allProfiles,
            },
            passphrase,
          ).map((archive) => ({
            archive,
            credentialsExported: manifestCredentials.length,
            platformsExported: referencedPlatforms.length,
            profilesExported: allProfiles.length,
            skipped,
          })),
        )
    })
}

type ManifestCredential = VaultManifest["credentials"][number]

/**
 * Resolve every credential's secret(s) from the store, and collect the platforms
 * they reference (via platforms.list()+filter — NOT platforms.get each, which
 * would hard-Err on a dangling FK rather than letting skipMissing recover).
 */
function resolveCredentials(
  allCredentials: Credential[],
  allPlatforms: Platform[],
  store: CredentialStore,
  skipMissing: boolean,
): ResultAsync<
  {
    manifestCredentials: ManifestCredential[]
    referencedPlatforms: Platform[]
    skipped: Array<{ platformId: string | null; account: string; reason: string }>
  },
  CredentialError
> {
  const platformById = new Map(allPlatforms.map((p) => [p.id, p]))
  const referencedPlatformIds = new Set<string>()
  const manifestCredentials: ManifestCredential[] = []
  const skipped: Array<{ platformId: string | null; account: string; reason: string }> = []

  type StepResult = Result<
    {
      manifestCredentials: ManifestCredential[]
      referencedPlatforms: Platform[]
      skipped: Array<{ platformId: string | null; account: string; reason: string }>
    },
    CredentialError
  >

  const step = async (): Promise<StepResult> => {
    for (const cred of allCredentials) {
      const label = `${cred.platformId ?? "(unlinked)"}/${cred.profileName}`

      // Increment 42 — an UNLINKED credential (platformId: null) has no
      // platform to resolve or collision-check; skip straight to the secret
      // read. Orphan-platform check (I5) only applies when platformId is set.
      if (cred.platformId !== null) {
        const platform = platformById.get(cred.platformId)
        if (platform === undefined) {
          if (skipMissing) {
            skipped.push({
              platformId: cred.platformId,
              account: cred.profileName,
              reason: "references a missing platform",
            })
            continue
          }
          return err({
            kind: "export-failed",
            reason: `credential ${label} references a missing platform`,
          })
        }
      }

      const secretResult = await store.get(cred.secretRef)
      if (secretResult.isErr()) return err(secretResult.error)
      const secret = secretResult.value
      if (secret === null) {
        if (skipMissing) {
          skipped.push({
            platformId: cred.platformId,
            account: cred.profileName,
            reason: "secret missing from store",
          })
          continue
        }
        return err({ kind: "export-failed", reason: `credential ${label} secret missing` })
      }

      let refreshToken: string | undefined
      let clientId: string | undefined
      let clientSecret: string | undefined
      let skipThisCredential = false

      if (cred.kind === "oauth2" && cred.oauthMeta !== undefined) {
        const meta = cred.oauthMeta
        const refs: Array<[string | undefined, "refreshToken" | "clientId" | "clientSecret"]> = [
          [meta.refreshTokenRef, "refreshToken"],
          [meta.clientIdRef, "clientId"],
          [meta.clientSecretRef, "clientSecret"],
        ]
        for (const [ref, field] of refs) {
          if (ref === undefined) continue
          const r = await store.get(ref)
          if (r.isErr()) return err(r.error)
          if (r.value === null) {
            if (skipMissing) {
              skipped.push({
                platformId: cred.platformId,
                account: cred.profileName,
                reason: `oauth2 ${field} secret missing from store`,
              })
              skipThisCredential = true
              break
            }
            return err({
              kind: "export-failed",
              reason: `credential ${label} ${field} secret missing`,
            })
          }
          if (field === "refreshToken") refreshToken = r.value
          else if (field === "clientId") clientId = r.value
          else clientSecret = r.value
        }
      }

      if (skipThisCredential) continue

      if (cred.platformId !== null) referencedPlatformIds.add(cred.platformId)
      manifestCredentials.push({
        name: cred.name,
        ...(cred.platformId !== null ? { platformId: cred.platformId } : {}),
        // account stays required in the manifest (ManifestCredentialSchema) —
        // an unlinked credential has no meaningful account label, so `name`
        // (its actual identity) fills the slot instead of the meaningless
        // write-only profileName.
        account: cred.platformId !== null ? cred.profileName : cred.name,
        kind: cred.kind,
        ...(cred.oauthMeta !== undefined
          ? {
              oauthMeta: {
                scopes: cred.oauthMeta.scopes,
                expiresAt: cred.oauthMeta.expiresAt,
                // Increment 45, Slice E — `providerId` no longer exists on
                // the LIVE credential's OAuthMeta (dropped by migration
                // 0013); nothing to forward here anymore. The archive's
                // ManifestOAuthMetaSchema.providerId field stays (Zod
                // `.optional()`) purely for BACKWARD READ compat — a pre-45
                // archive that still carries it imports fine (import-vault.ts
                // reads it only for the platform backfill, never writes it
                // onto the new credential). A NEWLY exported archive simply
                // omits the field.
                authMode: cred.oauthMeta.authMode,
                needsReauth: cred.oauthMeta.needsReauth,
                obtainedAt: cred.oauthMeta.obtainedAt,
              },
            }
          : {}),
        ...(cred.lastVerifyResult !== undefined ? { lastVerifyResult: cred.lastVerifyResult } : {}),
        ...(cred.lastVerifiedAt !== undefined ? { lastVerifiedAt: cred.lastVerifiedAt } : {}),
        secret,
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        _srcId: cred.id,
      })
    }
    const referencedPlatforms = allPlatforms.filter((p) => referencedPlatformIds.has(p.id))
    return ok({ manifestCredentials, referencedPlatforms, skipped })
  }

  return new ResultAsync(step())
}

/** scrypt-derive a key, AES-256-GCM encrypt the manifest JSON, assemble the .jvlt buffer. */
function buildArchive(
  manifest: VaultManifest,
  passphrase: string,
): ResultAsync<Buffer, CredentialError> {
  const salt = randomBytes(16)
  return deriveKeyFromPassphrase(passphrase, salt).andThen((key) => {
    const version = Buffer.from([VAULT_VERSION])
    const kdf = Buffer.from([VAULT_KDF])
    const header = Buffer.concat([VAULT_MAGIC, version, kdf, salt])

    let plaintext: string | undefined = JSON.stringify(manifest)
    const rec = gcmEncrypt(key, header, plaintext)
    // Best-effort wipe: JS strings can't be zeroed; drop the reference so GC can
    // reclaim it sooner (documented limitation — see vault-crypto.ts / inc-24 note).
    plaintext = undefined

    const iv = Buffer.from(rec.iv, "base64")
    const tag = Buffer.from(rec.tag, "base64")
    const ct = Buffer.from(rec.ct, "base64")
    const archive = Buffer.concat([header, iv, tag, ct])

    // Best-effort wipe of the derived key bytes now that encryption is done.
    key.fill(0)

    return okAsync(archive)
  })
}
