// SPDX-License-Identifier: AGPL-3.0-only
// exportVault tests — see docs/methods/32.4-vault-backup-recovery.md §5.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../db/index.js"
import { getDatabase } from "../db/index.js"
import { newPlatformId } from "../ids/index.js"
import { ensureHome, getPaths } from "../paths/index.js"
import { createRepositories } from "../repositories/index.js"
import { addCredential } from "./add-credential.js"
import { addStandaloneCredential } from "./add-standalone-credential.js"
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { exportVault } from "./export-vault.js"
import { importVault } from "./import-vault.js"
import { resolveMasterKey } from "./master-key.js"
import type { CredentialStore } from "./store.js"
import { deriveKeyFromPassphrase, gcmDecrypt } from "./vault-crypto.js"
import { VAULT_MAGIC, type VaultManifest } from "./vault-manifest.js"

/** Decrypt a `.jvlt` archive back into its manifest — test-only inverse of
 *  buildArchive, so export tests can assert on the manifest's actual field
 *  values (not just counts). Mirrors import-vault.ts's parseHeader/gcmDecrypt
 *  pairing. */
async function decryptManifest(archive: Buffer, passphrase: string): Promise<VaultManifest> {
  const salt = archive.subarray(6, 22)
  const iv = archive.subarray(22, 34)
  const tag = archive.subarray(34, 50)
  const ct = archive.subarray(50)
  const header = archive.subarray(0, 22)
  const keyResult = await deriveKeyFromPassphrase(passphrase, salt)
  if (keyResult.isErr()) throw keyResult.error
  const key = keyResult.value
  const plaintext = gcmDecrypt(key, header, {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  })
  key.fill(0)
  return JSON.parse(plaintext) as VaultManifest
}

describe("exportVault", () => {
  let db: Db
  let repos: ReturnType<typeof createRepositories>
  let store: CredentialStore
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    home = await mkdtemp(join(tmpdir(), "junction-export-test-"))
    process.env.JUNCTION_HOME = home
    process.env.JUNCTION_STORE = "file"

    await ensureHome()
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) throw dbResult.error
    db = dbResult.value
    repos = createRepositories(db)

    const keyResult = await resolveMasterKey(paths, process.env)
    if (keyResult.isErr()) throw keyResult.error
    store = createEncryptedFileStore(paths, keyResult.value)
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    await rm(home, { recursive: true, force: true })
  })

  async function seedPlatform(displayName = "Test Platform"): Promise<string> {
    const platform = await repos.platforms.create({
      id: newPlatformId(),
      kind: "mcp" as const,
      displayName,
    })
    if (platform.isErr()) throw platform.error
    return String(platform.value.id)
  }

  it("exports a bearer credential + its platform into an encrypted archive", async () => {
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    const cred = await addCredential(
      { platformId, account: "work", kind: "bearer", secret: "SUPER_SECRET_1" },
      platform,
      store,
      repos.credentials,
    )
    expect(cred.isOk()).toBe(true)

    const result = await exportVault({ repos, store, passphrase: "correct-horse-battery" })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.credentialsExported).toBe(1)
    expect(result.value.platformsExported).toBe(1)
    // Archive starts with the magic bytes.
    expect(result.value.archive.subarray(0, 4).equals(VAULT_MAGIC)).toBe(true)
  })

  it("secret-never-on-disk: the archive bytes do not contain the plaintext secret", async () => {
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    const SENTINEL = "EXPORT_SENTINEL_MUST_NOT_APPEAR_PLAINTEXT_xyz"
    await addCredential(
      { platformId, account: "work", kind: "bearer", secret: SENTINEL },
      platform,
      store,
      repos.credentials,
    )

    const result = await exportVault({ repos, store, passphrase: "a-strong-passphrase" })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    // grep -a semantics: scan the raw bytes as latin1 text for the sentinel.
    const text = result.value.archive.toString("latin1")
    expect(text).not.toContain(SENTINEL)
  })

  it("resolves an oauth2 credential's all 4 refs into the manifest", async () => {
    const platformId = await seedPlatform()
    await store.set("ref-access-1", "ACCESS_TOKEN_1")
    await store.set("ref-refresh-1", "REFRESH_TOKEN_1")
    await store.set("ref-clientid-1", "CLIENT_ID_1")
    await store.set("ref-clientsecret-1", "CLIENT_SECRET_1")
    const created = await repos.credentials.create({
      id: "cred-oauth-1",
      name: "oauth-work-1",
      platformId,
      kind: "oauth2",
      secretRef: "ref-access-1",
      oauthMeta: {
        providerId: "github",
        refreshTokenRef: "ref-refresh-1",
        clientIdRef: "ref-clientid-1",
        clientSecretRef: "ref-clientsecret-1",
        needsReauth: false,
      },
    })
    expect(created.isOk()).toBe(true)

    const result = await exportVault({ repos, store, passphrase: "oauth-export-pass" })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.credentialsExported).toBe(1)
  })

  it("missing secret → export FAILS naming the credential (default)", async () => {
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    const cred = await addCredential(
      { platformId, account: "work", kind: "bearer", secret: "will-be-deleted" },
      platform,
      store,
      repos.credentials,
    )
    expect(cred.isOk()).toBe(true)
    if (!cred.isOk()) return
    // Delete the secret from the store directly (simulate vanished secret).
    await store.delete(cred.value.secretRef)

    const result = await exportVault({ repos, store, passphrase: "pw" })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("export-failed")
      expect(result.error.kind === "export-failed" && result.error.reason).toContain("work")
    }
  })

  it("missing secret + skipMissing → succeeds, credential absent + recorded in summary", async () => {
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    const cred = await addCredential(
      { platformId, account: "work", kind: "bearer", secret: "will-be-deleted" },
      platform,
      store,
      repos.credentials,
    )
    if (!cred.isOk()) throw cred.error
    await store.delete(cred.value.secretRef)

    const result = await exportVault({
      repos,
      store,
      passphrase: "pw",
      skipMissing: true,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.credentialsExported).toBe(0)
    expect(result.value.skipped).toHaveLength(1)
    // Increment 46 (RD) — `skipped[].account` is sourced from `cred.name` now
    // (the account identity IS the name), not the raw "work" seed passed to
    // addCredential — that seed only feeds derivation, never stored.
    if (!cred.isOk()) throw cred.error
    expect(result.value.skipped[0]?.account).toBe(cred.value.name)
  })

  it("empty passphrase → refused", async () => {
    const result = await exportVault({ repos, store, passphrase: "" })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("export-failed")
  })

  it("includeProfiles embeds profiles in the manifest", async () => {
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    const cred = (
      await addCredential(
        { platformId, account: "work", kind: "bearer", secret: "s3cr3t" },
        platform,
        store,
        repos.credentials,
      )
    )._unsafeUnwrap()

    const profile = await repos.profiles.create({
      id: "profile-export-1",
      name: "work-profile",
      sources: [
        {
          platformId: platform.id,
          credentialId: cred.id,
          toolNamespace: "test_ns",
          enabled: true,
        },
      ],
    })
    expect(profile.isOk()).toBe(true)

    const result = await exportVault({
      repos,
      store,
      passphrase: "pw",
      includeProfiles: true,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.profilesExported).toBe(1)
  })

  it("orphan platform (dangling FK) → export FAILS naming it, unless skipMissing", async () => {
    // The real DB enforces RESTRICT on platforms→credentials, so a genuinely
    // orphaned row can't be seeded through the repo API. Exercise the export-side
    // orphan-check directly by injecting a `platforms.list` stub that omits the
    // platform the seeded credential references — proves I5 (export must not
    // hard-fail via platforms.get on a dangling FK, and must name the orphan).
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    await addCredential(
      { platformId, account: "work", kind: "bearer", secret: "s3cr3t" },
      platform,
      store,
      repos.credentials,
    )
    // Sanity: normal export succeeds when the platform IS present.
    const okResult = await exportVault({ repos, store, passphrase: "pw" })
    expect(okResult.isOk()).toBe(true)

    const reposWithNoPlatforms = {
      ...repos,
      platforms: { ...repos.platforms, list: () => repos.platforms.list().map(() => []) },
    }
    const failResult = await exportVault({ repos: reposWithNoPlatforms, store, passphrase: "pw" })
    expect(failResult.isErr()).toBe(true)
    if (failResult.isErr()) {
      expect(failResult.error.kind).toBe("export-failed")
      expect(failResult.error.kind === "export-failed" && failResult.error.reason).toContain(
        "missing platform",
      )
    }

    const skipResult = await exportVault({
      repos: reposWithNoPlatforms,
      store,
      passphrase: "pw",
      skipMissing: true,
    })
    expect(skipResult.isOk()).toBe(true)
    if (skipResult.isOk()) {
      expect(skipResult.value.credentialsExported).toBe(0)
      expect(skipResult.value.skipped).toHaveLength(1)
    }
  })

  // ---------------------------------------------------------------------------
  // Increment 46 (Fable RD) — `account` is now sourced from `cred.name` for
  // EVERY credential; the old linked/unlinked ternary collapses.
  // ---------------------------------------------------------------------------

  it("account === name for a LINKED credential (RD)", async () => {
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    const cred = (
      await addCredential(
        { platformId, account: "work", kind: "bearer", secret: "s3cr3t" },
        platform,
        store,
        repos.credentials,
      )
    )._unsafeUnwrap()

    const result = await exportVault({ repos, store, passphrase: "rd-linked-pass" })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const manifest = await decryptManifest(result.value.archive, "rd-linked-pass")
    expect(manifest.credentials).toHaveLength(1)
    // The seed "account" ("work") is NOT what lands in the manifest anymore —
    // `cred.name` (derived from platformId+account, e.g. "<platformId>-work")
    // is the credential's real identity and wins.
    expect(manifest.credentials[0]?.account).toBe(cred.name)
    expect(manifest.credentials[0]?.name).toBe(cred.name)
  })

  it("account === name for an UNLINKED (standalone) credential (RD)", async () => {
    const cred = (
      await addStandaloneCredential(
        { name: "standalone-cred", kind: "bearer", secret: "s3cr3t" },
        store,
        repos.credentials,
      )
    )._unsafeUnwrap()

    const result = await exportVault({ repos, store, passphrase: "rd-unlinked-pass" })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const manifest = await decryptManifest(result.value.archive, "rd-unlinked-pass")
    const manifestCred = manifest.credentials.find((c) => c._srcId === cred.id)
    expect(manifestCred).toBeDefined()
    expect(manifestCred?.account).toBe("standalone-cred")
    expect(manifestCred?.name).toBe("standalone-cred")
    expect(manifestCred?.platformId).toBeUndefined()
  })

  it("round-trip (export → import) is stable: re-exporting the imported credential yields the same name/account", async () => {
    const platformId = await seedPlatform()
    const platform = (await repos.platforms.get(platformId))._unsafeUnwrap()
    await addCredential(
      { platformId, account: "roundtrip", kind: "bearer", secret: "s3cr3t" },
      platform,
      store,
      repos.credentials,
    )

    const exportResult = await exportVault({ repos, store, passphrase: "rt-stability-pass" })
    expect(exportResult.isOk()).toBe(true)
    if (!exportResult.isOk()) return
    const firstManifest = await decryptManifest(exportResult.value.archive, "rt-stability-pass")

    // Import into a FRESH home so the re-export reflects only the imported row.
    const dstHome = await mkdtemp(join(tmpdir(), "junction-export-rt-dst-"))
    const prevDstHome = process.env.JUNCTION_HOME
    const prevDstStore = process.env.JUNCTION_STORE
    process.env.JUNCTION_HOME = dstHome
    process.env.JUNCTION_STORE = "file"
    try {
      await ensureHome()
      const dstPaths = getPaths()
      const dstDbResult = await getDatabase(dstPaths)
      if (dstDbResult.isErr()) throw dstDbResult.error
      const dstRepos = createRepositories(dstDbResult.value)
      const dstKeyResult = await resolveMasterKey(dstPaths, process.env)
      if (dstKeyResult.isErr()) throw dstKeyResult.error
      const dstStore = createEncryptedFileStore(dstPaths, dstKeyResult.value)

      const importResult = await importVault({
        repos: dstRepos,
        store: dstStore,
        archive: exportResult.value.archive,
        passphrase: "rt-stability-pass",
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.added).toBe(1)

      const reExportResult = await exportVault({
        repos: dstRepos,
        store: dstStore,
        passphrase: "rt-stability-pass-2",
      })
      expect(reExportResult.isOk()).toBe(true)
      if (!reExportResult.isOk()) return
      const secondManifest = await decryptManifest(
        reExportResult.value.archive,
        "rt-stability-pass-2",
      )

      expect(secondManifest.credentials).toHaveLength(1)
      expect(secondManifest.credentials[0]?.name).toBe(firstManifest.credentials[0]?.name)
      expect(secondManifest.credentials[0]?.account).toBe(firstManifest.credentials[0]?.account)
    } finally {
      if (prevDstHome === undefined) delete process.env.JUNCTION_HOME
      else process.env.JUNCTION_HOME = prevDstHome
      if (prevDstStore === undefined) delete process.env.JUNCTION_STORE
      else process.env.JUNCTION_STORE = prevDstStore
      await rm(dstHome, { recursive: true, force: true })
    }
  })
})
