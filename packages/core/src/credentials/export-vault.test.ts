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
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { exportVault } from "./export-vault.js"
import { resolveMasterKey } from "./master-key.js"
import type { CredentialStore } from "./store.js"
import { VAULT_MAGIC } from "./vault-manifest.js"

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
      profileName: "work",
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
    expect(result.value.skipped[0]?.account).toBe("work")
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
})
