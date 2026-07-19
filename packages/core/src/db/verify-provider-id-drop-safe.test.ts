// SPDX-License-Identifier: AGPL-3.0-only
// verifyProviderIdDropSafe tests (increment 45, Slice E / Fable E4) — the
// fail-closed pre-migration guard for dropping `oauth_meta.providerId`.
// Adversarial per the method file: verify-passes → drop-safe; a stranding
// credential → refuse (no drop, no partial write); malformed oauth_meta
// (json_valid-guarded, does not brick); recovery snapshot written before any
// destructive change; idempotent re-run; empty DB.
//
// Mirrors repositories.test.ts's "migration 0012" staged-migration pattern:
// build a raw better-sqlite3 DB up through 0012 (the schema BEFORE this
// guard/0013 exist), seed rows by hand, then exercise the guard directly
// against the raw connection — exactly what getDatabase does before handing
// off to drizzle's migrate().

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { ulid } from "ulid"
import { describe, expect, it } from "vitest"
import { MIGRATION_0013_WHEN, verifyProviderIdDropSafe } from "./verify-provider-id-drop-safe.js"

const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url))

async function applyMigration(rawDb: Database.Database, tag: string): Promise<void> {
  const sqlText = await readFile(`${migrationsDir}${tag}.sql`, "utf8")
  for (const stmt of sqlText.split("--> statement-breakpoint")) {
    const trimmed = stmt.trim()
    if (trimmed.length > 0) rawDb.exec(trimmed)
  }
}

const PRE_0013_TAGS = [
  "0000_odd_amazoness",
  "0001_illegal_kingpin",
  "0002_natural_lady_bullseye",
  "0003_add_openapi_column",
  "0004_neat_spirit",
  "0005_confused_swordsman",
  "0006_violet_kinsey_walden",
  "0007_burly_elektra",
  "0008_sticky_marvel_boy",
  "0009_dear_yellowjacket",
  "0010_gifted_namor",
  "0011_credential_standalone_identity",
  "0012_platform_oauth_provider_id",
]

async function freshPre0013Db(): Promise<Database.Database> {
  const rawDb = new Database(":memory:")
  rawDb.pragma("foreign_keys = ON")
  for (const tag of PRE_0013_TAGS) await applyMigration(rawDb, tag)
  return rawDb
}

function readPlatformProviderId(rawDb: Database.Database, id: string): string | null {
  const row = rawDb.prepare("SELECT oauth_provider_id FROM platforms WHERE id = ?").get(id) as
    | { oauth_provider_id: string | null }
    | undefined
  return row?.oauth_provider_id ?? null
}

function readCredentialOauthMeta(rawDb: Database.Database, id: string): string | null {
  const row = rawDb.prepare("SELECT oauth_meta FROM credentials WHERE id = ?").get(id) as
    | { oauth_meta: string | null }
    | undefined
  return row?.oauth_meta ?? null
}

function recoveryRows(
  rawDb: Database.Database,
): Array<{ credential_id: string; legacy_provider_id: string }> {
  const exists = rawDb
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_providerid_drop_backup'`,
    )
    .get()
  if (exists === undefined) return []
  return rawDb
    .prepare("SELECT credential_id, legacy_provider_id FROM _providerid_drop_backup")
    .all() as Array<{ credential_id: string; legacy_provider_id: string }>
}

describe("MIGRATION_0013_WHEN journal sync (data-migration review, inc 45)", () => {
  // The guard's already-applied check compares __drizzle_migrations.created_at
  // against this constant. If it drifts from meta/_journal.json's 0013 `when`
  // (e.g. a 0013 regen after a rebase), the guard could re-run on an
  // already-dropped DB. The constant's own doc-comment claims THIS test pins
  // them — so it must actually exist (the review found it was missing).
  it("MIGRATION_0013_WHEN is byte-identical to _journal.json's 0013 entry `when`", async () => {
    const journalRaw = await readFile(`${migrationsDir}meta/_journal.json`, "utf8")
    const journal = JSON.parse(journalRaw) as {
      entries: { tag: string; when: number }[]
    }
    const entry = journal.entries.find((e) => e.tag === "0013_drop_oauth_meta_provider_id")
    expect(entry).toBeDefined()
    expect(MIGRATION_0013_WHEN).toBe(entry?.when)
  })
})

describe("verifyProviderIdDropSafe", () => {
  it("empty DB → ok, no-op (nothing to backfill/verify/snapshot)", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isOk()).toBe(true)
      expect(recoveryRows(rawDb)).toEqual([])
    } finally {
      rawDb.close()
    }
  })

  it("a credential whose platform ALREADY has oauth_provider_id set → verify passes, recovery snapshot written", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_100_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name, oauth_provider_id) VALUES ('gh', 'mcp', 'GitHub', 'github');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'gh-work', 'gh', 'work', 'oauth2', 'ref_a', '{"providerId":"github","scopes":["repo"]}');
      `)

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isOk()).toBe(true)

      const snapshot = recoveryRows(rawDb)
      expect(snapshot).toEqual([{ credential_id: credId, legacy_provider_id: "github" }])
    } finally {
      rawDb.close()
    }
  })

  it("BACKFILL: a platform with NO oauth_provider_id but ONE agreeing bound credential → backfilled, then verify passes", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_101_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('gh', 'mcp', 'GitHub');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'gh-work', 'gh', 'work', 'oauth2', 'ref_a', '{"providerId":"github"}');
      `)

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isOk()).toBe(true)
      expect(readPlatformProviderId(rawDb, "gh")).toBe("github")
      expect(recoveryRows(rawDb)).toEqual([{ credential_id: credId, legacy_provider_id: "github" }])
    } finally {
      rawDb.close()
    }
  })

  it("REFUSE: a credential whose platform has NO providerId and CANNOT be backfilled (no platform row) → migration-refused, no snapshot, DB unchanged", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const orphanId = ulid(1_700_000_102_000)
      // Orphan OAuth credential — no platform row referenced at all.
      rawDb.exec(`
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${orphanId}', 'orphan', NULL, 'orphan', 'oauth2', 'ref_orphan', '{"providerId":"github"}');
      `)

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isErr()).toBe(true)
      if (result.isOk()) return
      expect(result.error).toEqual({
        kind: "migration-refused",
        migration: "0013_drop_oauth_meta_provider_id",
        strandedCredentialIds: [orphanId],
        remediation: expect.stringContaining("oauthProviderId"),
      })

      // DB left unchanged — no recovery table row, oauth_meta untouched.
      expect(recoveryRows(rawDb)).toEqual([])
      expect(readCredentialOauthMeta(rawDb, orphanId)).toBe('{"providerId":"github"}')
    } finally {
      rawDb.close()
    }
  })

  it("REFUSE: a platform with a CONFLICTING providerId among its bound credentials cannot be backfilled → refuses, lists BOTH stranded credential ids", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credA = ulid(1_700_000_103_000)
      const credB = ulid(1_700_000_104_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('shared', 'mcp', 'Shared Platform');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credA}', 'shared-a', 'shared', 'a', 'oauth2', 'ref_a', '{"providerId":"github"}');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credB}', 'shared-b', 'shared', 'b', 'oauth2', 'ref_b', '{"providerId":"google"}');
      `)

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isErr()).toBe(true)
      if (result.isOk()) return
      expect(result.error.kind).toBe("migration-refused")
      if (result.error.kind !== "migration-refused") return
      expect(result.error.strandedCredentialIds.sort()).toEqual([credA, credB].sort())

      // Backfill was rolled back — the platform's providerId is still unset.
      expect(readPlatformProviderId(rawDb, "shared")).toBeNull()
      expect(recoveryRows(rawDb)).toEqual([])
    } finally {
      rawDb.close()
    }
  })

  it("a custom:<slug>-referencing platform's providerId counts as a valid backfill source too (SQL check is provider-id-agnostic)", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_105_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('acme', 'http', 'Acme');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'acme-work', 'acme', 'work', 'oauth2', 'ref_a', '{"providerId":"custom:acme-oauth"}');
      `)

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isOk()).toBe(true)
      expect(readPlatformProviderId(rawDb, "acme")).toBe("custom:acme-oauth")
    } finally {
      rawDb.close()
    }
  })

  it("MALFORMED oauth_meta does not throw/brick the guard — skipped (json_valid-guarded, inc-44 lesson)", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_106_000)
      const ins = rawDb.prepare(
        "INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta) VALUES (?,?,?,?,?,?,?)",
      )
      rawDb.exec(
        `INSERT INTO platforms (id, kind, display_name) VALUES ('malformed', 'mcp', 'Malformed Only');`,
      )
      ins.run(credId, "m-trunc", "malformed", "a", "oauth2", "ref_t", '{"providerId":"github"')

      expect(() => verifyProviderIdDropSafe(rawDb)).not.toThrow()
      const result = verifyProviderIdDropSafe(rawDb)
      // A malformed oauth_meta row is excluded by the json_valid guard from
      // BOTH the backfill source and the verify scan — it never had a
      // parseable legacy providerId to strand on, so it's simply invisible
      // to this guard (nothing this migration could safely do with it).
      expect(result.isOk()).toBe(true)
      expect(readPlatformProviderId(rawDb, "malformed")).toBeNull()
    } finally {
      rawDb.close()
    }
  })

  it("a non-oauth2 credential with malformed oauth_meta is irrelevant (excluded by kind, never scanned)", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_107_000)
      const ins = rawDb.prepare(
        "INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta) VALUES (?,?,?,?,?,?,?)",
      )
      rawDb.exec(
        `INSERT INTO platforms (id, kind, display_name) VALUES ('bearer-plat', 'http', 'Bearer Platform');`,
      )
      ins.run(credId, "bearer-cred", "bearer-plat", "a", "bearer", "ref_b", "not json at all")

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isOk()).toBe(true)
    } finally {
      rawDb.close()
    }
  })

  it("IDEMPOTENT: re-running the guard twice before migrate() applies is a no-op the second time (already-applied short-circuit doesn't fire — 0013 isn't applied yet — but backfill/verify/snapshot re-run cleanly)", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_108_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('gh', 'mcp', 'GitHub');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'gh-work', 'gh', 'work', 'oauth2', 'ref_a', '{"providerId":"github"}');
      `)

      const first = verifyProviderIdDropSafe(rawDb)
      expect(first.isOk()).toBe(true)
      const second = verifyProviderIdDropSafe(rawDb)
      expect(second.isOk()).toBe(true)

      // Still exactly one recovery row (INSERT OR REPLACE keyed by credential_id).
      expect(recoveryRows(rawDb)).toEqual([{ credential_id: credId, legacy_provider_id: "github" }])
    } finally {
      rawDb.close()
    }
  })

  it("IDEMPOTENT: once __drizzle_migrations records 0013 as applied, the guard short-circuits to ok(undefined) without touching anything", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_109_000)
      // A credential that WOULD strand if the guard actually ran its backfill/verify.
      rawDb.exec(`
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'orphan', NULL, 'orphan', 'oauth2', 'ref_orphan', '{"providerId":"github"}');
      `)

      // Simulate 0013 already applied — same table/mechanism drizzle itself uses.
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
        INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('fake-hash', ${MIGRATION_0013_WHEN});
      `)

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isOk()).toBe(true)
      // No snapshot written — the guard short-circuited before doing any work.
      expect(recoveryRows(rawDb)).toEqual([])
    } finally {
      rawDb.close()
    }
  })

  it("a credential with NO legacy providerId at all is never scanned/stranded — nothing to verify for it", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_110_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('bare', 'mcp', 'Bare');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'bare-work', 'bare', 'work', 'oauth2', 'ref_a', '{"scopes":["repo"]}');
      `)

      const result = verifyProviderIdDropSafe(rawDb)
      expect(result.isOk()).toBe(true)
      expect(recoveryRows(rawDb)).toEqual([])
    } finally {
      rawDb.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Migration 0013's SQL (the drop itself) — exercised directly, AFTER the
// guard has already run, mirroring exactly what getDatabase does in sequence.
// ---------------------------------------------------------------------------
describe("migration 0013 — drop oauth_meta.providerId (after the guard has verified safety)", () => {
  it("removes ONLY the providerId key; other oauthMeta fields survive untouched", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_200_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name, oauth_provider_id) VALUES ('gh', 'mcp', 'GitHub', 'github');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'gh-work', 'gh', 'work', 'oauth2', 'ref_a',
            '{"providerId":"github","scopes":["repo"],"needsReauth":false,"expiresAt":null,"authMode":"authorization_code"}');
      `)

      const guardResult = verifyProviderIdDropSafe(rawDb)
      expect(guardResult.isOk()).toBe(true)

      await applyMigration(rawDb, "0013_drop_oauth_meta_provider_id")

      const meta = JSON.parse(readCredentialOauthMeta(rawDb, credId) ?? "{}")
      expect(meta).toEqual({
        scopes: ["repo"],
        needsReauth: false,
        expiresAt: null,
        authMode: "authorization_code",
      })
      expect(meta.providerId).toBeUndefined()
    } finally {
      rawDb.close()
    }
  })

  it("MALFORMED oauth_meta is skipped by the drop's json_valid guard — does not throw", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_201_000)
      const ins = rawDb.prepare(
        "INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta) VALUES (?,?,?,?,?,?,?)",
      )
      ins.run(credId, "malformed-cred", null, "a", "oauth2", "ref_m", "not json at all")

      await expect(
        applyMigration(rawDb, "0013_drop_oauth_meta_provider_id"),
      ).resolves.toBeUndefined()
      expect(readCredentialOauthMeta(rawDb, credId)).toBe("not json at all")
    } finally {
      rawDb.close()
    }
  })

  it("IDEMPOTENT: re-running the drop statement on an already-dropped row is a no-op", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_202_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name, oauth_provider_id) VALUES ('gh', 'mcp', 'GitHub', 'github');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('${credId}', 'gh-work', 'gh', 'work', 'oauth2', 'ref_a', '{"providerId":"github","scopes":["repo"]}');
      `)

      await applyMigration(rawDb, "0013_drop_oauth_meta_provider_id")
      const once = readCredentialOauthMeta(rawDb, credId)
      await applyMigration(rawDb, "0013_drop_oauth_meta_provider_id")
      const twice = readCredentialOauthMeta(rawDb, credId)
      expect(twice).toBe(once)
      expect(JSON.parse(twice ?? "{}")).toEqual({ scopes: ["repo"] })
    } finally {
      rawDb.close()
    }
  })

  it("NULL oauth_meta rows (non-oauth2 credentials) are left untouched", async () => {
    const rawDb = await freshPre0013Db()
    try {
      const credId = ulid(1_700_000_203_000)
      rawDb.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('bearer-plat', 'http', 'Bearer Platform');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref)
          VALUES ('${credId}', 'bearer-cred', 'bearer-plat', 'a', 'bearer', 'ref_b');
      `)

      await expect(
        applyMigration(rawDb, "0013_drop_oauth_meta_provider_id"),
      ).resolves.toBeUndefined()
      expect(readCredentialOauthMeta(rawDb, credId)).toBeNull()
    } finally {
      rawDb.close()
    }
  })
})
