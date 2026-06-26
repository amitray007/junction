// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests: repositories against an in-memory SQLite DB.
// Uses tmp file path so migrations can run (better-sqlite3 in-memory + migrate requires file path for migrator).

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { sql } from "drizzle-orm"
import { errAsync, okAsync } from "neverthrow"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addCredential } from "../credentials/add-credential.js"
import type { CredentialStore } from "../credentials/store.js"
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

    it("delete() returns not-found when the platform id does not exist", async () => {
      // platforms.delete checks .changes === 0 and returns a typed not-found rather than
      // silently returning Ok — so `platform remove --id bad-id` → exit≠0, not ok:true.
      const missingId = newPlatformId()
      const result = await repos.platforms.delete(missingId)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("not-found")
        expect(result.error.entity).toBe("platform")
        expect(result.error.id).toBe(missingId)
      }
    })

    it("rejects deleting a platform that still has credentials (FK enforced → in-use)", async () => {
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
      // FK RESTRICT on platform_id → in-use (not generic constraint-violation)
      if (result.isErr()) expect(result.error.kind).toBe("in-use")
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

    it("rejects a source_ref with a non-existent credential_id (FK enforced → in-use)", async () => {
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
      // FK violation on insert: SQLITE_CONSTRAINT_FOREIGNKEY → in-use
      if (result.isErr()) expect(result.error.kind).toBe("in-use")
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

      // Deleting the credential while source_ref references it must fail (in-use)
      const failDel = await repos.credentials.delete(credId)
      expect(failDel.isErr()).toBe(true)
      if (failDel.isErr()) expect(failDel.error.kind).toBe("in-use")

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

  // ---------------------------------------------------------------------------
  // Migration 0004 — nullable credential_id (inc 16)
  // ---------------------------------------------------------------------------
  describe("migration 0004 — nullable credential_id", () => {
    it("source_ref with NULL credential_id round-trips: undefined in SourceRef", async () => {
      const platformId = newPlatformId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.profiles.create({
        id: profileId,
        name: "m0004-null",
        mcpEndpointPath: "/profiles/m0004-null/mcp",
        sources: [],
      })

      // Insert directly with NULL credential_id to simulate pre-existing data
      db.run(
        sql`INSERT INTO source_refs (id, profile_id, platform_id, credential_id, tool_namespace, enabled)
            VALUES ('sr_m0004_test', ${String(profileId)}, ${String(platformId)}, NULL, 'null_ns', 1)`,
      )

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        const src = fetched.value.sources[0]
        expect(src?.toolNamespace).toBe("null_ns")
        // NULL DB value → undefined in SourceRef (not null, not the string "null")
        expect(src?.credentialId).toBeUndefined()
      }
    })

    it("a credentialed source round-trips through the post-0004 schema (FK + data intact)", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_m0004_cred",
      })
      await repos.profiles.create({
        id: profileId,
        name: "m0004-cred",
        mcpEndpointPath: "/profiles/m0004-cred/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "cred_ns", enabled: true }],
      })

      // Read back: credentialId must survive as-is (not lost by migration)
      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources[0]?.credentialId).toBe(credId)
      }
    })

    it("(profile_id, tool_namespace) unique index exists after migration 0004", () => {
      const indexes = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='source_refs'`,
      )
      const names = indexes.map((i) => i.name)
      expect(names).toContain("source_refs_profile_ns_unique")
    })

    it("credential_id column is nullable after migration 0004", () => {
      // PRAGMA table_info notnull=0 means nullable
      const cols = db.all<{ name: string; notnull: number }>(
        sql`SELECT name, "notnull" FROM pragma_table_info('source_refs')`,
      )
      const credCol = cols.find((c) => c.name === "credential_id")
      expect(credCol).toBeDefined()
      expect(credCol?.notnull).toBe(0) // 0 = nullable
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

  // ---------------------------------------------------------------------------
  // platforms.upsert — connection descriptor round-trip (inc 10)
  // ---------------------------------------------------------------------------
  describe("platforms.upsert — connection round-trip", () => {
    it("upserts a platform with an http connection and retrieves it", async () => {
      const platformId = newPlatformId()
      const platform = {
        id: platformId,
        kind: "mcp" as const,
        displayName: "Remote MCP",
        connection: {
          transport: "http" as const,
          url: "https://api.example.com/mcp/",
          auth: { scheme: "bearer" as const, header: "Authorization" },
        },
      }
      const created = await repos.platforms.upsert(platform)
      expect(created.isOk()).toBe(true)

      const fetched = await repos.platforms.get(platformId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.connection?.transport).toBe("http")
        if (fetched.value.connection?.transport === "http") {
          expect(fetched.value.connection.url).toBe("https://api.example.com/mcp/")
          expect(fetched.value.connection.auth?.header).toBe("Authorization")
        }
      }
    })

    it("upserts a platform with a stdio connection", async () => {
      const platformId = newPlatformId()
      const created = await repos.platforms.upsert({
        id: platformId,
        kind: "mcp" as const,
        displayName: "Local MCP",
        connection: {
          transport: "stdio" as const,
          command: "npx",
          args: ["-y", "@mcp/server-example"],
          tokenEnvVar: "MCP_TOKEN",
        },
      })
      expect(created.isOk()).toBe(true)

      const fetched = await repos.platforms.get(platformId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk() && fetched.value.connection?.transport === "stdio") {
        expect(fetched.value.connection.command).toBe("npx")
        expect(fetched.value.connection.args).toEqual(["-y", "@mcp/server-example"])
        expect(fetched.value.connection.tokenEnvVar).toBe("MCP_TOKEN")
      }
    })

    it("upsert replaces the connection on a second call", async () => {
      const platformId = newPlatformId()
      await repos.platforms.upsert({
        id: platformId,
        kind: "mcp" as const,
        displayName: "Changing MCP",
        connection: { transport: "http" as const, url: "https://old.example.com/mcp/" },
      })
      await repos.platforms.upsert({
        id: platformId,
        kind: "mcp" as const,
        displayName: "Changing MCP (updated)",
        connection: { transport: "http" as const, url: "https://new.example.com/mcp/" },
      })
      const fetched = await repos.platforms.get(platformId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.displayName).toBe("Changing MCP (updated)")
        if (fetched.value.connection?.transport === "http") {
          expect(fetched.value.connection.url).toBe("https://new.example.com/mcp/")
        }
      }
    })

    it("lists platforms including connection data", async () => {
      await repos.platforms.upsert({
        id: newPlatformId(),
        kind: "mcp" as const,
        displayName: "HTTP Platform",
        connection: { transport: "http" as const, url: "https://a.example.com/mcp/" },
      })
      await repos.platforms.upsert({
        id: newPlatformId(),
        kind: "mcp" as const,
        displayName: "Stdio Platform",
        connection: { transport: "stdio" as const, command: "my-server", args: [] },
      })
      const list = await repos.platforms.list()
      expect(list.isOk()).toBe(true)
      if (list.isOk()) {
        expect(list.value.length).toBe(2)
        const transports = list.value.map((p) => p.connection?.transport).sort()
        expect(transports).toEqual(["http", "stdio"])
      }
    })
  })

  // ---------------------------------------------------------------------------
  // profiles.addSource — transactional append + duplicate-namespace guard (inc 10)
  // ---------------------------------------------------------------------------
  describe("profiles.addSource", () => {
    it("appends a SourceRef to an existing profile", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({
        id: platformId,
        kind: "mcp" as const,
        displayName: "Platform A",
      })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_add_source_test",
      })
      await repos.profiles.create({
        id: profileId,
        name: "add-source-test",
        mcpEndpointPath: "/profiles/add-source-test/mcp",
        sources: [],
      })

      const result = await repos.profiles.addSource(profileId, {
        platformId,
        credentialId: credId,
        toolNamespace: "myservice",
        enabled: true,
      })
      expect(result.isOk()).toBe(true)

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources.length).toBe(1)
        expect(fetched.value.sources[0]?.toolNamespace).toBe("myservice")
      }
    })

    it("appends a SourceRef with toolFilter", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_tool_filter",
      })
      await repos.profiles.create({
        id: profileId,
        name: "filter-test",
        mcpEndpointPath: "/profiles/filter-test/mcp",
        sources: [],
      })

      const result = await repos.profiles.addSource(profileId, {
        platformId,
        credentialId: credId,
        toolNamespace: "filtered",
        enabled: true,
        toolFilter: { allow: ["list_items", "get_item"], deny: ["delete_item"] },
      })
      expect(result.isOk()).toBe(true)

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        const src = fetched.value.sources[0]
        expect(src?.toolFilter?.allow).toEqual(["list_items", "get_item"])
        expect(src?.toolFilter?.deny).toEqual(["delete_item"])
      }
    })

    it("rejects duplicate toolNamespace within the same profile", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_dup_ns",
      })
      await repos.profiles.create({
        id: profileId,
        name: "dup-ns-test",
        mcpEndpointPath: "/profiles/dup-ns-test/mcp",
        sources: [],
      })

      const first = await repos.profiles.addSource(profileId, {
        platformId,
        credentialId: credId,
        toolNamespace: "myns",
        enabled: true,
      })
      expect(first.isOk()).toBe(true)

      const second = await repos.profiles.addSource(profileId, {
        platformId,
        credentialId: credId,
        toolNamespace: "myns", // same namespace — must be rejected
        enabled: true,
      })
      expect(second.isErr()).toBe(true)
      if (second.isErr()) {
        expect(second.error.kind).toBe("duplicate-namespace")
        if (second.error.kind === "duplicate-namespace") {
          expect(second.error.namespace).toBe("myns")
        }
      }
    })

    it("allows the same namespace in DIFFERENT profiles", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_ns_diff_profile",
      })
      const profileIdA = newProfileId()
      const profileIdB = newProfileId()
      await repos.profiles.create({
        id: profileIdA,
        name: "profile-a",
        mcpEndpointPath: "/profiles/profile-a/mcp",
        sources: [],
      })
      await repos.profiles.create({
        id: profileIdB,
        name: "profile-b",
        mcpEndpointPath: "/profiles/profile-b/mcp",
        sources: [],
      })

      const r1 = await repos.profiles.addSource(profileIdA, {
        platformId,
        credentialId: credId,
        toolNamespace: "sharedns",
        enabled: true,
      })
      const r2 = await repos.profiles.addSource(profileIdB, {
        platformId,
        credentialId: credId,
        toolNamespace: "sharedns", // same namespace, different profile — OK
        enabled: true,
      })
      expect(r1.isOk()).toBe(true)
      expect(r2.isOk()).toBe(true)
    })

    it("rejects addSource when the credentialId does not exist (FK → in-use)", async () => {
      const platformId = newPlatformId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.profiles.create({
        id: profileId,
        name: "fk-cred-as",
        mcpEndpointPath: "/profiles/fk-cred-as/mcp",
        sources: [],
      })

      const result = await repos.profiles.addSource(profileId, {
        platformId,
        credentialId: newCredentialId(), // non-existent
        toolNamespace: "myns",
        enabled: true,
      })
      expect(result.isErr()).toBe(true)
      // FK violation on insert: SQLITE_CONSTRAINT_FOREIGNKEY → in-use
      if (result.isErr()) {
        expect(result.error.kind).toBe("in-use")
      }
    })

    it("addSource without credentialId → NULL credential_id in DB, reads back as undefined", async () => {
      const platformId = newPlatformId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.profiles.create({
        id: profileId,
        name: "no-cred-source",
        mcpEndpointPath: "/profiles/no-cred-source/mcp",
        sources: [],
      })

      // addSource with no credentialId (public source)
      const result = await repos.profiles.addSource(profileId, {
        platformId,
        toolNamespace: "public_ns",
        enabled: true,
      })
      expect(result.isOk()).toBe(true)

      // Read back: credentialId must be undefined, not null
      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        const src = fetched.value.sources[0]
        expect(src?.toolNamespace).toBe("public_ns")
        expect(src?.credentialId).toBeUndefined()
      }

      // The raw DB column must be NULL
      const rows = db.all<{ credential_id: string | null }>(
        sql`SELECT credential_id FROM source_refs WHERE profile_id = ${profileId}`,
      )
      expect(rows[0]?.credential_id).toBeNull()
    })

    it("addSource with credentialId → credentialed source remains unchanged", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_credentialed_source",
      })
      await repos.profiles.create({
        id: profileId,
        name: "cred-source",
        mcpEndpointPath: "/profiles/cred-source/mcp",
        sources: [],
      })

      const result = await repos.profiles.addSource(profileId, {
        platformId,
        credentialId: credId,
        toolNamespace: "cred_ns",
        enabled: true,
      })
      expect(result.isOk()).toBe(true)

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources[0]?.credentialId).toBe(credId)
      }
    })

    it("RESTRICT FK: deleting a credential still referenced by a source_ref is blocked", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_restrict_test",
      })
      await repos.profiles.create({
        id: profileId,
        name: "restrict-test",
        mcpEndpointPath: "/profiles/restrict-test/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "ns", enabled: true }],
      })

      // Deleting the referenced credential must fail (RESTRICT FK)
      const del = await repos.credentials.delete(credId)
      expect(del.isErr()).toBe(true)
      if (del.isErr()) expect(del.error.kind).toBe("in-use")
    })

    it("no-credential source does not block credential deletion (NULL is FK-exempt)", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_null_exempt",
      })
      await repos.profiles.create({
        id: profileId,
        name: "null-exempt-test",
        mcpEndpointPath: "/profiles/null-exempt-test/mcp",
        sources: [],
      })

      // Add a no-credential source (NULL FK)
      await repos.profiles.addSource(profileId, {
        platformId,
        toolNamespace: "public_ns",
        enabled: true,
      })

      // Deleting the unrelated credential must succeed (NULL FK is exempt)
      const del = await repos.credentials.delete(credId)
      expect(del.isOk()).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // profiles.removeSource + profiles.setSourceEnabled (inc 13)
  // ---------------------------------------------------------------------------
  describe("profiles.removeSource", () => {
    async function seedProfileWithSources() {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_rs_test",
      })
      await repos.profiles.create({
        id: profileId,
        name: "rs-test",
        mcpEndpointPath: "/profiles/rs-test/mcp",
        sources: [
          { platformId, credentialId: credId, toolNamespace: "ns1", enabled: true },
          { platformId, credentialId: credId, toolNamespace: "ns2", enabled: true },
        ],
      })
      return { profileId, platformId, credId }
    }

    it("removes one source and leaves the other", async () => {
      const { profileId } = await seedProfileWithSources()
      const result = await repos.profiles.removeSource(profileId, "ns1")
      expect(result.isOk()).toBe(true)

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources.length).toBe(1)
        expect(fetched.value.sources[0]?.toolNamespace).toBe("ns2")
      }
    })

    it("returns not-found for a namespace that does not exist in the profile", async () => {
      const { profileId } = await seedProfileWithSources()
      const result = await repos.profiles.removeSource(profileId, "nonexistent")
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("not-found")
        if (result.error.kind === "not-found") {
          expect(result.error.entity).toBe("source")
          expect(result.error.id).toBe("nonexistent")
        }
      }
    })

    it("removing a source does not affect other profiles", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_rs_cross",
      })
      const profileA = newProfileId()
      const profileB = newProfileId()
      await repos.profiles.create({
        id: profileA,
        name: "rs-a",
        mcpEndpointPath: "/profiles/rs-a/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "ns", enabled: true }],
      })
      await repos.profiles.create({
        id: profileB,
        name: "rs-b",
        mcpEndpointPath: "/profiles/rs-b/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "ns", enabled: true }],
      })

      await repos.profiles.removeSource(profileA, "ns")
      const fetchedB = await repos.profiles.get(profileB)
      expect(fetchedB.isOk()).toBe(true)
      if (fetchedB.isOk()) {
        // Profile B's source must be untouched
        expect(fetchedB.value.sources.length).toBe(1)
        expect(fetchedB.value.sources[0]?.toolNamespace).toBe("ns")
      }
    })
  })

  describe("profiles.setSourceEnabled", () => {
    it("toggles enabled to false and reflects in get()", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_sse_test",
      })
      await repos.profiles.create({
        id: profileId,
        name: "sse-test",
        mcpEndpointPath: "/profiles/sse-test/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "myns", enabled: true }],
      })

      const disableResult = await repos.profiles.setSourceEnabled(profileId, "myns", false)
      expect(disableResult.isOk()).toBe(true)

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources[0]?.enabled).toBe(false)
      }
    })

    it("re-enables a disabled source", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_sse_re",
      })
      await repos.profiles.create({
        id: profileId,
        name: "sse-re",
        mcpEndpointPath: "/profiles/sse-re/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "myns", enabled: false }],
      })

      const enableResult = await repos.profiles.setSourceEnabled(profileId, "myns", true)
      expect(enableResult.isOk()).toBe(true)

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources[0]?.enabled).toBe(true)
      }
    })

    it("returns not-found for a namespace that does not exist", async () => {
      const profileId = newProfileId()
      await repos.profiles.create({
        id: profileId,
        name: "sse-nf",
        mcpEndpointPath: "/profiles/sse-nf/mcp",
        sources: [],
      })

      const result = await repos.profiles.setSourceEnabled(profileId, "ghost", false)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("not-found")
      }
    })

    it("idempotent re-disable: disabling an already-disabled source returns ok", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_idempotent_disable",
      })
      await repos.profiles.create({
        id: profileId,
        name: "idem-disable",
        mcpEndpointPath: "/profiles/idem-disable/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "myns", enabled: false }],
      })

      // Disable an already-disabled source — must succeed, not error
      const first = await repos.profiles.setSourceEnabled(profileId, "myns", false)
      expect(first.isOk()).toBe(true)

      // Value remains false
      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources[0]?.enabled).toBe(false)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // addCredential helper — secrets-as-references (inc 10)
  // ---------------------------------------------------------------------------
  describe("addCredential — secrets-as-references (security.md)", () => {
    /** Build a simple in-memory mock CredentialStore for unit testing. */
    function buildMockStore(): CredentialStore & { _store: Map<string, string> } {
      const _store = new Map<string, string>()
      return {
        backend: "encrypted-file" as const,
        _store,
        set: (ref, secret) => {
          _store.set(ref, secret)
          return okAsync(undefined)
        },
        get: (ref) => okAsync(_store.get(ref) ?? null),
        delete: (ref) => {
          _store.delete(ref)
          return okAsync(undefined)
        },
      }
    }

    it("stores the secret in the CredentialStore and only a secretRef in the DB", async () => {
      const platformId = newPlatformId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      const store = buildMockStore()
      const SENTINEL = "SENTINEL_TOKEN_abc123"

      const result = await addCredential(
        { platformId: String(platformId), account: "work", kind: "bearer", secret: SENTINEL },
        store,
        repos.credentials,
      )
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return

      const cred = result.value

      // 1. The secret IS resolvable via the CredentialStore
      const fetched = await store.get(cred.secretRef)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value).toBe(SENTINEL)
      }

      // 2. The DB row holds ONLY the opaque secretRef — never the plaintext
      const rows = db.all<Record<string, unknown>>(sql`SELECT * FROM credentials`)
      expect(rows.length).toBe(1)
      const row = rows[0]
      // secretRef is the handle stored in the DB
      expect(typeof row?.secret_ref).toBe("string")
      expect(row?.secret_ref).toBe(cred.secretRef)
      // CRITICAL TOKEN TEST (a): whole-DB scan — no column must contain the sentinel
      const serialized = JSON.stringify(rows)
      expect(serialized).not.toContain(SENTINEL)
    })

    it("CRITICAL: whole-DB scan finds no plaintext token in any table", async () => {
      const platformId = newPlatformId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      const store = buildMockStore()
      const TOKEN = "TOP_SECRET_TOKEN_xyz789"

      await addCredential(
        { platformId: String(platformId), account: "personal", kind: "bearer", secret: TOKEN },
        store,
        repos.credentials,
      )

      // Scan every table in the DB for the sentinel
      const tables = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table'`,
      )
      for (const { name } of tables) {
        const tableRows = db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${name}"`))
        const dump = JSON.stringify(tableRows)
        expect(dump, `Token found in table "${name}"`).not.toContain(TOKEN)
      }
    })

    it("credential list never exposes the secretRef — only metadata", async () => {
      const platformId = newPlatformId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      const store = buildMockStore()
      const result = await addCredential(
        { platformId: String(platformId), account: "work", kind: "bearer", secret: "s3cr3t" },
        store,
        repos.credentials,
      )
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return

      // forPlatform returns full Credential objects (including secretRef as a ref)
      // but the list command MUST strip secretRef from output — tested at CLI level.
      // Here we verify the Credential entity does NOT have a plain "secret" field.
      const cred = result.value
      expect(Object.keys(cred)).not.toContain("secret")
      // secretRef is present (it's the opaque handle) — but it's just a ULID, not the secret
      expect(cred.secretRef).toBeTruthy()
      expect(cred.secretRef).not.toBe("s3cr3t")
    })

    it("best-effort store.delete on DB-create failure (orphan cleanup)", async () => {
      const platformId = newPlatformId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      // Simpler: build a store that succeeds on set but fails on the DB insert
      const failingDbRepo = {
        ...repos.credentials,
        create: () =>
          errAsync({ kind: "constraint-violation" as const, cause: new Error("forced") }),
      }
      const _orphanStore = new Map<string, string>()
      let deleteCount = 0
      const trackingStore: CredentialStore = {
        backend: "encrypted-file" as const,
        set: (ref, secret) => {
          _orphanStore.set(ref, secret)
          return okAsync(undefined)
        },
        get: (ref) => okAsync(_orphanStore.get(ref) ?? null),
        delete: (ref) => {
          deleteCount++
          _orphanStore.delete(ref)
          return okAsync(undefined)
        },
      }

      const result = await addCredential(
        { platformId: String(platformId), account: "work2", kind: "bearer", secret: "orphan" },
        trackingStore,
        failingDbRepo,
      )
      expect(result.isErr()).toBe(true)
      // Best-effort cleanup must have been called
      expect(deleteCount).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // removeCredential helper — delete row + secret; RESTRICT guard (inc 13)
  // ---------------------------------------------------------------------------
  describe("removeCredential — secret cleanup + RESTRICT guard (security.md)", () => {
    function buildMockStore(): CredentialStore & { _store: Map<string, string> } {
      const _store = new Map<string, string>()
      return {
        backend: "encrypted-file" as const,
        _store,
        set: (ref, secret) => {
          _store.set(ref, secret)
          return okAsync(undefined)
        },
        get: (ref) => okAsync(_store.get(ref) ?? null),
        delete: (ref) => {
          _store.delete(ref)
          return okAsync(undefined)
        },
      }
    }

    it("removes the DB row and deletes the secret from the store", async () => {
      const { removeCredential } = await import("../credentials/remove-credential.js")
      const platformId = newPlatformId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      const store = buildMockStore()
      const SENTINEL = "REMOVE_SENTINEL_secret_xyz"
      // Pre-populate store with the secret
      const secretRef = "ref_remove_test"
      await store.set(secretRef, SENTINEL)

      const credId = newCredentialId()
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef,
      })

      const result = await removeCredential(String(credId), store, repos.credentials)
      expect(result.isOk()).toBe(true)

      // DB row must be gone
      const fetched = await repos.credentials.get(String(credId))
      expect(fetched.isErr()).toBe(true)
      if (fetched.isErr()) expect(fetched.error.kind).toBe("not-found")

      // Secret must be gone from the store
      const secretAfter = await store.get(secretRef)
      expect(secretAfter.isOk()).toBe(true)
      if (secretAfter.isOk()) expect(secretAfter.value).toBeNull()
    })

    it("RESTRICT (in-use): credential referenced by source_ref → in-use error + secret NOT deleted", async () => {
      const { removeCredential } = await import("../credentials/remove-credential.js")
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      const store = buildMockStore()
      const secretRef = "ref_inuse_secret"
      const SECRET = "INUSE_SECRET_must_not_be_deleted"
      await store.set(secretRef, SECRET)

      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef,
      })
      await repos.profiles.create({
        id: profileId,
        name: "inuse-test",
        mcpEndpointPath: "/profiles/inuse-test/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "ns", enabled: true }],
      })

      const result = await removeCredential(String(credId), store, repos.credentials)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        // Must be in-use (RESTRICT FK blocked the DB delete)
        expect(result.error.kind).toBe("in-use")
      }

      // CRITICAL SECURITY: secret must still exist in the store (credential not deleted)
      const secretAfter = await store.get(secretRef)
      expect(secretAfter.isOk()).toBe(true)
      if (secretAfter.isOk()) {
        expect(secretAfter.value).toBe(SECRET)
      }

      // DB row must also still exist
      const credAfter = await repos.credentials.get(String(credId))
      expect(credAfter.isOk()).toBe(true)
    })

    it("not-found: attempting to remove a non-existent credential returns not-found", async () => {
      const { removeCredential } = await import("../credentials/remove-credential.js")
      const store = buildMockStore()
      const result = await removeCredential("cred_nonexistent_id", store, repos.credentials)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) expect(result.error.kind).toBe("not-found")
    })

    it("reverse-orphan: store.delete failure after successful DB delete → result is still Ok", async () => {
      // removeCredential swallows a store.delete failure after the DB row is gone (best-effort).
      // This verifies that a stranded store entry doesn't surface as an error to the caller.
      const { removeCredential } = await import("../credentials/remove-credential.js")
      const platformId = newPlatformId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      const secretRef = "ref_reverse_orphan"
      const credId = newCredentialId()
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef,
      })

      // Store whose delete always returns an io-failed error
      let deleteCalled = false
      const failingStore: CredentialStore = {
        backend: "encrypted-file" as const,
        set: (_ref, _secret) => okAsync(undefined),
        get: (_ref) => okAsync(null),
        delete: (_ref) => {
          deleteCalled = true
          return errAsync({
            kind: "io-failed" as const,
            cause: new Error("simulated store failure"),
          })
        },
      }

      const result = await removeCredential(String(credId), failingStore, repos.credentials)

      // Must resolve Ok — store.delete failure is best-effort, not propagated
      expect(result.isOk()).toBe(true)
      // store.delete must have been attempted
      expect(deleteCalled).toBe(true)
      // DB row must be gone
      const fetched = await repos.credentials.get(String(credId))
      expect(fetched.isErr()).toBe(true)
      if (fetched.isErr()) expect(fetched.error.kind).toBe("not-found")
    })

    it("after remove-source the credential can be deleted and the secret is gone", async () => {
      const { removeCredential } = await import("../credentials/remove-credential.js")
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })

      const store = buildMockStore()
      const secretRef = "ref_lifecycle_secret"
      const SECRET = "LIFECYCLE_SECRET_must_survive_remove_source"
      await store.set(secretRef, SECRET)

      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef,
      })
      await repos.profiles.create({
        id: profileId,
        name: "lifecycle-test",
        mcpEndpointPath: "/profiles/lifecycle-test/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "ns", enabled: true }],
      })

      // Remove the source first
      const removeSourceResult = await repos.profiles.removeSource(profileId, "ns")
      expect(removeSourceResult.isOk()).toBe(true)

      // Now credential remove must succeed
      const result = await removeCredential(String(credId), store, repos.credentials)
      expect(result.isOk()).toBe(true)

      // Secret must be gone
      const secretAfter = await store.get(secretRef)
      expect(secretAfter.isOk()).toBe(true)
      if (secretAfter.isOk()) expect(secretAfter.value).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // profiles.create() — duplicate namespace guard (SHOULD-FIX 3)
  // ---------------------------------------------------------------------------
  describe("profiles.create() — duplicate toolNamespace guard", () => {
    it("rejects two sources with the same namespace in the initial create()", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_dup_create",
      })

      const result = await repos.profiles.create({
        id: newProfileId(),
        name: "dup-ns-create",
        mcpEndpointPath: "/profiles/dup-ns-create/mcp",
        sources: [
          { platformId, credentialId: credId, toolNamespace: "myns", enabled: true },
          { platformId, credentialId: credId, toolNamespace: "myns", enabled: true },
        ],
      })
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("duplicate-namespace")
        if (result.error.kind === "duplicate-namespace") {
          expect(result.error.namespace).toBe("myns")
        }
      }
    })

    it("the DB unique index on (profile_id, tool_namespace) exists after migration 0002", () => {
      const indexes = db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='source_refs'`,
      )
      const indexNames = indexes.map((i) => i.name)
      expect(indexNames).toContain("source_refs_profile_ns_unique")
    })
  })

  // ---------------------------------------------------------------------------
  // Migration 0001 — additive columns survive existing data (inc 10)
  // ---------------------------------------------------------------------------
  describe("migration 0001 — existing rows survive additive columns", () => {
    it("platform rows created before 0001 columns are still retrievable", async () => {
      // Platforms created without `connection` have NULL in the new column —
      // they must still be retrievable without errors (additive migration).
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "mcp" as const, displayName: "Legacy" })

      const fetched = await repos.platforms.get(platformId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.connection).toBeUndefined()
        expect(fetched.value.displayName).toBe("Legacy")
      }
    })

    it("source_refs without tool_filter round-trip with toolFilter=undefined", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_legacy_sr",
      })
      await repos.profiles.create({
        id: profileId,
        name: "legacy-sr",
        mcpEndpointPath: "/profiles/legacy-sr/mcp",
        sources: [{ platformId, credentialId: credId, toolNamespace: "ns", enabled: true }],
      })

      const fetched = await repos.profiles.get(profileId)
      expect(fetched.isOk()).toBe(true)
      if (fetched.isOk()) {
        expect(fetched.value.sources[0]?.toolFilter).toBeUndefined()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Malformed JSON columns → typed boundary error (FIX 4)
  // ---------------------------------------------------------------------------
  describe("malformed JSON columns return typed query-failed error (boundary-validation contract)", () => {
    it("corrupt platforms.connection → platforms.get returns isErr with query-failed", async () => {
      const platformId = newPlatformId()
      // Insert a row with a malformed JSON connection value directly — bypasses
      // the repo layer so we can simulate disk/import corruption.
      db.run(
        sql`INSERT INTO platforms (id, kind, display_name, connection)
            VALUES (${String(platformId)}, 'mcp', 'Corrupt Platform', 'NOT_VALID_JSON')`,
      )

      const result = await repos.platforms.get(platformId)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("query-failed")
      }
    })

    it("wrong-shape JSON in platforms.connection → platforms.get returns isErr with query-failed", async () => {
      const platformId = newPlatformId()
      // Valid JSON but fails McpConnectionSchema (missing required `transport`)
      db.run(
        sql`INSERT INTO platforms (id, kind, display_name, connection)
            VALUES (${String(platformId)}, 'mcp', 'Bad Shape Platform', '{"not":"a_connection"}')`,
      )

      const result = await repos.platforms.get(platformId)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("query-failed")
      }
    })

    it("corrupt source_refs.tool_filter → profiles.get returns isErr with query-failed", async () => {
      const platformId = newPlatformId()
      const credId = newCredentialId()
      const profileId = newProfileId()
      await repos.platforms.upsert({ id: platformId, kind: "mcp" as const, displayName: "P" })
      await repos.credentials.create({
        id: credId,
        platformId,
        profileName: "work",
        kind: "bearer" as const,
        secretRef: "ref_corrupt_filter",
      })
      // Insert source_ref row with corrupt tool_filter directly
      db.run(
        sql`INSERT INTO profiles (id, name, mcp_endpoint_path)
            VALUES (${String(profileId)}, 'corrupt-filter', '/profiles/corrupt-filter/mcp')`,
      )
      db.run(
        sql`INSERT INTO source_refs (id, profile_id, platform_id, credential_id, tool_namespace, enabled, tool_filter)
            VALUES ('sr_corrupt_1', ${String(profileId)}, ${String(platformId)}, ${String(credId)}, 'ns', 1, 'BROKEN_JSON')`,
      )

      const result = await repos.profiles.get(profileId)
      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error.kind).toBe("query-failed")
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Migration 0004 — GENUINE cross-version data preservation (inc 16)
//
// The tests inside the `repositories` describe above run on a DB that was
// migrated straight to HEAD (0000→0004) by getDatabase, so they can only seed
// rows into the *post*-0004 schema — they prove the post-rebuild schema
// round-trips, NOT that the table-rebuild preserves *pre-existing* data.
//
// This block closes that gap: it applies 0000→0003 (the schema BEFORE the
// rebuild), seeds a credentialed source the old way, THEN applies 0004's
// drop-and-recreate, and asserts the row survived with its credential intact.
// ---------------------------------------------------------------------------
describe("migration 0004 — cross-version data preservation", () => {
  const migrationsDir = fileURLToPath(new URL("../db/migrations/", import.meta.url))

  /** Apply one migration .sql file statement-by-statement (split on drizzle's breakpoint). */
  async function applyMigration(rawDb: Database.Database, tag: string): Promise<void> {
    const sqlText = await readFile(join(migrationsDir, `${tag}.sql`), "utf8")
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim()
      if (trimmed.length > 0) rawDb.exec(trimmed)
    }
  }

  it("preserves a pre-existing credentialed source row through the 0004 rebuild", async () => {
    const rawDb = new Database(":memory:")
    try {
      rawDb.pragma("foreign_keys = ON")

      // ── Build the PRE-rebuild schema exactly as a real 0003 DB would look ──
      for (const tag of [
        "0000_odd_amazoness",
        "0001_illegal_kingpin",
        "0002_natural_lady_bullseye",
        "0003_add_openapi_column",
      ]) {
        await applyMigration(rawDb, tag)
      }

      // credential_id is NOT NULL at 0003 — seed a real credentialed source.
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('plat_legacy', 'mcp', 'Legacy');
        INSERT INTO credentials (id, platform_id, profile_name, kind, secret_ref)
          VALUES ('cred_legacy', 'plat_legacy', 'work', 'bearer', 'ref_legacy');
        INSERT INTO profiles (id, name, mcp_endpoint_path)
          VALUES ('prof_legacy', 'legacy', '/profiles/legacy/mcp');
        INSERT INTO source_refs (id, profile_id, platform_id, credential_id, tool_namespace, enabled)
          VALUES ('sr_legacy', 'prof_legacy', 'plat_legacy', 'cred_legacy', 'legacy_ns', 1);
      `)

      // ── The rebuild under test ──
      await applyMigration(rawDb, "0004_neat_spirit")

      // 1. The pre-existing row survived the drop-and-recreate with data intact.
      const row = rawDb
        .prepare("SELECT credential_id, tool_namespace, enabled FROM source_refs WHERE id = ?")
        .get("sr_legacy") as
        | { credential_id: string | null; tool_namespace: string; enabled: number }
        | undefined
      expect(row).toBeDefined()
      expect(row?.credential_id).toBe("cred_legacy")
      expect(row?.tool_namespace).toBe("legacy_ns")
      expect(row?.enabled).toBe(1)

      // 2. The column is now genuinely nullable — a no-credential source inserts.
      rawDb.exec(
        `INSERT INTO source_refs (id, profile_id, platform_id, credential_id, tool_namespace, enabled)
           VALUES ('sr_public', 'prof_legacy', 'plat_legacy', NULL, 'public_ns', 1)`,
      )
      const publicRow = rawDb
        .prepare("SELECT credential_id FROM source_refs WHERE id = ?")
        .get("sr_public") as { credential_id: string | null } | undefined
      expect(publicRow?.credential_id).toBeNull()

      // 3. RESTRICT FK survived the rebuild: deleting an in-use credential is blocked.
      expect(() => rawDb.exec("DELETE FROM credentials WHERE id = 'cred_legacy'")).toThrow()

      // 4. The unique index survived the rebuild.
      const indexes = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='source_refs'")
        .all() as Array<{ name: string }>
      expect(indexes.map((i) => i.name)).toContain("source_refs_profile_ns_unique")
    } finally {
      rawDb.close()
    }
  })
})
