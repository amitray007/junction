// SPDX-License-Identifier: AGPL-3.0-only
// importVault — read a `.jvlt` archive, decrypt it, and reconstruct credentials +
// platforms (+ optionally profiles) in the target vault. Backend-agnostic (writes via
// CredentialStore.set / addCredential, identical on keyring and encrypted-file).
// See docs/methods/32.4-vault-backup-recovery.md §0b/§0c/§3.

import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import { newCredentialId, newProfileId } from "../ids/index.js"
import type { Repositories } from "../repositories/index.js"
import { type Credential, CredentialSchema } from "../schema/credential.js"
import { ProfileSchema } from "../schema/profile.js"
import { addCredential } from "./add-credential.js"
import { removeCredential } from "./remove-credential.js"
import type { CredentialStore } from "./store.js"
import { deriveKeyFromPassphrase, gcmDecrypt } from "./vault-crypto.js"
import {
  describeDbError,
  VAULT_KDF,
  VAULT_MAGIC,
  VAULT_VERSION,
  type VaultManifest,
  VaultManifestSchema,
} from "./vault-manifest.js"

/** Render any CredentialError kind to a short string — "cause"/"reason" vary by variant. */
function describeCredentialError(e: CredentialError): string {
  switch (e.kind) {
    case "invalid-input":
      return e.reason
    case "kind-incompatible":
      return `kind "${e.requested}" not accepted; allowed: ${e.allowed.join(", ")}`
    case "duplicate-account":
      return `duplicate account for ${e.platformId}/${e.account}`
    case "rotate-refused":
      return e.reason
    case "export-failed":
    case "import-failed":
      return e.reason
    default:
      return String(e.cause)
  }
}

export type OnCollision = "skip" | "overwrite" | "error"

export interface ImportVaultInput {
  repos: Pick<Repositories, "credentials" | "platforms" | "profiles">
  store: CredentialStore
  archive: Buffer
  passphrase: string
  onCollision?: OnCollision
  includeProfiles?: boolean
}

export interface ImportSummary {
  platforms: { added: number; skipped: number }
  credentials: {
    added: number
    skipped: number
    overwritten: number
    failed: Array<{ platformId: string; account: string; reason: string }>
  }
  profiles?: {
    added: number
    skipped: number
    failed: Array<{ name: string; reason: string }>
  }
}

type ManifestCredential = VaultManifest["credentials"][number]

/**
 * Import a `.jvlt` archive: decrypt (wrong passphrase / tamper → generic import-failed,
 * NOTHING written), Zod-validate the manifest, upsert platforms FIRST (the FK), then
 * credentials (non-oauth2 via addCredential; oauth2 via a dedicated mint-and-validate
 * path — addCredential refuses oauth2), then (optionally) profiles LAST with routes
 * remapped through the _srcId → resolvedTargetId map.
 */
export function importVault(input: ImportVaultInput): ResultAsync<ImportSummary, CredentialError> {
  const { repos, store, archive, passphrase, onCollision = "skip", includeProfiles = false } = input

  if (passphrase.length === 0) {
    return errAsync({ kind: "import-failed", reason: "passphrase must not be empty" })
  }

  // C1 fold-in: reject overwrite + profiles up front — a profile has cascade-on-delete
  // source_refs; overwriting risks dropping live routes. Simpler + safe (method file §0c).
  if (includeProfiles && onCollision === "overwrite") {
    return errAsync({
      kind: "import-failed",
      reason:
        "profile overwrite is not supported; remove the profile first or use --on-collision skip",
    })
  }

  const parsed = parseHeader(archive)
  if (parsed === null) {
    return errAsync({ kind: "import-failed", reason: "not a junction vault archive" })
  }

  return deriveKeyFromPassphrase(passphrase, parsed.salt).andThen((key) => {
    let plaintext: string
    try {
      plaintext = gcmDecrypt(key, parsed.header, {
        iv: parsed.iv.toString("base64"),
        tag: parsed.tag.toString("base64"),
        ct: parsed.ct.toString("base64"),
      })
    } catch {
      key.fill(0)
      return errAsync<ImportSummary, CredentialError>({
        kind: "import-failed",
        reason: "could not decrypt archive (wrong passphrase or corrupted file)",
      })
    }
    key.fill(0)

    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(plaintext)
    } catch {
      return errAsync<ImportSummary, CredentialError>({
        kind: "import-failed",
        reason: "invalid archive contents",
      })
    }
    // best-effort drop the plaintext reference — JS strings can't be zeroed.
    plaintext = ""

    const manifestParse = VaultManifestSchema.safeParse(manifestJson)
    if (!manifestParse.success) {
      return errAsync<ImportSummary, CredentialError>({
        kind: "import-failed",
        reason: "invalid archive contents",
      })
    }
    const manifest = manifestParse.data

    return new ResultAsync(runImport(repos, store, manifest, onCollision, includeProfiles))
  })
}

/** `[magic(4)][version(1)][kdf(1)][salt(16)][iv(12)][tag(16)][ct...]`. */
function parseHeader(archive: Buffer): {
  header: Buffer
  salt: Buffer
  iv: Buffer
  tag: Buffer
  ct: Buffer
} | null {
  const MIN_LEN = 4 + 1 + 1 + 16 + 12 + 16
  if (archive.length < MIN_LEN) return null
  if (!archive.subarray(0, 4).equals(VAULT_MAGIC)) return null
  const version = archive.readUInt8(4)
  const kdf = archive.readUInt8(5)
  if (version !== VAULT_VERSION || kdf !== VAULT_KDF) return null
  const salt = archive.subarray(6, 22)
  const iv = archive.subarray(22, 34)
  const tag = archive.subarray(34, 50)
  const ct = archive.subarray(50)
  const header = archive.subarray(0, 22) // magic+version+kdf+salt — matches export's AAD
  return { header, salt, iv, tag, ct }
}

async function runImport(
  repos: Pick<Repositories, "credentials" | "platforms" | "profiles">,
  store: CredentialStore,
  manifest: VaultManifest,
  onCollision: OnCollision,
  includeProfiles: boolean,
): Promise<Result<ImportSummary, CredentialError>> {
  const summary: ImportSummary = {
    platforms: { added: 0, skipped: 0 },
    credentials: { added: 0, skipped: 0, overwritten: 0, failed: [] },
  }

  // ---- 1. platforms FIRST (the FK) ----
  for (const platform of manifest.platforms) {
    const existing = await repos.platforms.get(platform.id)
    if (existing.isOk()) {
      if (onCollision === "error") {
        return err({ kind: "import-failed", reason: `platform "${platform.id}" already exists` })
      }
      if (onCollision === "skip") {
        summary.platforms.skipped++
        continue
      }
      // overwrite
      const upserted = await repos.platforms.upsert(platform)
      if (upserted.isErr()) {
        return err({
          kind: "import-failed",
          reason: `failed to upsert platform "${platform.id}": ${describeDbError(upserted.error)}`,
        })
      }
      summary.platforms.added++
      continue
    }
    const created = await repos.platforms.upsert(platform)
    if (created.isErr()) {
      return err({
        kind: "import-failed",
        reason: `failed to create platform "${platform.id}": ${describeDbError(created.error)}`,
      })
    }
    summary.platforms.added++
  }

  // Platforms are now all present in the target (added or pre-existing) — build a
  // lookup so the credential loop can pass addCredential the REAL Platform row
  // (kind-compat needs the honest shape, not a stub). Keyed by plain string — the
  // manifest credential's platformId field is unbranded (ManifestCredentialSchema).
  const platformById = new Map<string, (typeof manifest.platforms)[number]>(
    manifest.platforms.map((p) => [p.id, p]),
  )

  // ---- 2. credentials ----
  // _srcId → resolvedTargetId. Populated for added/collision-resolved credentials;
  // absent (no entry) for missing/failed — the profile route drops uniformly (C2).
  const idMap = new Map<string, string>()

  for (const mc of manifest.credentials) {
    const label = `${mc.platformId}/${mc.account}`
    const platform = platformById.get(mc.platformId)
    if (platform === undefined) {
      // Should not happen (platforms are upserted from the same manifest above),
      // but guard defensively rather than crash on a malformed archive.
      summary.credentials.failed.push({
        platformId: mc.platformId,
        account: mc.account,
        reason: `credential ${label} references a platform not present in the archive`,
      })
      continue
    }

    const existingForPlatform = await repos.credentials.forPlatform(platform.id)
    if (existingForPlatform.isErr()) {
      summary.credentials.failed.push({
        platformId: mc.platformId,
        account: mc.account,
        reason: `failed to check for collision: ${describeDbError(existingForPlatform.error)}`,
      })
      continue
    }
    const collision = existingForPlatform.value.find((c) => c.profileName === mc.account)

    if (collision !== undefined) {
      if (onCollision === "error") {
        return err({ kind: "import-failed", reason: `credential ${label} already exists` })
      }
      if (onCollision === "skip") {
        summary.credentials.skipped++
        idMap.set(mc._srcId, collision.id) // C2 — remap to the EXISTING target id, not a drop.
        continue
      }
      // overwrite: de-orphan oauth2 refs (H2) THEN removeCredential, then add fresh.
      if (collision.kind === "oauth2" && collision.oauthMeta !== undefined) {
        await removeOAuthCredentialRefs(store, collision.oauthMeta)
      }
      const removed = await removeCredential(collision.id, store, repos.credentials)
      if (removed.isErr()) {
        if (removed.error.kind === "in-use") {
          summary.credentials.failed.push({
            platformId: mc.platformId,
            account: mc.account,
            reason:
              "credential in use by a profile; cannot overwrite — remove the route first or use --on-collision skip",
          })
          continue
        }
        summary.credentials.failed.push({
          platformId: mc.platformId,
          account: mc.account,
          reason: `failed to remove existing credential: ${describeDbError(removed.error)}`,
        })
        continue
      }
      const newId = await addAndRecord(mc, platform, store, repos, summary, idMap)
      if (newId !== null) summary.credentials.overwritten++
      continue
    }

    // no collision → add
    const newId = await addAndRecord(mc, platform, store, repos, summary, idMap)
    if (newId !== null) summary.credentials.added++
  }

  // ---- 3. profiles LAST (idMap is complete) ----
  if (includeProfiles && manifest.profiles !== undefined) {
    const profileSummary = {
      added: 0,
      skipped: 0,
      failed: [] as Array<{ name: string; reason: string }>,
    }
    for (const profile of manifest.profiles) {
      const existing = await repos.profiles.getByName(profile.name)
      if (existing.isOk()) {
        if (onCollision === "error") {
          return err({
            kind: "import-failed",
            reason: `profile "${profile.name}" already exists`,
          })
        }
        // skip (overwrite already rejected up-front for includeProfiles)
        profileSummary.skipped++
        continue
      }

      const remappedSources = profile.sources
        .map((sr) => {
          if (sr.credentialId === undefined) return sr // public/no-auth source — unchanged
          const remapped = idMap.get(sr.credentialId)
          if (remapped === undefined) return null // dropped — missing/failed credential
          return { ...sr, credentialId: remapped }
        })
        .filter((sr): sr is NonNullable<typeof sr> => sr !== null)

      // Mint a fresh profile id — imported profiles never reuse the source-machine id.
      // Raw object (not `satisfies Profile`) — `remappedSources`' credentialId is a
      // plain string post-idMap-lookup (Map<string,string> erases the CredentialId
      // brand); ProfileSchema.safeParse re-brands + validates it below.
      const parsedProfile = ProfileSchema.safeParse({
        id: newProfileId(),
        name: profile.name,
        sources: remappedSources,
      })
      if (!parsedProfile.success) {
        profileSummary.failed.push({
          name: profile.name,
          reason: parsedProfile.error.issues.map((i) => i.message).join(", "),
        })
        continue
      }
      const created = await repos.profiles.create(parsedProfile.data)
      if (created.isErr()) {
        profileSummary.failed.push({
          name: profile.name,
          reason: describeDbError(created.error),
        })
        continue
      }
      profileSummary.added++
    }
    summary.profiles = profileSummary
  }

  return ok(summary)
}

/**
 * Add one manifest credential to the target vault: non-oauth2 via addCredential
 * (fresh id + fresh secretRef minted inside it); oauth2 via the dedicated path
 * (§0b) — addCredential REFUSES oauth2 (add-credential.ts ~line 84).
 */
async function addImportedCredential(
  mc: ManifestCredential,
  platform: import("../schema/platform.js").Platform,
  store: CredentialStore,
  repos: Pick<Repositories, "credentials">,
): Promise<Result<Credential, { reason: string }>> {
  if (mc.kind !== "oauth2") {
    const added = await addCredential(
      { platformId: mc.platformId, account: mc.account, kind: mc.kind, secret: mc.secret },
      platform,
      store,
      repos.credentials,
    )
    if (added.isErr()) {
      const e = added.error
      return err({
        reason: `import failed for ${mc.platformId}/${mc.account}: ${describeAddError(e)}`,
      })
    }
    // Best-effort carry over the verify state — a formatting-only field, never
    // load-bearing to the import's correctness (swallow a failure here).
    if (mc.lastVerifyResult !== undefined && mc.lastVerifiedAt !== undefined) {
      await repos.credentials.setVerifyState(added.value.id, mc.lastVerifyResult, mc.lastVerifiedAt)
    }
    return ok(added.value)
  }
  return addOAuthImportedCredential(mc, store, repos)
}

/**
 * Add an imported credential and record the outcome into `summary`/`idMap`. On success
 * returns the new credential id (caller bumps the appropriate counter: added vs
 * overwritten); on failure pushes to `summary.credentials.failed` and returns null.
 * Shared by the overwrite and no-collision paths so the add+record logic never drifts.
 */
async function addAndRecord(
  mc: ManifestCredential,
  platform: import("../schema/platform.js").Platform,
  store: CredentialStore,
  repos: Pick<Repositories, "credentials">,
  summary: ImportSummary,
  idMap: Map<string, string>,
): Promise<string | null> {
  const added = await addImportedCredential(mc, platform, store, repos)
  if (added.isErr()) {
    summary.credentials.failed.push({
      platformId: mc.platformId,
      account: mc.account,
      reason: added.error.reason,
    })
    return null
  }
  idMap.set(mc._srcId, added.value.id)
  return added.value.id
}

function describeAddError(e: { kind: string } & Record<string, unknown>): string {
  switch (e.kind) {
    case "duplicate-account":
      return "duplicate account (unexpected — collision was already checked)"
    case "kind-incompatible":
      return `kind "${String(e.requested)}" not accepted for this platform`
    case "invalid-input":
      return String(e.reason)
    default:
      return JSON.stringify(e)
  }
}

/**
 * The dedicated oauth2 import path (method file §0b) — modelled EXACTLY on
 * source-runtime's `persistOAuthTokens` fresh-insert pattern, reimplemented here
 * because core cannot depend on source-runtime (one-way dependency direction):
 *   1. mint fresh id + up to 4 refs, all via newCredentialId()
 *   2. VALIDATE FIRST via CredentialSchema.safeParse — BEFORE any store.set (H1)
 *   3. store.set each present ref
 *   4. credentials.create(credential)
 *   5. on any failure, best-effort delete ALL refs already written (up to 4, not
 *      just secretRef) — mirrors persistOAuthTokens's hoisted `written` guard.
 */
async function addOAuthImportedCredential(
  mc: ManifestCredential,
  store: CredentialStore,
  repos: Pick<Repositories, "credentials">,
): Promise<Result<Credential, { reason: string }>> {
  const id = newCredentialId()
  const secretRef = newCredentialId()
  const refreshTokenRef = mc.refreshToken !== undefined ? newCredentialId() : undefined
  const clientIdRef = mc.clientId !== undefined ? newCredentialId() : undefined
  const clientSecretRef = mc.clientSecret !== undefined ? newCredentialId() : undefined

  const credentialParse = CredentialSchema.safeParse({
    id,
    platformId: mc.platformId,
    profileName: mc.account,
    kind: "oauth2",
    secretRef,
    oauthMeta: {
      refreshTokenRef,
      clientIdRef,
      clientSecretRef,
      providerId: mc.oauthMeta?.providerId,
      authMode: mc.oauthMeta?.authMode,
      scopes: mc.oauthMeta?.scopes,
      expiresAt: mc.oauthMeta?.expiresAt,
      needsReauth: mc.oauthMeta?.needsReauth ?? false,
      obtainedAt: mc.oauthMeta?.obtainedAt ?? new Date().toISOString(),
    },
    ...(mc.lastVerifyResult !== undefined ? { lastVerifyResult: mc.lastVerifyResult } : {}),
    ...(mc.lastVerifiedAt !== undefined ? { lastVerifiedAt: mc.lastVerifiedAt } : {}),
  })

  // H1: validate BEFORE any store.set — a malformed shape must fail here, before
  // secrets touch the store (else store.set writes plaintext that only fails at
  // DB insert → stranded store entries).
  if (!credentialParse.success) {
    return err({
      reason: `invalid oauth2 credential shape for ${mc.platformId}/${mc.account}: ${credentialParse.error.issues.map((i) => i.message).join(", ")}`,
    })
  }
  const credential = credentialParse.data

  const written: string[] = []
  const pairs: Array<[string, string]> = [[secretRef, mc.secret]]
  if (refreshTokenRef !== undefined && mc.refreshToken !== undefined) {
    pairs.push([refreshTokenRef, mc.refreshToken])
  }
  if (clientIdRef !== undefined && mc.clientId !== undefined) {
    pairs.push([clientIdRef, mc.clientId])
  }
  if (clientSecretRef !== undefined && mc.clientSecret !== undefined) {
    pairs.push([clientSecretRef, mc.clientSecret])
  }

  for (const [ref, value] of pairs) {
    const setResult = await store.set(ref, value)
    if (setResult.isErr()) {
      await cleanupRefs(store, written)
      return err({
        reason: `failed to write secret for ${mc.platformId}/${mc.account}: ${describeCredentialError(setResult.error)}`,
      })
    }
    written.push(ref)
  }

  const createResult = await repos.credentials.create(credential)
  if (createResult.isErr()) {
    await cleanupRefs(store, written)
    return err({
      reason: `failed to persist oauth2 credential for ${mc.platformId}/${mc.account}: ${describeDbError(createResult.error)}`,
    })
  }

  return ok(createResult.value)
}

/** Best-effort delete of a list of store refs — never throws. Mirrors oauth-connect.ts's cleanup. */
async function cleanupRefs(store: CredentialStore, refs: readonly string[]): Promise<void> {
  for (const ref of refs) {
    await store.delete(ref).orElse((): ResultAsync<void, never> => okAsync(undefined))
  }
}

/**
 * Overwrite-collision helper (H2 fold-in): `removeCredential` deletes ONLY
 * `credential.secretRef`, never the oauthMeta refs — overwriting an existing oauth2
 * credential would strand up to 3 refs. Resolve + delete all present oauthMeta refs
 * before/alongside `removeCredential` so overwrite doesn't accumulate orphans.
 */
async function removeOAuthCredentialRefs(
  store: CredentialStore,
  oauthMeta: NonNullable<Credential["oauthMeta"]>,
): Promise<void> {
  const refs = [oauthMeta.refreshTokenRef, oauthMeta.clientIdRef, oauthMeta.clientSecretRef].filter(
    (r): r is string => typeof r === "string",
  )
  await cleanupRefs(store, refs)
}
