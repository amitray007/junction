// SPDX-License-Identifier: AGPL-3.0-only
// importVault tests + a full round-trip (export→import) integration — see
// docs/methods/32.4-vault-backup-recovery.md §5.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errAsync } from "neverthrow"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getDatabase } from "../db/index.js"
import { newPlatformId } from "../ids/index.js"
import { mergeDesigns } from "../oauth/catalog.js"
import { refreshIfExpired } from "../oauth/refresh.js"
import { resolveOAuthProviderId } from "../oauth/resolve-provider-id.js"
import { ensureHome, getPaths } from "../paths/index.js"
import type { Repositories } from "../repositories/index.js"
import { createRepositories } from "../repositories/index.js"
import { addCredential, FILE_SECRET_MAX_BYTES } from "./add-credential.js"
import { addStandaloneCredential } from "./add-standalone-credential.js"
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { exportVault } from "./export-vault.js"
import { importVault } from "./import-vault.js"
import { resolveMasterKey } from "./master-key.js"
import type { CredentialStore } from "./store.js"
import { deriveKeyFromPassphrase, gcmEncrypt } from "./vault-crypto.js"
import { VAULT_KDF, VAULT_MAGIC, VAULT_VERSION, type VaultManifest } from "./vault-manifest.js"

/**
 * Hand-build a `.jvlt` archive from a raw manifest object — bypasses exportVault
 * (which can never produce an archive-internal duplicate) so strict's phase-1
 * archive-internal-duplicate checks can be exercised directly.
 */
async function buildRawArchive(manifest: VaultManifest, passphrase: string): Promise<Buffer> {
  const salt = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)))
  const keyResult = await deriveKeyFromPassphrase(passphrase, salt)
  if (keyResult.isErr()) throw keyResult.error
  const key = keyResult.value
  const version = Buffer.from([VAULT_VERSION])
  const kdf = Buffer.from([VAULT_KDF])
  const header = Buffer.concat([VAULT_MAGIC, version, kdf, salt])
  const rec = gcmEncrypt(key, header, JSON.stringify(manifest))
  key.fill(0)
  const iv = Buffer.from(rec.iv, "base64")
  const tag = Buffer.from(rec.tag, "base64")
  const ct = Buffer.from(rec.ct, "base64")
  return Buffer.concat([header, iv, tag, ct])
}

async function makeHome(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix))
  const prevHome = process.env.JUNCTION_HOME
  const prevStore = process.env.JUNCTION_STORE
  process.env.JUNCTION_HOME = home
  process.env.JUNCTION_STORE = "file"
  await ensureHome()
  const paths = getPaths()
  const dbResult = await getDatabase(paths)
  if (dbResult.isErr()) throw dbResult.error
  const db = dbResult.value
  const repos = createRepositories(db)
  const keyResult = await resolveMasterKey(paths, process.env)
  if (keyResult.isErr()) throw keyResult.error
  const store = createEncryptedFileStore(paths, keyResult.value)
  return {
    home,
    db,
    repos,
    store,
    restore: async () => {
      if (prevHome === undefined) delete process.env.JUNCTION_HOME
      else process.env.JUNCTION_HOME = prevHome
      if (prevStore === undefined) delete process.env.JUNCTION_STORE
      else process.env.JUNCTION_STORE = prevStore
      await rm(home, { recursive: true, force: true })
    },
  }
}

type Fixture = Awaited<ReturnType<typeof makeHome>>

// increment 45 (D2) — resolveOAuthProviderId/refreshIfExpired now take the
// merged design lookup as data. Every test below exercises only built-in ids
// (github/google), so an empty custom list is enough.
const BUILT_INS_ONLY = mergeDesigns([])

describe("importVault", () => {
  let src: Fixture

  beforeEach(async () => {
    src = await makeHome("junction-import-src-")
  })

  afterEach(async () => {
    await src.restore()
  })

  async function seedPlatform(repos: Fixture["repos"], displayName = "Test Platform") {
    const platform = await repos.platforms.create({
      id: newPlatformId(),
      kind: "mcp" as const,
      displayName,
    })
    if (platform.isErr()) throw platform.error
    return platform.value
  }

  /** An openapi-kind platform with apiKey auth — kind-compat accepts "api-key". */
  async function seedApiKeyPlatform(repos: Fixture["repos"], displayName = "ApiKey Platform") {
    const platform = await repos.platforms.create({
      id: newPlatformId(),
      kind: "openapi" as const,
      displayName,
      openapi: {
        spec: { from: "inline" as const, document: {} },
        auth: { scheme: "apiKey" as const, in: "header" as const, name: "X-Api-Key" },
      },
    })
    if (platform.isErr()) throw platform.error
    return platform.value
  }

  it("not a junction vault archive → import-failed, clean header check", async () => {
    const result = await importVault({
      repos: src.repos,
      store: src.store,
      archive: Buffer.from("not a vault archive at all"),
      passphrase: "pw",
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("import-failed")
      expect(result.error.kind === "import-failed" && result.error.reason).toContain(
        "not a junction vault archive",
      )
    }
  })

  it("empty passphrase → refused before touching the archive", async () => {
    const result = await importVault({
      repos: src.repos,
      store: src.store,
      archive: Buffer.from("JVLT"),
      passphrase: "",
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("import-failed")
  })

  it("--include-profiles + --on-collision overwrite → rejected up front (C1)", async () => {
    const result = await importVault({
      repos: src.repos,
      store: src.store,
      archive: Buffer.from("JVLT"),
      passphrase: "pw",
      includeProfiles: true,
      onCollision: "overwrite",
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.kind).toBe("import-failed")
      expect(result.error.kind === "import-failed" && result.error.reason).toContain("overwrite")
    }
  })

  // -------------------------------------------------------------------------
  // Round-trip (export from src → import into a fresh dst) — the core proof.
  // -------------------------------------------------------------------------

  describe("round-trip", () => {
    let dst: Fixture

    beforeEach(async () => {
      dst = await makeHome("junction-import-dst-")
    })

    afterEach(async () => {
      await dst.restore()
    })

    it("round-trips api-key + bearer + env + file + oauth2 (all 4 refs) credentials + platforms", async () => {
      const platformA = await seedPlatform(src.repos, "Platform A")
      const platformB = await seedApiKeyPlatform(src.repos, "Platform B")

      const bearer = (
        await addCredential(
          { platformId: String(platformA.id), account: "work", kind: "bearer", secret: "BEARER_1" },
          platformA,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()

      const apiKey = (
        await addCredential(
          {
            platformId: String(platformB.id),
            account: "personal",
            kind: "api-key",
            secret: "APIKEY_1",
          },
          platformB,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()

      // oauth2 — seeded directly (addCredential refuses oauth2).
      await src.store.set("ref-access-rt", "ACCESS_TOKEN_RT")
      await src.store.set("ref-refresh-rt", "REFRESH_TOKEN_RT")
      await src.store.set("ref-clientid-rt", "CLIENT_ID_RT")
      await src.store.set("ref-clientsecret-rt", "CLIENT_SECRET_RT")
      const oauthCred = (
        await src.repos.credentials.create({
          id: "cred-oauth-rt",
          name: "oauth-account-cred-oauth-rt",
          platformId: String(platformA.id),
          kind: "oauth2",
          secretRef: "ref-access-rt",
          oauthMeta: {
            authMode: "authorization_code",
            refreshTokenRef: "ref-refresh-rt",
            clientIdRef: "ref-clientid-rt",
            clientSecretRef: "ref-clientsecret-rt",
            needsReauth: false,
            scopes: ["repo", "read:user"],
          },
        })
      )._unsafeUnwrap()

      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "round-trip-pass",
      })
      expect(exportResult.isOk()).toBe(true)
      if (!exportResult.isOk()) return

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "round-trip-pass",
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.added).toBe(3)
      expect(importResult.value.platforms.added).toBe(2)

      // Every secret resolves identically on the target.
      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(3)

      // Increment 46 (RD) — export/import carries `name` through unchanged
      // (the account identity IS the name); match on the SOURCE credential's
      // `name` rather than the old write-only `profileName` account label.
      const dstBearer = dstCreds.find((c) => c.name === bearer.name)
      expect(dstBearer).toBeDefined()
      if (dstBearer) {
        expect((await dst.store.get(dstBearer.secretRef))._unsafeUnwrap()).toBe("BEARER_1")
        // Fresh secretRef minted, not reused from source.
        expect(dstBearer.secretRef).not.toBe(bearer.secretRef)
      }

      const dstApiKey = dstCreds.find((c) => c.name === apiKey.name)
      expect(dstApiKey).toBeDefined()
      if (dstApiKey) {
        expect((await dst.store.get(dstApiKey.secretRef))._unsafeUnwrap()).toBe("APIKEY_1")
        expect(dstApiKey.secretRef).not.toBe(apiKey.secretRef)
      }

      const dstOauth = dstCreds.find((c) => c.kind === "oauth2")
      expect(dstOauth).toBeDefined()
      if (dstOauth) {
        expect(dstOauth.id).not.toBe(oauthCred.id) // fresh id
        expect(dstOauth.secretRef).not.toBe(oauthCred.secretRef) // fresh ref
        expect((await dst.store.get(dstOauth.secretRef))._unsafeUnwrap()).toBe("ACCESS_TOKEN_RT")
        expect(dstOauth.oauthMeta?.refreshTokenRef).not.toBe(oauthCred.oauthMeta?.refreshTokenRef)
        expect(dstOauth.oauthMeta?.clientIdRef).not.toBe(oauthCred.oauthMeta?.clientIdRef)
        expect(dstOauth.oauthMeta?.clientSecretRef).not.toBe(oauthCred.oauthMeta?.clientSecretRef)
        if (dstOauth.oauthMeta?.refreshTokenRef !== undefined) {
          expect((await dst.store.get(dstOauth.oauthMeta.refreshTokenRef))._unsafeUnwrap()).toBe(
            "REFRESH_TOKEN_RT",
          )
        }
        if (dstOauth.oauthMeta?.clientIdRef !== undefined) {
          expect((await dst.store.get(dstOauth.oauthMeta.clientIdRef))._unsafeUnwrap()).toBe(
            "CLIENT_ID_RT",
          )
        }
        if (dstOauth.oauthMeta?.clientSecretRef !== undefined) {
          expect((await dst.store.get(dstOauth.oauthMeta.clientSecretRef))._unsafeUnwrap()).toBe(
            "CLIENT_SECRET_RT",
          )
        }
        expect(dstOauth.oauthMeta?.scopes).toEqual(["repo", "read:user"])
      }

      const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
      expect(dstPlatforms).toHaveLength(2)
    })

    it("import path enforces the same FILE_SECRET_MAX_BYTES cap as addCredential (33.1 fix 4 — shared const, not a duplicated literal)", async () => {
      // A "cli" platform is the only kind whose kind-compat matrix accepts
      // "file" (kind-compat.ts). Hand-build a raw manifest (bypasses
      // exportVault, which can never produce oversized content by
      // construction) carrying a "file" secret one byte over the shared
      // FILE_SECRET_MAX_BYTES cap.
      const platform = await src.repos.platforms.create({
        id: newPlatformId(),
        kind: "cli" as const,
        displayName: "CLI File-Secret Platform",
        cli: {
          tools: [
            {
              name: "greet",
              argv: [{ kind: "literal", value: "/bin/echo" }],
              args: [],
              policy: {
                cwd: "/tmp",
                readPaths: ["/tmp"],
                writePaths: [],
                allowNet: [],
                timeoutMs: 5000,
                envAllow: {},
              },
            },
          ],
          credentialEnvVar: "CLI_FILE_SECRET_CRED",
        },
      })
      if (platform.isErr()) throw platform.error

      const oversized = "x".repeat(FILE_SECRET_MAX_BYTES + 1)
      const manifest: VaultManifest = {
        v: 1,
        exportedAt: new Date().toISOString(),
        platforms: [platform.value],
        credentials: [
          {
            platformId: String(platform.value.id),
            account: "oversized-file",
            kind: "file",
            secret: oversized,
            _srcId: "src-oversized-file-1",
          },
        ],
      }
      const archive = await buildRawArchive(manifest, "file-secret-cap-pass")

      const result = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive,
        passphrase: "file-secret-cap-pass",
      })
      // Non-strict: the oversized credential fails, but the import itself
      // still completes (per-credential failures land in summary.failed).
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.credentials.added).toBe(0)
        expect(result.value.credentials.failed).toHaveLength(1)
        expect(result.value.credentials.failed[0]?.reason).toContain("32 KiB")
      }
      // Zero writes for the rejected credential — never reaches the store.
      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(0)
    })

    it("oauth2 import carries verify state (33.1 fix 1 — addOAuthImportedCredential was missing the setVerifyState call the non-oauth path already had)", async () => {
      const platform = await seedPlatform(src.repos, "OAuth Verify-State Platform")

      await src.store.set("ref-access-vs", "ACCESS_TOKEN_VS")
      await src.store.set("ref-refresh-vs", "REFRESH_TOKEN_VS")
      const oauthCred = (
        await src.repos.credentials.create({
          id: "cred-oauth-vs",
          name: "verify-state-account-cred-oauth-vs",
          platformId: String(platform.id),
          kind: "oauth2",
          secretRef: "ref-access-vs",
          oauthMeta: {
            authMode: "authorization_code",
            refreshTokenRef: "ref-refresh-vs",
            needsReauth: false,
          },
        })
      )._unsafeUnwrap()
      // Seed the same verify result the non-oauth bearer parity test seeds
      // (strict's "happy path" test above) — proves oauth2 gets the SAME
      // carry-over treatment, not a special-cased omission.
      await src.repos.credentials.setVerifyState(oauthCred.id, "ok", 1_700_000_000_000)

      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "oauth-verify-state-pass",
      })
      expect(exportResult.isOk()).toBe(true)
      if (!exportResult.isOk()) return

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "oauth-verify-state-pass",
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.added).toBe(1)
      expect(importResult.value.credentials.failed).toHaveLength(0)

      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(1)
      const imported = dstCreds[0]
      expect(imported?.kind).toBe("oauth2")
      // The load-bearing assertion: WITHOUT fix 1, addOAuthImportedCredential
      // never called setVerifyState, so these would both be undefined
      // (never-verified) regardless of what the source vault recorded.
      expect(imported?.lastVerifyResult).toBe("ok")
      expect(imported?.lastVerifiedAt).toBe(1_700_000_000_000)
    })

    it("wrong passphrase → import-failed, ZERO writes", async () => {
      const platform = await seedPlatform(src.repos)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S3CRET" },
        platform,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "correct-passphrase",
      })
      if (!exportResult.isOk()) throw exportResult.error

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "WRONG-passphrase",
      })
      expect(importResult.isErr()).toBe(true)
      if (importResult.isErr()) {
        expect(importResult.error.kind).toBe("import-failed")
      }

      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(0)
      expect(dstPlatforms).toHaveLength(0)
    })

    it.each([
      ["header", 0],
      ["tag", 40],
      ["ciphertext", 60],
    ])("tamper: flipping a byte of %s → import-failed, ZERO writes", async (_label, byteIndex) => {
      const platform = await seedPlatform(src.repos)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S3CRET" },
        platform,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "tamper-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      const tampered = Buffer.from(exportResult.value.archive)
      const idx = Math.min(byteIndex, tampered.length - 1)
      tampered[idx] = (tampered[idx] ?? 0) ^ 0xff

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: tampered,
        passphrase: "tamper-pass",
      })
      expect(importResult.isErr()).toBe(true)
      if (importResult.isErr()) {
        expect(importResult.error.kind).toBe("import-failed")
      }
      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(0)
    })

    it("cross-backend: exports from file backend import cleanly (backend-agnostic contract)", async () => {
      // Full keyring↔file cross-backend coverage lives in credentials.test.ts's
      // gated KeyringStore suite; this asserts the CredentialStore interface
      // contract that makes cross-backend round-trips possible — the archive
      // carries resolved plaintext, never a backend-specific handle.
      const platform = await seedPlatform(src.repos)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "XBACKEND" },
        platform,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "xbackend-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error
      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "xbackend-pass",
      })
      expect(importResult.isOk()).toBe(true)
    })

    it("collision policies: skip leaves existing untouched + imports only new", async () => {
      const platform = await seedPlatform(src.repos)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "SRC_SECRET" },
        platform,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "collision-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      // Seed the SAME platform+account in dst first (with a DIFFERENT secret).
      const dstPlatform = await seedPlatform(dst.repos, "Platform A")
      // Force the SAME platform id so the archive's platform collides (upsert skip).
      const dstPlatformIdMatched = await dst.repos.platforms.upsert({
        ...dstPlatform,
        id: platform.id,
      })
      expect(dstPlatformIdMatched.isOk()).toBe(true)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "DST_SECRET" },
        platform,
        dst.store,
        dst.repos.credentials,
      )

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "collision-pass",
        onCollision: "skip",
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.skipped).toBe(1)
      expect(importResult.value.credentials.added).toBe(0)

      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(1)
      const secret = (await dst.store.get(dstCreds[0]?.secretRef ?? ""))._unsafeUnwrap()
      expect(secret).toBe("DST_SECRET") // untouched — skip did not overwrite
    })

    it("collision policies: error aborts on first collision", async () => {
      const platform = await seedPlatform(src.repos)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "SRC_SECRET" },
        platform,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "collision-error-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      await dst.repos.platforms.upsert(platform)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "DST_SECRET" },
        platform,
        dst.store,
        dst.repos.credentials,
      )

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "collision-error-pass",
        onCollision: "error",
      })
      expect(importResult.isErr()).toBe(true)
      if (importResult.isErr()) expect(importResult.error.kind).toBe("import-failed")
    })

    it("collision policies: overwrite replaces the existing credential", async () => {
      const platform = await seedPlatform(src.repos)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "NEW_SECRET" },
        platform,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "overwrite-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      await dst.repos.platforms.upsert(platform)
      const oldCred = (
        await addCredential(
          {
            platformId: String(platform.id),
            account: "work",
            kind: "bearer",
            secret: "OLD_SECRET",
          },
          platform,
          dst.store,
          dst.repos.credentials,
        )
      )._unsafeUnwrap()

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "overwrite-pass",
        onCollision: "overwrite",
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.overwritten).toBe(1)

      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(1)
      expect(dstCreds[0]?.id).not.toBe(oldCred.id)
      const secret = (await dst.store.get(dstCreds[0]?.secretRef ?? ""))._unsafeUnwrap()
      expect(secret).toBe("NEW_SECRET")

      // Old secret must no longer resolve.
      const oldSecret = (await dst.store.get(oldCred.secretRef))._unsafeUnwrap()
      expect(oldSecret).toBeNull()
    })

    it("overwrite on an oauth2 collision de-orphans all 4 old refs (H2)", async () => {
      const platform = await seedPlatform(src.repos)
      await src.store.set("ref-access-h2new", "NEW_ACCESS")
      await src.repos.credentials.create({
        id: "cred-oauth-h2new",
        name: "oauth-work-h2",
        platformId: String(platform.id),
        kind: "oauth2",
        secretRef: "ref-access-h2new",
        oauthMeta: { needsReauth: false },
      })
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "h2-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      await dst.repos.platforms.upsert(platform)
      await dst.store.set("ref-access-h2old", "OLD_ACCESS")
      await dst.store.set("ref-refresh-h2old", "OLD_REFRESH")
      await dst.store.set("ref-clientid-h2old", "OLD_CLIENTID")
      await dst.store.set("ref-clientsecret-h2old", "OLD_CLIENTSECRET")
      // Increment 46 (RD) — the collision is now a GLOBAL NAME match: the dst
      // row must carry the SAME `name` the archive's manifest credential will
      // export as `account`/`name` for the collision to fire (the old
      // per-platform `profileName` match no longer exists).
      await dst.repos.credentials.create({
        id: "cred-oauth-h2old",
        name: "oauth-work-h2",
        platformId: String(platform.id),
        kind: "oauth2",
        secretRef: "ref-access-h2old",
        oauthMeta: {
          refreshTokenRef: "ref-refresh-h2old",
          clientIdRef: "ref-clientid-h2old",
          clientSecretRef: "ref-clientsecret-h2old",
          needsReauth: false,
        },
      })

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "h2-pass",
        onCollision: "overwrite",
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.overwritten).toBe(1)

      // All 4 OLD refs must be gone (de-orphaned) — not just secretRef.
      expect((await dst.store.get("ref-access-h2old"))._unsafeUnwrap()).toBeNull()
      expect((await dst.store.get("ref-refresh-h2old"))._unsafeUnwrap()).toBeNull()
      expect((await dst.store.get("ref-clientid-h2old"))._unsafeUnwrap()).toBeNull()
      expect((await dst.store.get("ref-clientsecret-h2old"))._unsafeUnwrap()).toBeNull()
    })

    it("in-use collision + overwrite → clean in-use surface, no force-delete", async () => {
      const platform = await seedPlatform(src.repos)
      await addCredential(
        { platformId: String(platform.id), account: "work", kind: "bearer", secret: "NEW_SECRET" },
        platform,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "inuse-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      await dst.repos.platforms.upsert(platform)
      const inUseCred = (
        await addCredential(
          {
            platformId: String(platform.id),
            account: "work",
            kind: "bearer",
            secret: "OLD_SECRET",
          },
          platform,
          dst.store,
          dst.repos.credentials,
        )
      )._unsafeUnwrap()
      // Reference it from a profile so removeCredential RESTRICTs.
      await dst.repos.profiles.create({
        id: "profile-inuse-1",
        name: "inuse-profile",
        sources: [
          {
            platformId: platform.id,
            credentialId: inUseCred.id,
            toolNamespace: "inuse_ns",
            enabled: true,
          },
        ],
      })

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "inuse-pass",
        onCollision: "overwrite",
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.failed).toHaveLength(1)
      expect(importResult.value.credentials.failed[0]?.reason).toContain("in use")

      // The credential must still exist, untouched (no force-delete).
      const stillThere = await dst.repos.credentials.get(inUseCred.id)
      expect(stillThere.isOk()).toBe(true)
    })

    it("partial-import resume: a mid-import failure (store.set throws) leaves earlier imports intact; re-run with skip completes, no dupes", async () => {
      const platformA = await seedPlatform(src.repos, "Platform Resume A")
      const platformB = await seedPlatform(src.repos, "Platform Resume B")
      await addCredential(
        { platformId: String(platformA.id), account: "one", kind: "bearer", secret: "SECRET_ONE" },
        platformA,
        src.store,
        src.repos.credentials,
      )
      await addCredential(
        { platformId: String(platformB.id), account: "two", kind: "bearer", secret: "SECRET_TWO" },
        platformB,
        src.store,
        src.repos.credentials,
      )
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "resume-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      // Inject a store whose 2nd `.set` call fails (the method file's example:
      // "store.set throws on the 3rd credential" — here the 2nd, since there
      // are only 2 seeded credentials). The 1st credential's store.set (secretRef
      // mint) succeeds and commits; the 2nd fails and is recorded in `failed`.
      let setCallCount = 0
      const flakyStore: CredentialStore = {
        ...dst.store,
        set: (ref: string, value: string) => {
          setCallCount++
          if (setCallCount === 2) {
            return errAsync({ kind: "io-failed" as const, cause: new Error("injected failure") })
          }
          return dst.store.set(ref, value)
        },
      }

      await dst.repos.platforms.upsert(platformA)
      await dst.repos.platforms.upsert(platformB)

      const firstAttempt = await importVault({
        repos: dst.repos,
        store: flakyStore,
        archive: exportResult.value.archive,
        passphrase: "resume-pass",
      })
      // Per-credential fail-safe (§3 step 6): the whole import still returns Ok
      // with the failing credential recorded in `failed`, NOT a hard Err — only
      // decrypt/parse failures hard-Err the whole call.
      expect(firstAttempt.isOk()).toBe(true)
      if (!firstAttempt.isOk()) return
      expect(firstAttempt.value.credentials.added).toBe(1)
      expect(firstAttempt.value.credentials.failed).toHaveLength(1)

      const afterFirst = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(afterFirst).toHaveLength(1) // only the successful one committed

      // Re-run with the REAL store and default (skip) collision policy →
      // completes without duplicating the already-imported one.
      const secondAttempt = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "resume-pass",
        onCollision: "skip",
      })
      expect(secondAttempt.isOk()).toBe(true)
      if (!secondAttempt.isOk()) return
      expect(secondAttempt.value.credentials.added).toBe(1) // the one that failed before
      expect(secondAttempt.value.credentials.skipped).toBe(1) // the one already there

      const afterSecond = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(afterSecond).toHaveLength(2) // both present, no dupes
      // Increment 46 (RA) — the account seed ("one"/"two") lands entirely in
      // the derived `name` (`<platformId>-<account>`, slugified/lowercased);
      // there is no separate stored account label to assert on anymore.
      const names = afterSecond.map((c) => c.name).sort()
      expect(names).toEqual(
        [
          `${String(platformA.id).toLowerCase()}-one`,
          `${String(platformB.id).toLowerCase()}-two`,
        ].sort(),
      )
    })

    it("profiles: added credential's route remaps to the new id; public route unchanged", async () => {
      const platform = await seedPlatform(src.repos)
      const cred = (
        await addCredential(
          { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
          platform,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()
      await src.repos.profiles.create({
        id: "profile-remap-1",
        name: "remap-profile",
        sources: [
          {
            platformId: platform.id,
            credentialId: cred.id,
            toolNamespace: "remap_ns",
            enabled: true,
          },
          {
            // Public/no-auth source — credentialId undefined, unchanged on import.
            platformId: platform.id,
            toolNamespace: "public_ns",
            enabled: true,
          },
        ],
      })

      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "profiles-pass",
        includeProfiles: true,
      })
      if (!exportResult.isOk()) throw exportResult.error

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "profiles-pass",
        includeProfiles: true,
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.profiles?.added).toBe(1)

      const dstProfile = (await dst.repos.profiles.getByName("remap-profile"))._unsafeUnwrap()
      const remapRoute = dstProfile.sources.find((s) => s.toolNamespace === "remap_ns")
      const publicRoute = dstProfile.sources.find((s) => s.toolNamespace === "public_ns")
      expect(remapRoute).toBeDefined()
      expect(publicRoute).toBeDefined()
      expect(publicRoute?.credentialId).toBeUndefined()

      // The remapped route's credentialId must point at the FRESH dst credential.
      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      const dstCred = dstCreds.find((c) => c.name === cred.name)
      expect(dstCred).toBeDefined()
      expect(String(remapRoute?.credentialId)).toBe(String(dstCred?.id))
      expect(String(remapRoute?.credentialId)).not.toBe(String(cred.id))
    })

    it("profiles: collision-skipped credential's route remaps to the EXISTING target id (C2 — not dropped)", async () => {
      const platform = await seedPlatform(src.repos)
      const srcCred = (
        await addCredential(
          { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
          platform,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()
      await src.repos.profiles.create({
        id: "profile-c2-1",
        name: "c2-profile",
        sources: [
          {
            platformId: platform.id,
            credentialId: srcCred.id,
            toolNamespace: "c2_ns",
            enabled: true,
          },
        ],
      })

      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "c2-pass",
        includeProfiles: true,
      })
      if (!exportResult.isOk()) throw exportResult.error

      // Pre-seed the SAME platform+account collision in dst.
      await dst.repos.platforms.upsert(platform)
      const dstExistingCred = (
        await addCredential(
          { platformId: String(platform.id), account: "work", kind: "bearer", secret: "EXISTING" },
          platform,
          dst.store,
          dst.repos.credentials,
        )
      )._unsafeUnwrap()

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "c2-pass",
        onCollision: "skip",
        includeProfiles: true,
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.skipped).toBe(1)
      expect(importResult.value.profiles?.added).toBe(1)

      const dstProfile = (await dst.repos.profiles.getByName("c2-profile"))._unsafeUnwrap()
      const route = dstProfile.sources.find((s) => s.toolNamespace === "c2_ns")
      // C2: route must remap to the EXISTING target id, NOT be dropped.
      expect(route).toBeDefined()
      expect(String(route?.credentialId)).toBe(String(dstExistingCred.id))
    })

    it("profiles: missing/failed credential's route is DROPPED with a note", async () => {
      const platform = await seedPlatform(src.repos)
      const platformB = await seedPlatform(src.repos, "Platform Missing B")
      const cred = (
        await addCredential(
          { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
          platform,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()
      const missingSecretCred = (
        await addCredential(
          {
            platformId: String(platformB.id),
            account: "will-vanish",
            kind: "bearer",
            secret: "VANISHING",
          },
          platformB,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()

      await src.repos.profiles.create({
        id: "profile-drop-1",
        name: "drop-profile",
        sources: [
          {
            platformId: platform.id,
            credentialId: cred.id,
            toolNamespace: "kept_ns",
            enabled: true,
          },
          {
            platformId: platformB.id,
            credentialId: missingSecretCred.id,
            toolNamespace: "dropped_ns",
            enabled: true,
          },
        ],
      })

      // Export with skipMissing AFTER deleting the second credential's secret —
      // it will be skipped at export time, so its _srcId never enters idMap.
      await src.store.delete(missingSecretCred.secretRef)
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "drop-pass",
        includeProfiles: true,
        skipMissing: true,
      })
      if (!exportResult.isOk()) throw exportResult.error

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "drop-pass",
        includeProfiles: true,
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return

      const dstProfile = (await dst.repos.profiles.getByName("drop-profile"))._unsafeUnwrap()
      expect(dstProfile.sources.find((s) => s.toolNamespace === "kept_ns")).toBeDefined()
      expect(dstProfile.sources.find((s) => s.toolNamespace === "dropped_ns")).toBeUndefined()
    })

    it("profiles: a name collision on target is skipped by default (its credentials still import)", async () => {
      const platform = await seedPlatform(src.repos)
      const cred = (
        await addCredential(
          { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
          platform,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()
      await src.repos.profiles.create({
        id: "profile-namecollide-1",
        name: "shared-name",
        sources: [
          {
            platformId: platform.id,
            credentialId: cred.id,
            toolNamespace: "namecollide_ns",
            enabled: true,
          },
        ],
      })

      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "namecollide-pass",
        includeProfiles: true,
      })
      if (!exportResult.isOk()) throw exportResult.error

      // Pre-seed a profile with the SAME name on dst.
      await dst.repos.profiles.create({
        id: "profile-existing-1",
        name: "shared-name",
        sources: [],
      })

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "namecollide-pass",
        includeProfiles: true,
      })
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.profiles?.skipped).toBe(1)
      expect(importResult.value.profiles?.added).toBe(0)
      // The credential itself still imported despite the profile wrapper being skipped.
      expect(importResult.value.credentials.added).toBe(1)
    })

    it("profiles: name collision + --on-collision error aborts the whole import", async () => {
      const platform = await seedPlatform(src.repos)
      const cred = (
        await addCredential(
          { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
          platform,
          src.store,
          src.repos.credentials,
        )
      )._unsafeUnwrap()
      await src.repos.profiles.create({
        id: "profile-namecollide-err-1",
        name: "err-shared-name",
        sources: [
          {
            platformId: platform.id,
            credentialId: cred.id,
            toolNamespace: "err_namecollide_ns",
            enabled: true,
          },
        ],
      })
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "namecollide-err-pass",
        includeProfiles: true,
      })
      if (!exportResult.isOk()) throw exportResult.error

      await dst.repos.profiles.create({
        id: "profile-existing-err-1",
        name: "err-shared-name",
        sources: [],
      })

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "namecollide-err-pass",
        includeProfiles: true,
        onCollision: "error",
      })
      expect(importResult.isErr()).toBe(true)
      if (importResult.isErr()) expect(importResult.error.kind).toBe("import-failed")
    })

    it("oauth2 dedicated path: addCredential is never used for oauth2 (would have refused)", async () => {
      const platform = await seedPlatform(src.repos)
      await src.store.set("ref-access-dedicated", "ACCESS_DEDICATED")
      await src.repos.credentials.create({
        id: "cred-oauth-dedicated",
        name: "oauth-dedicated-cred-oauth-dedicated",
        platformId: String(platform.id),
        kind: "oauth2",
        secretRef: "ref-access-dedicated",
        oauthMeta: { needsReauth: false },
      })
      const exportResult = await exportVault({
        repos: src.repos,
        store: src.store,
        passphrase: "dedicated-pass",
      })
      if (!exportResult.isOk()) throw exportResult.error

      const importResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive: exportResult.value.archive,
        passphrase: "dedicated-pass",
      })
      // If addCredential had been used for oauth2 it would return kind-incompatible
      // and the credential would show up in `failed`, not `added`.
      expect(importResult.isOk()).toBe(true)
      if (!importResult.isOk()) return
      expect(importResult.value.credentials.added).toBe(1)
      expect(importResult.value.credentials.failed).toHaveLength(0)

      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds[0]?.kind).toBe("oauth2")
    })

    // -----------------------------------------------------------------------
    // --strict (increment 32.10) — compensation-based all-or-nothing import.
    // -----------------------------------------------------------------------
    describe("strict", () => {
      it("happy path: identical end-state to non-strict happy path, including verify-state parity", async () => {
        const platform = await seedPlatform(src.repos)
        const cred = (
          await addCredential(
            { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
            platform,
            src.store,
            src.repos.credentials,
          )
        )._unsafeUnwrap()
        // Seed a verify result so we can prove strict carries it exactly like non-strict.
        await src.repos.credentials.setVerifyState(cred.id, "ok", 1_700_000_000_000)

        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-happy-pass",
        })
        if (!exportResult.isOk()) throw exportResult.error

        const importResult = await importVault({
          repos: dst.repos,
          store: dst.store,
          archive: exportResult.value.archive,
          passphrase: "strict-happy-pass",
          strict: true,
        })
        expect(importResult.isOk()).toBe(true)
        if (!importResult.isOk()) return
        expect(importResult.value.credentials.added).toBe(1)
        expect(importResult.value.credentials.failed).toHaveLength(0)

        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(1)
        expect(dstCreds[0]?.lastVerifyResult).toBe("ok")
        expect(dstCreds[0]?.lastVerifiedAt).toBe(1_700_000_000_000)
        const secret = (await dst.store.get(dstCreds[0]?.secretRef ?? ""))._unsafeUnwrap()
        expect(secret).toBe("S1")
      })

      it("flaky store failing the Nth set → full compensation (rows + refs), typed import-failed", async () => {
        const platformA = await seedPlatform(src.repos, "Strict Store A")
        const platformB = await seedPlatform(src.repos, "Strict Store B")
        await addCredential(
          {
            platformId: String(platformA.id),
            account: "one",
            kind: "bearer",
            secret: "SECRET_ONE",
          },
          platformA,
          src.store,
          src.repos.credentials,
        )
        await addCredential(
          {
            platformId: String(platformB.id),
            account: "two",
            kind: "bearer",
            secret: "SECRET_TWO",
          },
          platformB,
          src.store,
          src.repos.credentials,
        )
        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-flaky-store-pass",
        })
        if (!exportResult.isOk()) throw exportResult.error

        const deletedRefs: string[] = []
        let setCallCount = 0
        const flakyStore: CredentialStore = {
          ...dst.store,
          set: (ref: string, value: string) => {
            setCallCount++
            if (setCallCount === 2) {
              return errAsync({ kind: "io-failed" as const, cause: new Error("injected failure") })
            }
            return dst.store.set(ref, value)
          },
          delete: (ref: string) => {
            deletedRefs.push(ref)
            return dst.store.delete(ref)
          },
        }

        const result = await importVault({
          repos: dst.repos,
          store: flakyStore,
          archive: exportResult.value.archive,
          passphrase: "strict-flaky-store-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.kind).toBe("import-failed")

        // Compensation removed the ONE ref that did get written.
        expect(deletedRefs.length).toBeGreaterThanOrEqual(1)

        // DB read-back is empty — the first credential's row was compensated too.
        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(0)
        const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(dstPlatforms).toHaveLength(0)
      })

      it("flaky repo decorator failing the Nth create → full compensation (the DB-failure leg)", async () => {
        const platformA = await seedPlatform(src.repos, "Strict Repo A")
        const platformB = await seedPlatform(src.repos, "Strict Repo B")
        await addCredential(
          {
            platformId: String(platformA.id),
            account: "one",
            kind: "bearer",
            secret: "SECRET_ONE",
          },
          platformA,
          src.store,
          src.repos.credentials,
        )
        await addCredential(
          {
            platformId: String(platformB.id),
            account: "two",
            kind: "bearer",
            secret: "SECRET_TWO",
          },
          platformB,
          src.store,
          src.repos.credentials,
        )
        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-flaky-repo-pass",
        })
        if (!exportResult.isOk()) throw exportResult.error

        let createCallCount = 0
        const flakyRepos: Repositories = {
          ...dst.repos,
          credentials: {
            ...dst.repos.credentials,
            create: (input) => {
              createCallCount++
              if (createCallCount === 2) {
                return errAsync({
                  kind: "constraint-violation" as const,
                  cause: new Error("injected DB failure"),
                })
              }
              return dst.repos.credentials.create(input)
            },
          },
        }

        // Record every ref written so the store-side compensation is provable
        // (not just the DB side) — pass-through otherwise.
        const writtenRefs: string[] = []
        const recordingStore: CredentialStore = {
          ...dst.store,
          set: (ref: string, value: string) => {
            writtenRefs.push(ref)
            return dst.store.set(ref, value)
          },
        }

        const result = await importVault({
          repos: flakyRepos,
          store: recordingStore,
          archive: exportResult.value.archive,
          passphrase: "strict-flaky-repo-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.kind).toBe("import-failed")

        // Everything (the platforms AND the one credential that did commit) was
        // compensated — DB read-back is empty, and the store ref was cleaned up.
        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(0)
        const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(dstPlatforms).toHaveLength(0)

        // Store read-back: the ref(s) that WERE written before the DB failure
        // no longer resolve — compensation deleted them from the store too.
        expect(writtenRefs.length).toBeGreaterThanOrEqual(1)
        for (const ref of writtenRefs) {
          expect((await dst.store.get(ref))._unsafeUnwrap()).toBeNull()
        }
      })

      it("33.1 fix 1: a strict abort rolls back an already-imported oauth2 credential's verify-state write, not just its row/refs", async () => {
        // First credential: oauth2 WITH a verify state (fix 1's addOAuthImportedCredential
        // now calls setVerifyState after create()). Second credential: a bearer
        // whose create() is injected to fail, forcing compensation to unwind
        // the FIRST (already-fully-committed, including verify-state) credential.
        const platformOauth = await seedPlatform(src.repos, "Strict OAuth Verify-State A")
        const platformBearer = await seedPlatform(src.repos, "Strict OAuth Verify-State B")

        await src.store.set("ref-access-comp", "ACCESS_TOKEN_COMP")
        const oauthCred = (
          await src.repos.credentials.create({
            id: "cred-oauth-comp",
            name: "comp-account-cred-oauth-comp",
            platformId: String(platformOauth.id),
            kind: "oauth2",
            secretRef: "ref-access-comp",
            oauthMeta: {
              authMode: "authorization_code",
              needsReauth: false,
            },
          })
        )._unsafeUnwrap()
        await src.repos.credentials.setVerifyState(oauthCred.id, "ok", 1_700_000_000_000)

        await addCredential(
          { platformId: String(platformBearer.id), account: "two", kind: "bearer", secret: "S2" },
          platformBearer,
          src.store,
          src.repos.credentials,
        )

        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-oauth-verify-comp-pass",
        })
        if (!exportResult.isOk()) throw exportResult.error

        // Manifest credential order matches archive/manifest array order — the
        // export writes platforms then credentials in creation order, so the
        // oauth2 credential (created first, above) is processed before the
        // bearer in phase 2. Fail create() on the 2nd credential call so the
        // oauth2 credential's create+setVerifyState has ALREADY happened by
        // the time compensation runs.
        let createCallCount = 0
        const flakyRepos: Repositories = {
          ...dst.repos,
          credentials: {
            ...dst.repos.credentials,
            create: (input) => {
              createCallCount++
              if (createCallCount === 2) {
                return errAsync({
                  kind: "constraint-violation" as const,
                  cause: new Error("injected DB failure — forces compensation of item 1"),
                })
              }
              return dst.repos.credentials.create(input)
            },
          },
        }

        const result = await importVault({
          repos: flakyRepos,
          store: dst.store,
          archive: exportResult.value.archive,
          passphrase: "strict-oauth-verify-comp-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.kind).toBe("import-failed")

        // The load-bearing assertion: the oauth2 credential's ROW is gone
        // entirely (compensation's delete-by-journaled-id), which — because
        // setVerifyState is a plain UPDATE on that same row, never a second
        // row — transitively rolls back the verify-state write too. If fix 1
        // ever journaled setVerifyState incorrectly (e.g. tried to "undo" it
        // with a separate compensation step that ran BEFORE the row delete,
        // or if the row delete were somehow skipped for oauth2 credentials),
        // a stray row with lastVerifyResult:"ok" would survive here.
        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(0)
        const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(dstPlatforms).toHaveLength(0)
        // And the store ref the oauth2 credential wrote is also gone.
        const dstCredsAll = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCredsAll.find((c) => c.kind === "oauth2")).toBeUndefined()
      })

      it("malformed oauth2 candidate in manifest → phase-1 abort, store NEVER touched", async () => {
        const platform = await seedPlatform(src.repos)
        const manifest: VaultManifest = {
          v: 1,
          exportedAt: new Date().toISOString(),
          platforms: [platform],
          credentials: [
            {
              platformId: String(platform.id),
              account: "bad-oauth",
              kind: "oauth2",
              // authMode is not one of the enum's allowed values — invalid shape.
              oauthMeta: { authMode: "not-a-real-mode" as never },
              secret: "ACCESS_BAD",
              _srcId: "src-bad-oauth-1",
            },
          ],
        }
        const archive = await buildRawArchive(manifest, "strict-malformed-oauth-pass")

        let setCalls = 0
        const spyStore: CredentialStore = {
          ...dst.store,
          set: (ref, value) => {
            setCalls++
            return dst.store.set(ref, value)
          },
        }

        const result = await importVault({
          repos: dst.repos,
          store: spyStore,
          archive,
          passphrase: "strict-malformed-oauth-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.kind).toBe("import-failed")
        expect(setCalls).toBe(0)

        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(0)
      })

      it("oversized file-secret in manifest → phase-1 abort via the SAME FILE_SECRET_MAX_BYTES cap (33.1 fix 4 — prevalidateStrict's own enforcement point), store NEVER touched", async () => {
        const platform = await src.repos.platforms.create({
          id: newPlatformId(),
          kind: "cli" as const,
          displayName: "CLI File-Secret Platform (strict)",
          cli: {
            tools: [
              {
                name: "greet",
                argv: [{ kind: "literal", value: "/bin/echo" }],
                args: [],
                policy: {
                  cwd: "/tmp",
                  readPaths: ["/tmp"],
                  writePaths: [],
                  allowNet: [],
                  timeoutMs: 5000,
                  envAllow: {},
                },
              },
            ],
            credentialEnvVar: "CLI_FILE_SECRET_CRED_STRICT",
          },
        })
        if (platform.isErr()) throw platform.error

        const oversized = "y".repeat(FILE_SECRET_MAX_BYTES + 1)
        const manifest: VaultManifest = {
          v: 1,
          exportedAt: new Date().toISOString(),
          platforms: [platform.value],
          credentials: [
            {
              platformId: String(platform.value.id),
              account: "oversized-file-strict",
              kind: "file",
              secret: oversized,
              _srcId: "src-oversized-file-strict-1",
            },
          ],
        }
        const archive = await buildRawArchive(manifest, "strict-file-secret-cap-pass")

        let setCalls = 0
        const spyStore: CredentialStore = {
          ...dst.store,
          set: (ref, value) => {
            setCalls++
            return dst.store.set(ref, value)
          },
        }

        const result = await importVault({
          repos: dst.repos,
          store: spyStore,
          archive,
          passphrase: "strict-file-secret-cap-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) {
          expect(result.error.kind).toBe("import-failed")
          expect(result.error.kind === "import-failed" && result.error.reason).toContain("32 KiB")
          // Must be the DIRECT phase-1 prevalidation message, NOT phase-2's
          // "strict import aborted: ... mid-import ..." compensation wrapper
          // (runStrictImport's fallback path) — that wrapper would ALSO
          // eventually reject an oversized secret (addCredential's own cap
          // enforces it independently in phase 2), so asserting only
          // isErr()+"32 KiB" cannot distinguish "prevalidateStrict's cap
          // check is correctly wired to the shared constant" from "some
          // other later check happened to catch it". Pinning "does NOT
          // contain the phase-2 wrapper text" proves THIS test exercises
          // prevalidateStrict's own FILE_SECRET_MAX_BYTES import specifically.
          expect(result.error.kind === "import-failed" && result.error.reason).not.toContain(
            "strict import aborted",
          )
        }
        // Phase-1 prevalidation caught it — zero writes, store never touched.
        expect(setCalls).toBe(0)
        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(0)
      })

      it("archive-INTERNAL duplicate credential (same platform+account twice) → phase-1 abort, zero writes", async () => {
        const platform = await seedPlatform(src.repos)
        const manifest: VaultManifest = {
          v: 1,
          exportedAt: new Date().toISOString(),
          platforms: [platform],
          credentials: [
            {
              platformId: String(platform.id),
              account: "dupe-account",
              kind: "bearer",
              secret: "SECRET_A",
              _srcId: "src-dupe-1",
            },
            {
              platformId: String(platform.id),
              account: "dupe-account",
              kind: "bearer",
              secret: "SECRET_B",
              _srcId: "src-dupe-2",
            },
          ],
        }
        const archive = await buildRawArchive(manifest, "strict-dup-account-pass")

        const result = await importVault({
          repos: dst.repos,
          store: dst.store,
          archive,
          passphrase: "strict-dup-account-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) {
          expect(result.error.kind).toBe("import-failed")
          expect(result.error.kind === "import-failed" && result.error.reason).toContain(
            "duplicate",
          )
        }

        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(0)
        const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(dstPlatforms).toHaveLength(0)
      })

      it("archive-INTERNAL duplicate platform id → phase-1 abort, zero writes", async () => {
        const platform = await seedPlatform(src.repos, "Dup Platform")
        const manifest: VaultManifest = {
          v: 1,
          exportedAt: new Date().toISOString(),
          platforms: [platform, { ...platform, displayName: "Dup Platform (renamed)" }],
          credentials: [],
        }
        const archive = await buildRawArchive(manifest, "strict-dup-platform-pass")

        const result = await importVault({
          repos: dst.repos,
          store: dst.store,
          archive,
          passphrase: "strict-dup-platform-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) {
          expect(result.error.kind).toBe("import-failed")
          expect(result.error.kind === "import-failed" && result.error.reason).toContain(
            "duplicate platform",
          )
        }
        const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(dstPlatforms).toHaveLength(0)
      })

      it("collision + --on-collision error → phase-1 abort, zero writes", async () => {
        const platform = await seedPlatform(src.repos)
        await addCredential(
          {
            platformId: String(platform.id),
            account: "work",
            kind: "bearer",
            secret: "SRC_SECRET",
          },
          platform,
          src.store,
          src.repos.credentials,
        )
        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-collision-error-pass",
        })
        if (!exportResult.isOk()) throw exportResult.error

        await dst.repos.platforms.upsert(platform)
        await addCredential(
          {
            platformId: String(platform.id),
            account: "work",
            kind: "bearer",
            secret: "DST_SECRET",
          },
          platform,
          dst.store,
          dst.repos.credentials,
        )

        let setCalls = 0
        const spyStore: CredentialStore = {
          ...dst.store,
          set: (ref, value) => {
            setCalls++
            return dst.store.set(ref, value)
          },
        }

        const result = await importVault({
          repos: dst.repos,
          store: spyStore,
          archive: exportResult.value.archive,
          passphrase: "strict-collision-error-pass",
          onCollision: "error",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.kind).toBe("import-failed")
        expect(setCalls).toBe(0)

        // Only the pre-existing credential remains — nothing new was written.
        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(dstCreds).toHaveLength(1)
        const secret = (await dst.store.get(dstCreds[0]?.secretRef ?? ""))._unsafeUnwrap()
        expect(secret).toBe("DST_SECRET")
      })

      it("--strict --on-collision overwrite → typed refusal (message pinned)", async () => {
        const result = await importVault({
          repos: dst.repos,
          store: dst.store,
          archive: Buffer.from("JVLT"),
          passphrase: "pw",
          onCollision: "overwrite",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) {
          expect(result.error.kind).toBe("import-failed")
          expect(result.error.kind === "import-failed" && result.error.reason).toBe(
            "--strict does not support --on-collision overwrite; deleted refs cannot be restored on abort — use skip or error",
          )
        }
      })

      it("dropped-route case preserved under strict: route to a credential absent from the archive is silently dropped", async () => {
        const platform = await seedPlatform(src.repos)
        const platformB = await seedPlatform(src.repos, "Strict Missing B")
        const cred = (
          await addCredential(
            { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
            platform,
            src.store,
            src.repos.credentials,
          )
        )._unsafeUnwrap()
        const missingSecretCred = (
          await addCredential(
            {
              platformId: String(platformB.id),
              account: "will-vanish",
              kind: "bearer",
              secret: "VANISHING",
            },
            platformB,
            src.store,
            src.repos.credentials,
          )
        )._unsafeUnwrap()

        await src.repos.profiles.create({
          id: "profile-strict-drop-1",
          name: "strict-drop-profile",
          sources: [
            {
              platformId: platform.id,
              credentialId: cred.id,
              toolNamespace: "strict_kept_ns",
              enabled: true,
            },
            {
              platformId: platformB.id,
              credentialId: missingSecretCred.id,
              toolNamespace: "strict_dropped_ns",
              enabled: true,
            },
          ],
        })

        await src.store.delete(missingSecretCred.secretRef)
        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-drop-pass",
          includeProfiles: true,
          skipMissing: true,
        })
        if (!exportResult.isOk()) throw exportResult.error

        const importResult = await importVault({
          repos: dst.repos,
          store: dst.store,
          archive: exportResult.value.archive,
          passphrase: "strict-drop-pass",
          includeProfiles: true,
          strict: true,
        })
        expect(importResult.isOk()).toBe(true)
        if (!importResult.isOk()) return

        const dstProfile = (
          await dst.repos.profiles.getByName("strict-drop-profile")
        )._unsafeUnwrap()
        expect(dstProfile.sources.find((s) => s.toolNamespace === "strict_kept_ns")).toBeDefined()
        expect(
          dstProfile.sources.find((s) => s.toolNamespace === "strict_dropped_ns"),
        ).toBeUndefined()
      })

      it("pre-existing destination data SURVIVES a failed strict import's compensation untouched", async () => {
        // Pins the journal invariant: compensation only ever deletes what THIS
        // import wrote — pre-existing platform/credential/ref/profile rows are
        // never journaled and never touched.
        const prePlatform = await seedPlatform(dst.repos, "Pre-existing Platform")
        const preCred = (
          await addCredential(
            {
              platformId: String(prePlatform.id),
              account: "pre-existing",
              kind: "bearer",
              secret: "PRE_EXISTING_SECRET",
            },
            prePlatform,
            dst.store,
            dst.repos.credentials,
          )
        )._unsafeUnwrap()
        await dst.repos.profiles.create({
          id: "profile-preexisting-1",
          name: "pre-existing-profile",
          sources: [
            {
              platformId: prePlatform.id,
              credentialId: preCred.id,
              toolNamespace: "preexisting_ns",
              enabled: true,
            },
          ],
        })

        // Archive with 2 NEW (non-colliding) credentials; the 2nd store.set fails.
        const platformA = await seedPlatform(src.repos, "Strict Survive A")
        const platformB = await seedPlatform(src.repos, "Strict Survive B")
        await addCredential(
          { platformId: String(platformA.id), account: "one", kind: "bearer", secret: "S_ONE" },
          platformA,
          src.store,
          src.repos.credentials,
        )
        await addCredential(
          { platformId: String(platformB.id), account: "two", kind: "bearer", secret: "S_TWO" },
          platformB,
          src.store,
          src.repos.credentials,
        )
        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-survive-pass",
        })
        if (!exportResult.isOk()) throw exportResult.error

        let setCallCount = 0
        const flakyStore: CredentialStore = {
          ...dst.store,
          set: (ref: string, value: string) => {
            setCallCount++
            if (setCallCount === 2) {
              return errAsync({ kind: "io-failed" as const, cause: new Error("injected failure") })
            }
            return dst.store.set(ref, value)
          },
        }

        const result = await importVault({
          repos: dst.repos,
          store: flakyStore,
          archive: exportResult.value.archive,
          passphrase: "strict-survive-pass",
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.kind).toBe("import-failed")

        // Every pre-existing row/ref survived the compensation untouched.
        const survivingCred = (await dst.repos.credentials.get(preCred.id))._unsafeUnwrap()
        expect(survivingCred.name).toBe(preCred.name)
        expect((await dst.store.get(preCred.secretRef))._unsafeUnwrap()).toBe("PRE_EXISTING_SECRET")
        const survivingPlatform = (await dst.repos.platforms.get(prePlatform.id))._unsafeUnwrap()
        expect(survivingPlatform.displayName).toBe("Pre-existing Platform")
        const survivingProfile = (
          await dst.repos.profiles.getByName("pre-existing-profile")
        )._unsafeUnwrap()
        expect(survivingProfile.sources).toHaveLength(1)

        // And nothing from the failed import remains.
        const allCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(allCreds).toHaveLength(1)
        const allPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(allPlatforms).toHaveLength(1)
      })

      it("flaky profiles.create failing the 2nd profile → reverse-order compensation (profile cascade before credential deletes, no RESTRICT trip)", async () => {
        // The 1st profile commits (with a source_ref pointing at a journaled
        // credential); the 2nd fails. Compensation must delete the journaled
        // profile FIRST (cascading its source_refs) so the journaled credential
        // deletes don't trip the source_refs FK RESTRICT. If the order were
        // wrong, the best-effort credential delete would silently fail and the
        // "everything gone" assertions below would catch the leftovers.
        const platform = await seedPlatform(src.repos, "Strict Profiles Platform")
        const cred = (
          await addCredential(
            { platformId: String(platform.id), account: "work", kind: "bearer", secret: "S1" },
            platform,
            src.store,
            src.repos.credentials,
          )
        )._unsafeUnwrap()
        await src.repos.profiles.create({
          id: "profile-strict-rev-1",
          name: "strict-rev-one",
          sources: [
            {
              platformId: platform.id,
              credentialId: cred.id,
              toolNamespace: "strict_rev_ns1",
              enabled: true,
            },
          ],
        })
        await src.repos.profiles.create({
          id: "profile-strict-rev-2",
          name: "strict-rev-two",
          sources: [
            {
              platformId: platform.id,
              credentialId: cred.id,
              toolNamespace: "strict_rev_ns2",
              enabled: true,
            },
          ],
        })
        const exportResult = await exportVault({
          repos: src.repos,
          store: src.store,
          passphrase: "strict-rev-pass",
          includeProfiles: true,
        })
        if (!exportResult.isOk()) throw exportResult.error

        let profileCreateCount = 0
        const flakyRepos: Repositories = {
          ...dst.repos,
          profiles: {
            ...dst.repos.profiles,
            create: (input) => {
              profileCreateCount++
              if (profileCreateCount === 2) {
                return errAsync({
                  kind: "query-failed" as const,
                  cause: new Error("injected profile failure"),
                })
              }
              return dst.repos.profiles.create(input)
            },
          },
        }

        const result = await importVault({
          repos: flakyRepos,
          store: dst.store,
          archive: exportResult.value.archive,
          passphrase: "strict-rev-pass",
          includeProfiles: true,
          strict: true,
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error.kind).toBe("import-failed")

        // EVERYTHING is gone: the committed profile (cascade), the credential
        // (only deletable because the profile went first), the platform.
        const profiles = (await dst.repos.profiles.list())._unsafeUnwrap()
        expect(profiles).toHaveLength(0)
        const creds = (await dst.repos.credentials.list())._unsafeUnwrap()
        expect(creds).toHaveLength(0)
        const platforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(platforms).toHaveLength(0)
      })
    })

    // -------------------------------------------------------------------------
    // Increment 44 (R2) — the inline 0012-equivalent backfill on import.
    // -------------------------------------------------------------------------

    describe("inline oauth_provider_id backfill (increment 44)", () => {
      it("OLD-format archive (credential carries providerId, platform doesn't) → the imported platform GAINS oauthProviderId; refresh works via the resolver with the fallback NOT hit", async () => {
        // Simulate an OLD (pre-45) archive: the platform manifest entry has
        // NO oauthProviderId (as if exported before increment 44 added the
        // field), and the credential manifest entry's oauthMeta.providerId
        // IS present — the archive-only legacy field (ManifestOAuthMetaSchema
        // keeps it for exactly this back-compat purpose; the LIVE
        // OAuthMetaSchema dropped it in Slice E, so this can no longer be
        // produced by seeding a live credential + exportVault — the manifest
        // is hand-built directly instead, mirroring buildRawArchive's other
        // uses in this file for archive-internal shapes the live schema
        // can't produce anymore).
        const platformA = await seedPlatform(src.repos, "OAuth Platform")
        expect(platformA.oauthProviderId).toBeUndefined()

        const manifest: VaultManifest = {
          v: 1,
          exportedAt: new Date().toISOString(),
          platforms: [platformA],
          credentials: [
            {
              name: "oauth-account-cred-old",
              platformId: String(platformA.id),
              account: "oauth-account",
              kind: "oauth2",
              oauthMeta: {
                providerId: "github",
                authMode: "authorization_code",
                needsReauth: false,
              },
              secret: "ACCESS_TOKEN_OLD",
              refreshToken: "REFRESH_TOKEN_OLD",
              clientId: "CLIENT_ID_OLD",
              clientSecret: "CLIENT_SECRET_OLD",
              _srcId: "cred-oauth-old-format",
            },
          ],
        }
        const archive = await buildRawArchive(manifest, "old-format-pass")

        const importResult = await importVault({
          repos: dst.repos,
          store: dst.store,
          archive,
          passphrase: "old-format-pass",
        })
        expect(importResult.isOk()).toBe(true)
        if (!importResult.isOk()) return
        expect(importResult.value.credentials.added).toBe(1)
        expect(importResult.value.platforms.added).toBe(1)

        const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(dstPlatforms).toHaveLength(1)
        // The inline backfill (R2) fills the platform's oauthProviderId from
        // the imported credential's legacy oauthMeta.providerId.
        const dstPlatform = dstPlatforms[0]
        expect(dstPlatform?.oauthProviderId).toBe("github")
        if (dstPlatform === undefined) return

        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        const dstOauth = dstCreds.find((c) => c.kind === "oauth2")
        expect(dstOauth).toBeDefined()
        if (dstOauth === undefined) return

        // Force an actual refresh (expiresAt in the past) so refreshIfExpired
        // genuinely exercises resolveOAuthProviderId end-to-end — proves
        // refresh works via the backfilled platform.oauthProviderId (the
        // archive's legacy providerId copy fed ONLY the platform backfill;
        // increment 45 Slice E removed the fallback arm entirely, so this is
        // now the ONLY path that can make this credential refresh again).
        let seenProviderId: string | undefined
        const refreshResult = await refreshIfExpired({
          credential: {
            ...dstOauth,
            oauthMeta: { ...dstOauth.oauthMeta, expiresAt: new Date(0).toISOString() },
          },
          store: dst.store,
          repos: { credentials: dst.repos.credentials },
          refreshFn: async (args) => {
            seenProviderId = args.providerId
            return { ok: true, tokens: { accessToken: "NEW_ACCESS_TOKEN" } }
          },
          now: Date.now(),
          platform: dstPlatform,
          designs: BUILT_INS_ONLY,
        })
        expect(refreshResult.isOk()).toBe(true)
        expect(seenProviderId).toBe("github")
      })

      it("CONFLICT: two OLD-format oauth2 credentials on one platform disagreeing on providerId → the imported platform's oauthProviderId stays UNSET; both still resolve via the fallback", async () => {
        const platformA = await seedPlatform(src.repos, "Conflicting OAuth Platform")

        // Same archive-shape rationale as the previous test — the live
        // credential schema can no longer carry `oauthMeta.providerId`
        // (Slice E), so a "two archive entries disagree on the legacy
        // providerId" scenario is only producible via a hand-built manifest.
        const manifest: VaultManifest = {
          v: 1,
          exportedAt: new Date().toISOString(),
          platforms: [platformA],
          credentials: [
            {
              name: "conflict-x",
              platformId: String(platformA.id),
              account: "x",
              kind: "oauth2",
              oauthMeta: { providerId: "github", needsReauth: false },
              secret: "ACCESS_X",
              _srcId: "cred-conflict-x",
            },
            {
              name: "conflict-y",
              platformId: String(platformA.id),
              account: "y",
              kind: "oauth2",
              oauthMeta: { providerId: "google", needsReauth: false },
              secret: "ACCESS_Y",
              _srcId: "cred-conflict-y",
            },
          ],
        }
        const archive = await buildRawArchive(manifest, "conflict-pass")

        const importResult = await importVault({
          repos: dst.repos,
          store: dst.store,
          archive,
          passphrase: "conflict-pass",
        })
        expect(importResult.isOk()).toBe(true)
        if (!importResult.isOk()) return
        expect(importResult.value.credentials.added).toBe(2)

        const dstPlatforms = (await dst.repos.platforms.list())._unsafeUnwrap()
        expect(dstPlatforms).toHaveLength(1)
        // Conflict rule: left UNSET, never guessed.
        expect(dstPlatforms[0]?.oauthProviderId).toBeUndefined()

        // Increment 45, Slice E — neither credential can resolve via a
        // legacy fallback anymore (the field no longer exists on the LIVE
        // credential; only the archive carried it, and that copy is used
        // ONLY for the platform backfill, never written onto the imported
        // row). With the platform's oauthProviderId left unset by the
        // conflict rule, resolution now correctly fails closed for both.
        const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
        const platform = dstPlatforms[0]
        expect(platform).toBeDefined()
        if (platform === undefined) return
        for (const cred of dstCreds) {
          const resolved = resolveOAuthProviderId({
            credentialId: cred.id,
            context: "refresh",
            platform,
            designs: BUILT_INS_ONLY,
          })
          expect(resolved.ok).toBe(false)
          if (resolved.ok) continue
          expect(resolved.error.kind).toBe("no-provider-source")
        }
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Increment 46 (Fable RD/RE) — identity re-point: effective name (not
  // per-platform account) is the collision key; pre-46/pre-42 archives still
  // import cleanly.
  // ---------------------------------------------------------------------------
  describe("identity re-point (increment 46, RD)", () => {
    let dst: Fixture

    beforeEach(async () => {
      dst = await makeHome("junction-import-namerepoint-dst-")
    })

    afterEach(async () => {
      await dst.restore()
    })

    it("pre-46 archive where account !== name imports cleanly, with `name` winning as identity", async () => {
      const platform = await seedPlatform(src.repos, "Pre-46 Platform")
      // A pre-46 archive can carry a manifest credential whose `account`
      // (the old profileName-sourced label) diverges from `name` — e.g. an
      // explicit-name create (`--name gh-main --account work`) or a
      // subsequent rename that only touched `name` (RE's divergence paths).
      const manifest: VaultManifest = {
        v: 1,
        exportedAt: new Date().toISOString(),
        platforms: [platform],
        credentials: [
          {
            name: "gh-main",
            platformId: String(platform.id),
            account: "work", // diverges from `name` — must be IGNORED as identity
            kind: "bearer",
            secret: "PRE46_SECRET",
            _srcId: "src-pre46-divergent-1",
          },
        ],
      }
      const archive = await buildRawArchive(manifest, "pre46-divergent-pass")

      const result = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive,
        passphrase: "pre46-divergent-pass",
      })
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.credentials.added).toBe(1)
      expect(result.value.credentials.failed).toHaveLength(0)

      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(1)
      // `name` wins as identity — NOT `account`.
      expect(dstCreds[0]?.name).toBe("gh-main")
      expect((await dst.store.get(dstCreds[0]?.secretRef ?? ""))._unsafeUnwrap()).toBe(
        "PRE46_SECRET",
      )
    })

    it("pre-42 archive with NO mc.name derives a name from account and imports", async () => {
      const platform = await seedPlatform(src.repos, "Pre-42 Platform")
      // A pre-42 archive predates the `name` field entirely — the manifest
      // credential carries only `account` (no `name` key at all).
      const manifest: VaultManifest = {
        v: 1,
        exportedAt: new Date().toISOString(),
        platforms: [platform],
        credentials: [
          {
            platformId: String(platform.id),
            account: "legacy-account",
            kind: "bearer",
            secret: "PRE42_SECRET",
            _srcId: "src-pre42-1",
          },
        ],
      }
      const archive = await buildRawArchive(manifest, "pre42-pass")

      const result = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive,
        passphrase: "pre42-pass",
      })
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.credentials.added).toBe(1)
      expect(result.value.credentials.failed).toHaveLength(0)

      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(1)
      // Derived per deriveCredentialName's rule: `<platformId>-<account>`, slugified.
      expect(dstCreds[0]?.name).toBe(`${String(platform.id).toLowerCase()}-legacy-account`)
    })

    it("collision is keyed by NAME globally, regardless of platform — a manifest credential whose effective name already exists on a DIFFERENT platform is detected", async () => {
      const platformSrc = await seedPlatform(src.repos, "Collision Src Platform")

      // Seed a pre-existing dst credential — UNLINKED, on no platform at all —
      // carrying the SAME name the incoming (platform-linked) archive
      // credential will resolve to. Proves the collision check is global
      // across the linked/unlinked divide too, not just cross-platform.
      const existing = (
        await addStandaloneCredential(
          { name: "shared-global-name", kind: "bearer", secret: "EXISTING_SECRET" },
          dst.store,
          dst.repos.credentials,
        )
      )._unsafeUnwrap()

      const manifest: VaultManifest = {
        v: 1,
        exportedAt: new Date().toISOString(),
        platforms: [platformSrc],
        credentials: [
          {
            name: "shared-global-name",
            platformId: String(platformSrc.id),
            account: "irrelevant-account",
            kind: "bearer",
            secret: "INCOMING_SECRET",
            _srcId: "src-global-collide-1",
          },
        ],
      }
      const archive = await buildRawArchive(manifest, "global-collide-pass")

      // skip (default): the DIFFERENT-platform, SAME-name credential is still
      // recognized as a collision — proves the check is global, not per-platform.
      const skipResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive,
        passphrase: "global-collide-pass",
      })
      expect(skipResult.isOk()).toBe(true)
      if (!skipResult.isOk()) return
      expect(skipResult.value.credentials.skipped).toBe(1)
      expect(skipResult.value.credentials.added).toBe(0)
      const afterSkip = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(afterSkip).toHaveLength(1)
      expect((await dst.store.get(afterSkip[0]?.secretRef ?? ""))._unsafeUnwrap()).toBe(
        "EXISTING_SECRET",
      ) // untouched

      // error: aborts on the same cross-platform name collision.
      const errorResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive,
        passphrase: "global-collide-pass",
        onCollision: "error",
      })
      expect(errorResult.isErr()).toBe(true)
      if (errorResult.isErr()) expect(errorResult.error.kind).toBe("import-failed")

      // overwrite: replaces the pre-existing (different-platform) row.
      const overwriteResult = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive,
        passphrase: "global-collide-pass",
        onCollision: "overwrite",
      })
      expect(overwriteResult.isOk()).toBe(true)
      if (!overwriteResult.isOk()) return
      expect(overwriteResult.value.credentials.overwritten).toBe(1)
      const afterOverwrite = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(afterOverwrite).toHaveLength(1)
      expect(afterOverwrite[0]?.id).not.toBe(existing.id)
      expect((await dst.store.get(afterOverwrite[0]?.secretRef ?? ""))._unsafeUnwrap()).toBe(
        "INCOMING_SECRET",
      )
    })

    it("strict prevalidation's within-archive duplicate check is keyed by effective NAME (not [platformId, account])", async () => {
      const platformA = await seedPlatform(src.repos, "Strict Name Dup A")
      const platformB = await seedPlatform(src.repos, "Strict Name Dup B")
      // Two DIFFERENT platforms, DIFFERENT accounts, but the SAME explicit
      // `name` — under the old [platformId, account] key this would NOT have
      // collided; under the new effective-name key it must.
      const manifest: VaultManifest = {
        v: 1,
        exportedAt: new Date().toISOString(),
        platforms: [platformA, platformB],
        credentials: [
          {
            name: "clashing-name",
            platformId: String(platformA.id),
            account: "account-a",
            kind: "bearer",
            secret: "SECRET_A",
            _srcId: "src-name-dup-a",
          },
          {
            name: "clashing-name",
            platformId: String(platformB.id),
            account: "account-b",
            kind: "bearer",
            secret: "SECRET_B",
            _srcId: "src-name-dup-b",
          },
        ],
      }
      const archive = await buildRawArchive(manifest, "strict-name-dup-pass")

      const result = await importVault({
        repos: dst.repos,
        store: dst.store,
        archive,
        passphrase: "strict-name-dup-pass",
        strict: true,
      })
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("import-failed")
        expect(result.error.kind === "import-failed" && result.error.reason).toContain("duplicate")
      }
      const dstCreds = (await dst.repos.credentials.list())._unsafeUnwrap()
      expect(dstCreds).toHaveLength(0)
    })
  })
})
