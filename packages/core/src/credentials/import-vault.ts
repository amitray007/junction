// SPDX-License-Identifier: AGPL-3.0-only
// importVault — read a `.jvlt` archive, decrypt it, and reconstruct credentials +
// platforms (+ optionally profiles) in the target vault. Backend-agnostic (writes via
// CredentialStore.set / addCredential, identical on keyring and encrypted-file).
// See docs/methods/32.4-vault-backup-recovery.md §0b/§0c/§3.
//
// --strict (increment 32.10): COMPENSATION-based, not a DB transaction. A one-tx
// design is not implementable without reimplementing addCredential/oauth internals
// (they interleave store+DB per credential; repos swallow errors into errAsync,
// unreadable inside a synchronous better-sqlite3 tx). Strict is therefore:
//   phase 1 — prevalidate the FULL manifest, ZERO writes;
//   phase 2 — run this SAME interleaved import path, but with `store` and the
//             `repos` objects wrapped in journaling decorators that record every
//             successful write;
//   phase 3 — on ANY failure, undo everything journaled, in reverse order.
// Honest scope: "strict" = store-best-effort-compensated + full pre-validation —
// NOT atomic across both stores (the keyring has no rollback primitive; same
// residual as 32.3 rotation). Two documented residuals (see docs/futures/gotchas.md,
// entry drafted in the 32.10 method-file report):
//   1. SIGKILL mid-compensation can strand DB rows and/or keyring refs this import
//      wrote — compensation is a best-effort loop, not itself transactional.
//   2. TOCTOU: no lock is held between phase 1 and phase 2 — a concurrent process
//      inserting a colliding (platformId, account) between the two phases slips
//      past prevalidation. The 32.9 unique index is the backstop (surfaces as a
//      DB constraint-violation mid phase-2, which strict compensates like any
//      other mid-import failure).
// Dropped-route case (a profile route referencing a credential absent from the
// archive, see the idMap lookup below) is preserved identically in strict —
// silently dropped, same as non-strict; strict does not change route semantics.

import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import { newCredentialId, newProfileId } from "../ids/index.js"
import type { CredentialsRepo } from "../repositories/credentials.js"
import type { Repositories } from "../repositories/index.js"
import type { PlatformsRepo } from "../repositories/platforms.js"
import type { ProfilesRepo } from "../repositories/profiles.js"
import { type Credential, CredentialSchema } from "../schema/credential.js"
import type { Platform } from "../schema/platform.js"
import { PlatformIdSchema } from "../schema/primitives.js"
import { ProfileSchema } from "../schema/profile.js"
import { addCredential, FILE_SECRET_MAX_BYTES } from "./add-credential.js"
import { deriveCredentialName } from "./derive-name.js"
import { isKindAccepted } from "./kind-compat.js"
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
  /**
   * All-or-nothing import (increment 32.10). See the module header for the
   * full compensation-based design. `--strict --on-collision overwrite` is
   * REFUSED (mirrors the includeProfiles+overwrite refusal below) — deleted
   * refs are unrestorable on abort, and in-use collisions are only
   * discoverable by ATTEMPTING the RESTRICT delete (a write).
   */
  strict?: boolean
}

export interface ImportSummary {
  platforms: { added: number; skipped: number }
  credentials: {
    added: number
    skipped: number
    overwritten: number
    failed: Array<{ platformId: string | null; account: string; reason: string }>
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
  const {
    repos,
    store,
    archive,
    passphrase,
    onCollision = "skip",
    includeProfiles = false,
    strict = false,
  } = input

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

  // --strict --on-collision overwrite is REFUSED (32.10 §"Overwrite under strict")
  // — mirrors the includeProfiles+overwrite refusal above. Deleted refs are
  // unrestorable on abort; in-use collisions are only discoverable by ATTEMPTING
  // the RESTRICT delete (itself a write), which would violate the phase-1
  // zero-writes promise.
  if (strict && onCollision === "overwrite") {
    return errAsync({
      kind: "import-failed",
      reason:
        "--strict does not support --on-collision overwrite; deleted refs cannot be restored on abort — use skip or error",
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

    if (strict) {
      return new ResultAsync(runStrictImport(repos, store, manifest, onCollision, includeProfiles))
    }

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
    // 32.10 review fix (MEDIUM): only a typed not-found means "safe to create".
    // Any OTHER get error (Zod parse-on-read failure on a schema-drifted row, a
    // query failure, ...) previously fell through to upsert — onConflictDoUpdate
    // would then silently OVERWRITE a pre-existing row (and under --strict the
    // journal would claim it as this-import's write, so compensation would
    // DELETE pre-existing data). A real DB error must abort, not create.
    if (existing.error.kind !== "not-found") {
      return err({
        kind: "import-failed",
        reason: `failed to read platform "${platform.id}": ${describeDbError(existing.error)}`,
      })
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
    const label = `${mc.platformId ?? "(unlinked)"}/${mc.account}`

    // Increment 42 — an unlinked credential (no platformId) has nothing to
    // resolve/upsert here. Importing a standalone secret is out of Phase 1's
    // scope (vault import stays platform-scoped, as it always has been) —
    // fail this ONE entry with an honest reason rather than crash the import.
    if (mc.platformId === undefined) {
      summary.credentials.failed.push({
        platformId: null,
        account: mc.account,
        reason: `credential ${label} is unlinked (no platformId) — unlinked-credential vault import is not yet supported`,
      })
      continue
    }
    const mcPlatformId = mc.platformId

    const platform = platformById.get(mcPlatformId)
    if (platform === undefined) {
      // Should not happen (platforms are upserted from the same manifest above),
      // but guard defensively rather than crash on a malformed archive.
      summary.credentials.failed.push({
        platformId: mcPlatformId,
        account: mc.account,
        reason: `credential ${label} references a platform not present in the archive`,
      })
      continue
    }

    const existingForPlatform = await repos.credentials.forPlatform(platform.id)
    if (existingForPlatform.isErr()) {
      summary.credentials.failed.push({
        platformId: mcPlatformId,
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
            platformId: mcPlatformId,
            account: mc.account,
            reason:
              "credential in use by a profile; cannot overwrite — remove the route first or use --on-collision skip",
          })
          continue
        }
        summary.credentials.failed.push({
          platformId: mcPlatformId,
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

  // ---- 2b. inline 0012-equivalent backfill (increment 44, R2) ----
  // Runs AFTER every credential in this import has landed (added, skipped-
  // remapped-to-existing, or overwritten) so the DB now reflects the FULL
  // picture — same fill-only-if-unset + conflict rule as migration 0012's
  // batch SQL, just re-derived against live repos instead of raw SQL. This
  // is what lets an OLD-format archive (credential carries providerId,
  // platform doesn't) converge the platform's field on import — without it,
  // every old-archive import would permanently pin the resolver's fallback
  // above zero and the future cleanup increment's "zero fallback hits" drop
  // gate could never fire (see docs/futures/revisit-when.md).
  await backfillPlatformOAuthProviderId(manifest.platforms, manifest.credentials, repos)

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
 * The inline import-time equivalent of migration 0012/0013's backfill
 * (increment 44, R2; re-sourced increment 45, Slice E). Same three rules as
 * 0012, restated here because they're safety-critical and this is a SECOND
 * migration surface (data-migration review scrutinizes this the same as
 * 0012's SQL):
 *   - FILL-ONLY-IF-UNSET: a platform that already has `oauthProviderId` set
 *     (from the manifest's own platform row, or a pre-existing DB row) is
 *     left completely alone — this function never overwrites.
 *   - CONFLICT RULE: if the platform's bound oauth2 credentials disagree on
 *     `oauthMeta.providerId`, the field is left UNSET — never guessed.
 *   - NON-DESTRUCTIVE: never touches any credential's `oauthMeta` — only
 *     ever upserts the platform row's `oauthProviderId`.
 *
 * SOURCE CHANGED (increment 45, Slice E): the LIVE credential's
 * `oauthMeta.providerId` no longer exists (dropped from OAuthMetaSchema) —
 * there is nothing to read off `repos.credentials.forPlatform(...)` rows
 * anymore. The archive's OWN `ManifestOAuthMetaSchema.providerId` (a
 * SEPARATE, still-`providerId`-carrying schema kept for exactly this back-
 * compat purpose — see vault-manifest.ts) is the source instead: this
 * function now scans `manifest.credentials` directly (grouped by
 * platformId), never a live DB read of credential rows. This is what lets a
 * pre-45 archive (whose manifest entries still carry `oauthMeta.providerId`)
 * continue converging the imported platform's `oauthProviderId` even though
 * the field is gone from the live schema — the archive is the ONLY place
 * that legacy copy still exists.
 *
 * Best-effort per platform: a failure to read/write one platform's backfill
 * is swallowed (never aborts the import) — this is a convenience backfill on
 * top of an already-successful import, not a correctness-required write; a
 * credential whose platform can't be backfilled simply needs a manual
 * `oauth-design`/platform-edit bind (or a reconnect) to refresh again.
 */
async function backfillPlatformOAuthProviderId(
  manifestPlatforms: readonly Platform[],
  manifestCredentials: readonly ManifestCredential[],
  repos: Pick<Repositories, "platforms">,
): Promise<void> {
  // Group the ARCHIVE's legacy providerId copies by platformId once, up
  // front — O(platforms + credentials) instead of a per-platform re-scan.
  const providerIdsByPlatform = new Map<string, Set<string>>()
  for (const mc of manifestCredentials) {
    if (mc.kind !== "oauth2") continue
    if (mc.platformId === undefined) continue
    const legacyProviderId = mc.oauthMeta?.providerId
    if (legacyProviderId === undefined) continue
    const set = providerIdsByPlatform.get(mc.platformId) ?? new Set<string>()
    set.add(legacyProviderId)
    providerIdsByPlatform.set(mc.platformId, set)
  }

  for (const manifestPlatform of manifestPlatforms) {
    const currentResult = await repos.platforms.get(manifestPlatform.id)
    if (currentResult.isErr()) continue // platform not actually present — nothing to backfill
    const current = currentResult.value

    // Fill-only-if-unset — an already-set field (from the manifest itself,
    // an --on-collision skip keeping a pre-existing set row, or a prior
    // backfill) is never touched.
    if (current.oauthProviderId !== undefined) continue

    const providerIds = providerIdsByPlatform.get(current.id)
    if (providerIds === undefined) continue

    // Conflict rule: exactly one distinct providerId among the archive's
    // bound oauth2 credentials → backfill; zero or MORE THAN ONE
    // (disagreement) → leave unset.
    if (providerIds.size !== 1) continue
    const [onlyProviderId] = providerIds
    if (onlyProviderId === undefined) continue // unreachable (size===1 guards this), narrows the type

    await repos.platforms.upsert({ ...current, oauthProviderId: onlyProviderId })
  }
}

// ===========================================================================
// --strict (increment 32.10)
// ===========================================================================

/**
 * Phase 1 — prevalidate the ENTIRE manifest with ZERO writes. Anything missed
 * here fails later in phase 2 AFTER secrets were written, which would violate
 * the zero-writes-on-abort promise. Runs BEFORE any store/DB write.
 *
 * Checklist (method file §"Phase 1"):
 *  1. Build each candidate credential exactly as the real path does and
 *     `CredentialSchema.safeParse` it (oauth2 candidates built the same shape
 *     `addOAuthImportedCredential` constructs).
 *  2. kind↔platform compatibility (mirrors add-credential.ts) + the 32 KiB
 *     file-cred cap + `PlatformIdSchema` on every platform id.
 *  3. Archive-INTERNAL duplicates — hard error: a Set over (platformId,
 *     account), exact/untrimmed/case-sensitive (matches add-credential.ts's
 *     duplicate-account guard); ditto duplicate platform ids (non-strict
 *     silently last-wins via platformById — strict is the only place that can
 *     catch a within-archive dup, since nothing commits between adds).
 *  4. Archive-vs-DB collisions via a `forPlatform` sweep per CREDENTIAL
 *     (abort if `onCollision === "error"`).
 *  5. Profile shape (`ProfileSchema`) + duplicate-toolNamespace guard +
 *     profile-name collisions (only when includeProfiles).
 */
async function prevalidateStrict(
  repos: Pick<Repositories, "credentials" | "platforms" | "profiles">,
  manifest: VaultManifest,
  onCollision: OnCollision,
  includeProfiles: boolean,
): Promise<Result<void, CredentialError>> {
  // ---- platform ids well-formed + archive-internal duplicate platform ids ----
  const seenPlatformIds = new Set<string>()
  for (const platform of manifest.platforms) {
    const idParse = PlatformIdSchema.safeParse(platform.id)
    if (!idParse.success) {
      return err({
        kind: "import-failed",
        reason: `invalid platform id "${platform.id}": ${idParse.error.issues.map((i) => i.message).join(", ")}`,
      })
    }
    if (seenPlatformIds.has(platform.id)) {
      return err({
        kind: "import-failed",
        reason: `archive contains duplicate platform id "${platform.id}"`,
      })
    }
    seenPlatformIds.add(platform.id)
  }

  const platformById = new Map<string, (typeof manifest.platforms)[number]>(
    manifest.platforms.map((p) => [p.id, p]),
  )

  // ---- archive-vs-DB platform collisions under --on-collision error ----
  if (onCollision === "error") {
    for (const platform of manifest.platforms) {
      const existing = await repos.platforms.get(platform.id)
      if (existing.isOk()) {
        return err({
          kind: "import-failed",
          reason: `platform "${platform.id}" already exists`,
        })
      }
      // Same discrimination as the write loop: only not-found means "no
      // collision". Any other get error → we cannot prevalidate — abort here
      // (zero writes) rather than let phase 2 write-then-compensate.
      if (existing.error.kind !== "not-found") {
        return err({
          kind: "import-failed",
          reason: `failed to read platform "${platform.id}": ${describeDbError(existing.error)}`,
        })
      }
    }
  }

  // ---- credentials: shape, kind-compat, file cap, archive-internal dups, DB collisions ----
  const seenAccounts = new Set<string>()
  for (const mc of manifest.credentials) {
    const label = `${mc.platformId ?? "(unlinked)"}/${mc.account}`

    // Increment 42 — unlinked-credential vault import is not yet supported
    // (see runImport's identical guard); strict must catch it here too
    // (zero writes) rather than let phase 2 discover it after secrets were
    // written.
    if (mc.platformId === undefined) {
      return err({
        kind: "import-failed",
        reason: `credential ${label} is unlinked (no platformId) — unlinked-credential vault import is not yet supported`,
      })
    }
    const mcPlatformId = mc.platformId

    const platform = platformById.get(mcPlatformId)
    if (platform === undefined) {
      // Mirrors the non-strict dropped/missing-platform guard — this credential
      // would fail in phase 2 too, but strict must catch it here (zero writes).
      return err({
        kind: "import-failed",
        reason: `credential ${label} references a platform not present in the archive`,
      })
    }

    // JSON-array key, NOT a delimiter-joined string — platform ids/accounts may
    // themselves contain any delimiter we could pick (("a b","c") vs ("a","b c")
    // would spuriously collide under a space-join).
    const dupKey = JSON.stringify([mcPlatformId, mc.account])
    if (seenAccounts.has(dupKey)) {
      return err({
        kind: "import-failed",
        reason: `archive contains a duplicate credential for ${label}`,
      })
    }
    seenAccounts.add(dupKey)

    const candidateResult = buildCandidateForValidation(mc, platform)
    if (candidateResult.isErr()) {
      return err({
        kind: "import-failed",
        reason: `invalid credential ${label}: ${candidateResult.error}`,
      })
    }

    if (mc.kind !== "oauth2") {
      if (!isKindAccepted(platform, mc.kind)) {
        return err({
          kind: "import-failed",
          reason: `credential ${label}: kind "${mc.kind}" not accepted for this platform`,
        })
      }
      if (mc.kind === "file") {
        const byteLength = Buffer.byteLength(mc.secret, "utf8")
        // FILE_SECRET_MAX_BYTES imported from add-credential.js (33.1 fix 4) —
        // was a locally-duplicated literal ("keep in sync" comment); now one
        // exported const both enforcement points import.
        if (byteLength > FILE_SECRET_MAX_BYTES) {
          return err({
            kind: "import-failed",
            reason: `credential ${label} exceeds 32 KiB (got ${byteLength} bytes)`,
          })
        }
      }
    }

    if (onCollision === "error") {
      const existingForPlatform = await repos.credentials.forPlatform(platform.id)
      if (existingForPlatform.isErr()) {
        return err({
          kind: "import-failed",
          reason: `failed to check for collision on ${label}: ${describeDbError(existingForPlatform.error)}`,
        })
      }
      const collision = existingForPlatform.value.find((c) => c.profileName === mc.account)
      if (collision !== undefined) {
        return err({ kind: "import-failed", reason: `credential ${label} already exists` })
      }
    }
  }

  // ---- profiles: shape + duplicate namespace + name collisions ----
  if (includeProfiles && manifest.profiles !== undefined) {
    const seenProfileNames = new Set<string>()
    for (const profile of manifest.profiles) {
      if (seenProfileNames.has(profile.name)) {
        return err({
          kind: "import-failed",
          reason: `archive contains a duplicate profile name "${profile.name}"`,
        })
      }
      seenProfileNames.add(profile.name)

      const seenNamespaces = new Set<string>()
      for (const sr of profile.sources) {
        if (seenNamespaces.has(sr.toolNamespace)) {
          return err({
            kind: "import-failed",
            reason: `profile "${profile.name}" has duplicate toolNamespace "${sr.toolNamespace}"`,
          })
        }
        seenNamespaces.add(sr.toolNamespace)
      }

      const parsed = ProfileSchema.safeParse({
        id: newProfileId(),
        name: profile.name,
        sources: profile.sources,
      })
      if (!parsed.success) {
        return err({
          kind: "import-failed",
          reason: `invalid profile "${profile.name}": ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        })
      }

      if (onCollision === "error") {
        const existing = await repos.profiles.getByName(profile.name)
        if (existing.isOk()) {
          return err({
            kind: "import-failed",
            reason: `profile "${profile.name}" already exists`,
          })
        }
      }
    }
  }

  return ok(undefined)
}

/**
 * Build (and Zod-validate) the candidate `Credential` shape phase 1 would
 * write in phase 2, WITHOUT ever touching the store or DB — mirrors
 * addImportedCredential/addOAuthImportedCredential's shape exactly (using
 * throwaway ids; phase 2 mints the real ones). Returns the description string
 * of any validation failure (never the secret).
 */
function buildCandidateForValidation(
  mc: ManifestCredential,
  platform: Platform,
): Result<void, string> {
  // Increment 42 — mirrors the real write path's back-compat derivation
  // (addImportedCredential/addOAuthImportedCredential below): an archive from
  // before increment 42 has no `name`; a throwaway derived name is enough to
  // validate SHAPE here (empty existing-names set — TRUE global uniqueness is
  // re-checked at the real DB write in phase 2, which strict's journal/
  // compensation machinery already covers via the constraint-violation path).
  const candidateName = mc.name ?? deriveCredentialName(platform.id, mc.account, new Set())

  if (mc.kind !== "oauth2") {
    const parsed = CredentialSchema.safeParse({
      id: newCredentialId(),
      name: candidateName,
      platformId: platform.id,
      profileName: mc.account,
      kind: mc.kind,
      secretRef: newCredentialId(),
    })
    if (!parsed.success) {
      return err(parsed.error.issues.map((i) => i.message).join(", "))
    }
    return ok(undefined)
  }

  const parsed = CredentialSchema.safeParse({
    id: newCredentialId(),
    name: candidateName,
    platformId: platform.id,
    profileName: mc.account,
    kind: "oauth2",
    secretRef: newCredentialId(),
    oauthMeta: {
      refreshTokenRef: mc.refreshToken !== undefined ? newCredentialId() : undefined,
      clientIdRef: mc.clientId !== undefined ? newCredentialId() : undefined,
      clientSecretRef: mc.clientSecret !== undefined ? newCredentialId() : undefined,
      // Increment 45, Slice E — `providerId` no longer exists on
      // OAuthMetaSchema (dropped from the credential; the archive's OWN
      // ManifestOAuthMetaSchema.providerId is unaffected — see vault-
      // manifest.ts). `mc.oauthMeta?.providerId` is read ONLY for the
      // platform backfill (backfillPlatformOAuthProviderId, below), never
      // written onto the imported credential itself.
      authMode: mc.oauthMeta?.authMode,
      scopes: mc.oauthMeta?.scopes,
      expiresAt: mc.oauthMeta?.expiresAt,
      needsReauth: mc.oauthMeta?.needsReauth ?? false,
      obtainedAt: mc.oauthMeta?.obtainedAt ?? new Date().toISOString(),
    },
    ...(mc.lastVerifyResult !== undefined ? { lastVerifyResult: mc.lastVerifyResult } : {}),
    ...(mc.lastVerifiedAt !== undefined ? { lastVerifiedAt: mc.lastVerifiedAt } : {}),
  })
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => i.message).join(", "))
  }
  return ok(undefined)
}

/**
 * A single journaled event, in the order it happened — compensation walks
 * this list in REVERSE. `kind` selects which repo/store call undoes it.
 */
type JournalEntry =
  | { kind: "store-ref"; ref: string }
  | { kind: "platform"; id: string }
  | { kind: "credential"; id: string }
  | { kind: "profile"; id: string }

/** Append-only journal shared by the store/repo decorators for one strict import. */
class ImportJournal {
  private readonly entries: JournalEntry[] = []

  record(entry: JournalEntry): void {
    this.entries.push(entry)
  }

  /** Reverse-order compensation (method file §"Phase 3"). Best-effort: a single
   *  cleanup step failing never stops the sweep — every OTHER journaled write
   *  still gets its cleanup attempt. */
  async compensate(
    repos: Pick<Repositories, "credentials" | "platforms" | "profiles">,
    store: CredentialStore,
  ): Promise<void> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (entry === undefined) continue
      switch (entry.kind) {
        case "profile":
          await repos.profiles
            .delete(entry.id)
            .orElse((): ResultAsync<void, never> => okAsync(undefined))
          break
        case "credential":
          await repos.credentials
            .delete(entry.id)
            .orElse((): ResultAsync<void, never> => okAsync(undefined))
          break
        case "platform":
          await repos.platforms
            .delete(entry.id)
            .orElse((): ResultAsync<void, never> => okAsync(undefined))
          break
        case "store-ref":
          await store.delete(entry.ref).orElse((): ResultAsync<void, never> => okAsync(undefined))
          break
        default: {
          const _exhaustive: never = entry
          void _exhaustive
        }
      }
    }
  }
}

/**
 * Wrap `store` so every successful `set` is journaled. Pass-through otherwise
 * (identical behavior on get/delete/backend) — mirrors the flakyStore test
 * decorator pattern (import-vault.test.ts's flakyStore).
 */
function journalStore(store: CredentialStore, journal: ImportJournal): CredentialStore {
  return {
    backend: store.backend,
    get: (ref) => store.get(ref),
    delete: (ref) => store.delete(ref),
    set: (ref, value) =>
      store.set(ref, value).map((v) => {
        journal.record({ kind: "store-ref", ref })
        return v
      }),
  }
}

/**
 * Wrap the platforms repo so every successful upsert is journaled.
 *
 * INVARIANT (what makes journaling an upsert safe): under --strict, `upsert`
 * is only reachable on the platform loop's not-found branch — overwrite is
 * refused at entry, skip/error `continue`/abort before any upsert on an
 * existing row, and (32.10 review fix) a non-not-found `get` error aborts the
 * import instead of falling through. Every journaled "platform" entry is
 * therefore a row THIS import created, never a pre-existing row mutated by
 * onConflictDoUpdate — so compensation's delete can never destroy user data.
 */
function journalPlatformsRepo(repo: PlatformsRepo, journal: ImportJournal): PlatformsRepo {
  return {
    ...repo,
    upsert: (input) =>
      repo.upsert(input).map((v) => {
        journal.record({ kind: "platform", id: v.id })
        return v
      }),
  }
}

/** Wrap the credentials repo so every successful create is journaled. */
function journalCredentialsRepo(repo: CredentialsRepo, journal: ImportJournal): CredentialsRepo {
  return {
    ...repo,
    create: (input) =>
      repo.create(input).map((v) => {
        journal.record({ kind: "credential", id: v.id })
        return v
      }),
  }
}

/** Wrap the profiles repo so every successful create is journaled. */
function journalProfilesRepo(repo: ProfilesRepo, journal: ImportJournal): ProfilesRepo {
  return {
    ...repo,
    create: (input) =>
      repo.create(input).map((v) => {
        journal.record({ kind: "profile", id: v.id })
        return v
      }),
  }
}

/**
 * --strict orchestrator: phase 1 (prevalidate, zero writes) → phase 2 (the
 * EXISTING interleaved runImport, under journaling decorators) → phase 3 (on
 * ANY failure, reverse-order compensation). See the module header for why
 * this is compensation-based rather than a single DB transaction.
 */
async function runStrictImport(
  repos: Pick<Repositories, "credentials" | "platforms" | "profiles">,
  store: CredentialStore,
  manifest: VaultManifest,
  onCollision: OnCollision,
  includeProfiles: boolean,
): Promise<Result<ImportSummary, CredentialError>> {
  const prevalidation = await prevalidateStrict(repos, manifest, onCollision, includeProfiles)
  if (prevalidation.isErr()) {
    return err(prevalidation.error)
  }

  const journal = new ImportJournal()
  const journaledStore = journalStore(store, journal)
  const journaledRepos = {
    credentials: journalCredentialsRepo(repos.credentials, journal),
    platforms: journalPlatformsRepo(repos.platforms, journal),
    profiles: journalProfilesRepo(repos.profiles, journal),
  }

  const result = await runImport(
    journaledRepos,
    journaledStore,
    manifest,
    onCollision,
    includeProfiles,
  )

  if (result.isErr()) {
    await journal.compensate(repos, store)
    return err({
      kind: "import-failed",
      reason: `${describeCredentialError(result.error)} (all rows/refs written by this import were removed again — best-effort compensation)`,
    })
  }

  // Per-credential/per-profile failures inside `summary.*.failed` are NOT a
  // hard Err from runImport (see the non-strict `failed` contract) — but
  // strict promises all-or-nothing, so ANY recorded failure still triggers
  // full compensation of what DID succeed.
  const summary = result.value
  const hasPartialFailure =
    summary.credentials.failed.length > 0 || (summary.profiles?.failed.length ?? 0) > 0
  if (hasPartialFailure) {
    await journal.compensate(repos, store)
    const failedCount = summary.credentials.failed.length + (summary.profiles?.failed.length ?? 0)
    // Surface the FIRST failure's identity+reason — the abort discards the
    // summary, so without this the caller gets a count with no diagnostics.
    const firstCredFailure = summary.credentials.failed[0]
    const firstProfileFailure = summary.profiles?.failed[0]
    const firstDetail =
      firstCredFailure !== undefined
        ? `first: ${firstCredFailure.platformId}/${firstCredFailure.account}: ${firstCredFailure.reason}`
        : firstProfileFailure !== undefined
          ? `first: profile "${firstProfileFailure.name}": ${firstProfileFailure.reason}`
          : "first failure unavailable"
    return err({
      kind: "import-failed",
      reason: `strict import aborted: ${failedCount} item(s) failed mid-import (${firstDetail}) (all rows/refs written by this import were removed again — best-effort compensation)`,
    })
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
      {
        platformId: platform.id,
        account: mc.account,
        kind: mc.kind,
        secret: mc.secret,
        // Increment 42 — use the manifest's name when present; addCredential
        // derives one itself (deriveCredentialName) when absent, matching
        // back-compat for a pre-42 archive with no `name` field.
        ...(mc.name !== undefined ? { name: mc.name } : {}),
      },
      platform,
      store,
      repos.credentials,
    )
    if (added.isErr()) {
      const e = added.error
      return err({
        reason: `import failed for ${platform.id}/${mc.account}: ${describeAddError(e)}`,
      })
    }
    // Best-effort carry over the verify state — a formatting-only field, never
    // load-bearing to the import's correctness (swallow a failure here).
    if (mc.lastVerifyResult !== undefined && mc.lastVerifiedAt !== undefined) {
      await repos.credentials.setVerifyState(added.value.id, mc.lastVerifyResult, mc.lastVerifiedAt)
    }
    return ok(added.value)
  }
  return addOAuthImportedCredential(mc, platform.id, store, repos)
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
      platformId: platform.id,
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
  platformId: string,
  store: CredentialStore,
  repos: Pick<Repositories, "credentials">,
): Promise<Result<Credential, { reason: string }>> {
  const id = newCredentialId()
  const secretRef = newCredentialId()
  const refreshTokenRef = mc.refreshToken !== undefined ? newCredentialId() : undefined
  const clientIdRef = mc.clientId !== undefined ? newCredentialId() : undefined
  const clientSecretRef = mc.clientSecret !== undefined ? newCredentialId() : undefined

  // Increment 42 — use the manifest's name when present; DERIVE one (against
  // the CURRENT DB's existing names) when absent, matching back-compat for a
  // pre-42 archive with no `name` field. A live list() read here (rather than
  // the empty-set placeholder buildCandidateForValidation used for shape-only
  // prevalidation) so a non-strict import's real write gets a truly-unique
  // derived name, not just a schema-shaped one.
  let name = mc.name
  if (name === undefined) {
    const existingResult = await repos.credentials.list()
    const existingNames = existingResult.isOk()
      ? new Set(existingResult.value.map((c) => c.name))
      : new Set<string>()
    name = deriveCredentialName(platformId, mc.account, existingNames)
  }

  const credentialParse = CredentialSchema.safeParse({
    id,
    name,
    platformId,
    profileName: mc.account,
    kind: "oauth2",
    secretRef,
    oauthMeta: {
      refreshTokenRef,
      clientIdRef,
      clientSecretRef,
      // Increment 45, Slice E — `providerId` no longer exists on
      // OAuthMetaSchema; see the identical note in buildCandidateForValidation
      // above. The archive's copy still feeds backfillPlatformOAuthProviderId.
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
      reason: `invalid oauth2 credential shape for ${platformId}/${mc.account}: ${credentialParse.error.issues.map((i) => i.message).join(", ")}`,
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
        reason: `failed to write secret for ${platformId}/${mc.account}: ${describeCredentialError(setResult.error)}`,
      })
    }
    written.push(ref)
  }

  const createResult = await repos.credentials.create(credential)
  if (createResult.isErr()) {
    await cleanupRefs(store, written)
    return err({
      reason: `failed to persist oauth2 credential for ${platformId}/${mc.account}: ${describeDbError(createResult.error)}`,
    })
  }

  // Best-effort carry over the verify state — mirrors the non-oauth
  // addImportedCredential path above (33.1 fix 1: this call was previously
  // missing here, so every imported oauth2 credential showed never-verified
  // regardless of what the source vault recorded, forcing a spurious
  // reconnect/re-verify prompt). A formatting-only field, never load-bearing
  // to the import's correctness, so a failure here is swallowed (matches the
  // non-oauth path's contract exactly).
  //
  // STRICT-MODE COMPENSATION: setVerifyState is a plain UPDATE on the row
  // `credentials.create()` just journaled above (repos here may be the
  // strict-mode journalCredentialsRepo decorator, which journals `create`
  // only) — it never mints a new id/row. If a LATER item in this import
  // fails and strict's compensate() deletes this credential by the
  // journaled id, the delete removes the ENTIRE row (verify-state fields
  // included), so the verify-state write is rolled back transitively
  // without needing its own journal entry. Verified by
  // import-vault.test.ts's strict-mode oauth2 verify-state compensation test.
  if (mc.lastVerifyResult !== undefined && mc.lastVerifiedAt !== undefined) {
    await repos.credentials.setVerifyState(
      createResult.value.id,
      mc.lastVerifyResult,
      mc.lastVerifiedAt,
    )
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
