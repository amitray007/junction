// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests: repositories against an in-memory SQLite DB.
// Uses tmp file path so migrations can run (better-sqlite3 in-memory + migrate requires file path for migrator).

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../db/index.js"
import { getDatabase } from "../db/index.js"
import { newCredentialId, newPlatformId, newProfileId } from "../ids/index.js"
import { getPaths } from "../paths/index.js"
import type { Repositories } from "./index.js"
import { createRepositories } from "./index.js"

describe("repositories", () => {
  let db: Db
  let repos: Repositories
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    home = await mkdtemp(join(tmpdir(), "junction-test-"))
    process.env.JUNCTION_HOME = home
    const result = await getDatabase(getPaths())
    if (result.isErr()) throw result.error
    db = result.value
    repos = createRepositories(db)
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  describe("platforms", () => {
    it("creates and retrieves a platform", async () => {
      const platform = {
        id: newPlatformId(),
        kind: "mcp" as const,
        displayName: "GitHub",
      }
      const created = await repos.platforms.create(platform)
      expect(created.isOk()).toBe(true)

      const fetched = await repos.platforms.get(platform.id)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.displayName).toBe("GitHub")
      }
    })

    it("returns not-found for missing platform", async () => {
      const result = await repos.platforms.get("plat_nonexistent")
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("not-found")
      }
    })

    it("lists all platforms", async () => {
      await repos.platforms.create({
        id: newPlatformId(),
        kind: "mcp" as const,
        displayName: "GitHub",
      })
      await repos.platforms.create({
        id: newPlatformId(),
        kind: "openapi" as const,
        displayName: "Linear",
      })
      const list = await repos.platforms.list()
      expect(list.isOk()).toBe(true)
      if (list.isOk()) expect(list.value.length).toBe(2)
    })

    it("deletes a platform", async () => {
      const id = newPlatformId()
      await repos.platforms.create({ id, kind: "mcp" as const, displayName: "GitHub" })
      await repos.platforms.delete(id)
      const fetched = await repos.platforms.get(id)
      expect(fetched.isErr()).toBe(true)
    })

    it("rejects deleting a platform that still has credentials (FK enforced)", async () => {
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })
      await repos.credentials.create({
        id: newCredentialId(),
        platformId,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "keyring://junction/ref_plat_del",
      })

      const result = await repos.platforms.delete(platformId)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("constraint-violation")
    })
  })

  describe("credentials — multi-account wedge", () => {
    it("stores and retrieves a credential by id", async () => {
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })

      const cred = {
        id: newCredentialId(),
        platformId,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "keyring://junction/cred_abc",
      }
      const created = await repos.credentials.create(cred)
      expect(created.isOk()).toBe(true)

      const fetched = await repos.credentials.get(cred.id)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        // secretRef is an opaque handle — never a secret value
        expect(fetched.value.secretRef).toBe("keyring://junction/cred_abc")
        expect(fetched.value.secretRef).not.toMatch(/^(ghp_|sk-|token=)/)
      }
    })

    it("forPlatform returns credentials for that platform only", async () => {
      const platformId1 = newPlatformId()
      const platformId2 = newPlatformId()
      await repos.platforms.create({ id: platformId1, kind: "mcp" as const, displayName: "GitHub" })
      await repos.platforms.create({
        id: platformId2,
        kind: "openapi" as const,
        displayName: "Linear",
      })

      await repos.credentials.create({
        id: newCredentialId(),
        platformId: platformId1,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "ref1",
      })
      await repos.credentials.create({
        id: newCredentialId(),
        platformId: platformId1,
        profileName: "personal",
        kind: "api-key" as const,
        secretRef: "ref2",
      })
      await repos.credentials.create({
        id: newCredentialId(),
        platformId: platformId2,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "ref3",
      })

      const result = await repos.credentials.forPlatform(platformId1)
      expect(result.isOk()).toBe(true)
      if (result.isOk()) {
        expect(result.value.length).toBe(2)
        expect(result.value.every((c) => c.platformId === platformId1)).toBe(true)
      }
    })
  })

  describe("profiles — nested source_refs", () => {
    it("round-trips a profile with 2 source_refs", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()

      // Pre-insert platform and credential (required by FK constraints)
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "keyring://junction/cred_roundtrip",
      })

      const profile = {
        id: profileId,
        name: "my-profile",
        mcpEndpointPath: "/profiles/my-profile/mcp",
        sources: [
          {
            platformId,
            credentialId: credId,
            toolNamespace: "github",
            enabled: true,
          },
          {
            platformId,
            credentialId: credId,
            toolNamespace: "github2",
            enabled: false,
          },
        ],
      }

      const created = await repos.profiles.create(profile)
      expect(created.isOk()).toBe(true)

      const fetched = await repos.profiles.getByName("my-profile")
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.name).toBe("my-profile")
        expect(fetched.value.sources.length).toBe(2)
        expect(fetched.value.sources[0]?.toolNamespace).toBe("github")
        expect(fetched.value.sources[1]?.toolNamespace).toBe("github2")
      }
    })

    it("rejects a duplicate profile name with constraint-violation", async () => {
      const first = await repos.profiles.create({
        id: newProfileId(),
        name: "dup",
        mcpEndpointPath: "/profiles/dup/mcp",
        sources: [],
      })
      expect(first.isOk()).toBe(true)

      const second = await repos.profiles.create({
        id: newProfileId(),
        name: "dup",
        mcpEndpointPath: "/profiles/dup/mcp",
        sources: [],
      })
      expect(second.isErr()).toBe(true)
      if (second.isErr()) expect(second.error.kind).toBe("constraint-violation")
    })

    it("deletes profile and cascades source_refs", async () => {
      const profileId = newProfileId()
      const platformId = newPlatformId()
      const credId = newCredentialId()

      // Pre-insert platform and credential (required by FK constraints)
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "keyring://junction/cred_cascade",
      })

      const profile = {
        id: profileId,
        name: "cascade-test",
        mcpEndpointPath: "/profiles/cascade-test/mcp",
        sources: [
          {
            platformId,
            credentialId: credId,
            toolNamespace: "github",
            enabled: true,
          },
        ],
      }
      await repos.profiles.create(profile)

      // Precondition: the source_ref row exists.
      const before = db.all<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM source_refs WHERE profile_id = ${profileId}`,
      )
      expect(before[0]?.n).toBe(1)

      await repos.profiles.delete(profileId)

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isErr()).toBe(true)
      if (fetched.isErr()) expect(fetched.error.kind).toBe("not-found")

      // ON DELETE CASCADE must have removed the child source_refs (depends on
      // PRAGMA foreign_keys = ON being active on the connection).
      const orphans = db.all<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM source_refs WHERE profile_id NOT IN (SELECT id FROM profiles)`,
      )
      expect(orphans[0]?.n).toBe(0)
    })

    it("has PRAGMA foreign_keys enabled on the connection (cascade contract)", () => {
      const rows = db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
      expect(rows[0]?.foreign_keys).toBe(1)
    })

    it("rejects a source_ref with a non-existent credential_id (FK enforced)", async () => {
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })

      const result = await repos.profiles.create({
        id: newProfileId(),
        name: "fk-cred-test",
        mcpEndpointPath: "/profiles/fk-cred-test/mcp",
        sources: [
          {
            platformId,
            credentialId: newCredentialId(), // valid-looking ID but not in DB
            toolNamespace: "github",
            enabled: true,
          },
        ],
      })
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("constraint-violation")
    })

    it("cascade then delete: deleting profile frees credential for deletion", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "keyring://junction/cred_del_test",
      })
      await repos.profiles.create({
        id: profileId,
        name: "cred-del-test",
        mcpEndpointPath: "/profiles/cred-del-test/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "gh", enabled: true }],
      })

      // Deleting the credential while source_ref references it must fail
      const failDel = await repos.credentials.delete(credId)
      expect(failDel.isErr()).toBe(true)
      if (failDel.isErr()) expect(failDel.error.kind).toBe("constraint-violation")

      // Deleting the profile cascades its source_refs, then credential can be deleted
      await repos.profiles.delete(profileId)
      const okDel = await repos.credentials.delete(credId)
      expect(okDel.isOk()).toBe(true)
    })

    it("lists all profiles", async () => {
      await repos.profiles.create({
        id: newProfileId(),
        name: "a",
        mcpEndpointPath: "/profiles/a/mcp",
        sources: [],
      })
      await repos.profiles.create({
        id: newProfileId(),
        name: "b",
        mcpEndpointPath: "/profiles/b/mcp",
        sources: [],
      })
      const list = await repos.profiles.list()
      expect(list.isOk()).toBe(true)
      if (list.isOk()) expect(list.value.length).toBe(2)
    })
  })

  describe("migrations", () => {
    it("are idempotent — getDatabase twice on the same home is a no-op", async () => {
      // First getDatabase already ran in beforeEach and migrated the DB.
      // Opening again must not error and must not duplicate tables or rows.
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })

      const second = await getDatabase(getPaths())
      expect(second.isOk()).toBe(true)
      if (second.isErr()) return

      // Data persisted through the first handle is visible through the second —
      // proves migrate() did not recreate/clobber tables on the second open.
      const repos2 = createRepositories(second.value)
      const list = await repos2.platforms.list()
      expect(list.isOk()).toBe(true)
      if (list.isOk()) {
        expect(list.value.length).toBe(1)
        expect(list.value[0]?.id).toBe(platformId)
      }
    })
  })

  describe("secrets-as-references (security.md + data.md)", () => {
    it("the credentials table has secret_ref and NO column holding a secret value", () => {
      // Inspect the actual on-disk schema, not just the entity shape. The only
      // secret-adjacent column is the opaque reference handle `secret_ref`.
      const cols = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('credentials')`)
      const names = cols.map((c) => c.name)
      expect(names).toContain("secret_ref")
      // No column whose name implies it holds the secret itself.
      const forbidden = names.filter((n) =>
        /^(secret|password|token|api_?key|plaintext|ciphertext)$/.test(n),
      )
      expect(forbidden).toEqual([])
    })

    it("never writes a secret value to disk — only the opaque secret_ref handle", async () => {
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "GitHub" })
      await repos.credentials.create({
        id: newCredentialId(),
        platformId,
        profileName: "work",
        kind: "api-key" as const,
        secretRef: "keyring://junction/cred_abc",
      })

      // Read the raw row back; the only secret-adjacent value is the handle.
      const rows = db.all<Record<string, unknown>>(sql`SELECT * FROM credentials`)
      expect(rows.length).toBe(1)
      const row = rows[0]
      expect(row?.secret_ref).toBe("keyring://junction/cred_abc")
      // No raw secret material anywhere in the row.
      const serialized = JSON.stringify(row)
      expect(serialized).not.toMatch(/ghp_|sk-|Bearer\s/)
    })
  })
})
