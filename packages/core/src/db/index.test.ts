// SPDX-License-Identifier: AGPL-3.0-only
// getDatabase end-to-end boot tests (increment 45, Slice E) — proves the
// fail-closed verify-then-drop guard is actually wired into the real boot
// path, not just unit-tested in isolation. verify-provider-id-drop-safe.test.ts
// covers the guard's SQL logic against a raw connection; this file drives the
// same scenarios through the PUBLIC `getDatabase` entry point every real
// caller (CLI/web/mcp serve) uses.

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { getPaths } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import { getDatabase } from "./index.js"

describe("getDatabase — migration 0013 fail-closed guard, end to end", () => {
  it("a fresh empty home boots cleanly through 0000..0013 (no stranding data, nothing to refuse)", async () => {
    await withTempHome(async () => {
      const result = await getDatabase(getPaths())
      expect(result.isOk()).toBe(true)
    })
  })

  it("a pre-45 DB with a cleanly-backfillable OAuth credential boots and the provider_id key is dropped", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      // First boot: applies 0000..0012 only is not directly expressible via
      // the public API (getDatabase always migrates to HEAD) — so this seeds
      // data DIRECTLY on the raw file via better-sqlite3 BEFORE getDatabase
      // ever opens it, exactly mirroring an operator upgrading junction with
      // an existing pre-45 DB on disk. Build the file up through 0012 by hand.
      const { mkdir } = await import("node:fs/promises")
      const path = await import("node:path")
      await mkdir(path.dirname(paths.dbFile), { recursive: true })
      const raw = new Database(paths.dbFile)
      raw.pragma("foreign_keys = ON")
      const { readFile } = await import("node:fs/promises")
      const { fileURLToPath } = await import("node:url")
      const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url))
      for (const tag of [
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
      ]) {
        const sqlText = await readFile(`${migrationsDir}${tag}.sql`, "utf8")
        for (const stmt of sqlText.split("--> statement-breakpoint")) {
          const trimmed = stmt.trim()
          if (trimmed.length > 0) raw.exec(trimmed)
        }
      }
      // Also seed the drizzle migrations tracking table so getDatabase's
      // migrate() only applies 0013 (not the whole set again).
      raw.exec(`
        CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      `)
      const journalMod = await import("./migrations/meta/_journal.json", {
        with: { type: "json" },
      })
      const journal = journalMod.default as { entries: Array<{ when: number; tag: string }> }
      const insertMig = raw.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      for (const entry of journal.entries) {
        // Increment 46 — 0014 is now also pending after 0012 (must stay
        // unseeded alongside 0013): `verifyProviderIdDropSafe`'s
        // migration0013AlreadyApplied check reads the MAX created_at across
        // the WHOLE tracking table (it has no per-tag column to filter on),
        // so seeding 0014's `when` (> 0013's) would make that check see
        // "something newer than 0013 is applied" and wrongly treat 0013 as
        // already-applied — skipping the fail-closed guard entirely.
        if (
          entry.tag === "0013_drop_oauth_meta_provider_id" ||
          entry.tag === "0014_drop_credential_profile_name"
        ) {
          continue
        }
        insertMig.run(`seed-${entry.tag}`, entry.when)
      }

      raw.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('gh', 'mcp', 'GitHub');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('cred_e2e_ok', 'gh-work', 'gh', 'work', 'oauth2', 'ref_a', '{"providerId":"github"}');
      `)
      raw.close()

      const result = await getDatabase(paths)
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return

      const row = result.value.$client
        .prepare("SELECT oauth_meta FROM credentials WHERE id = ?")
        .get("cred_e2e_ok") as { oauth_meta: string }
      expect(JSON.parse(row.oauth_meta)).toEqual({})

      const platformRow = result.value.$client
        .prepare("SELECT oauth_provider_id FROM platforms WHERE id = ?")
        .get("gh") as { oauth_provider_id: string }
      expect(platformRow.oauth_provider_id).toBe("github")
    })
  })

  it("a pre-45 DB with a credential that CANNOT be backfilled → getDatabase returns Err(migration-refused), the DB file is left with providerId intact", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const { mkdir, readFile } = await import("node:fs/promises")
      const path = await import("node:path")
      const { fileURLToPath } = await import("node:url")
      await mkdir(path.dirname(paths.dbFile), { recursive: true })
      const raw = new Database(paths.dbFile)
      raw.pragma("foreign_keys = ON")
      const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url))
      for (const tag of [
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
      ]) {
        const sqlText = await readFile(`${migrationsDir}${tag}.sql`, "utf8")
        for (const stmt of sqlText.split("--> statement-breakpoint")) {
          const trimmed = stmt.trim()
          if (trimmed.length > 0) raw.exec(trimmed)
        }
      }
      raw.exec(`
        CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      `)
      const journalMod = await import("./migrations/meta/_journal.json", {
        with: { type: "json" },
      })
      const journal = journalMod.default as { entries: Array<{ when: number; tag: string }> }
      const insertMig = raw.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      for (const entry of journal.entries) {
        // Increment 46 — 0014 is now also pending after 0012 (must stay
        // unseeded alongside 0013): `verifyProviderIdDropSafe`'s
        // migration0013AlreadyApplied check reads the MAX created_at across
        // the WHOLE tracking table (it has no per-tag column to filter on),
        // so seeding 0014's `when` (> 0013's) would make that check see
        // "something newer than 0013 is applied" and wrongly treat 0013 as
        // already-applied — skipping the fail-closed guard entirely.
        if (
          entry.tag === "0013_drop_oauth_meta_provider_id" ||
          entry.tag === "0014_drop_credential_profile_name"
        ) {
          continue
        }
        insertMig.run(`seed-${entry.tag}`, entry.when)
      }

      // An orphan OAuth credential — no platform to backfill from.
      raw.exec(`
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref, oauth_meta)
          VALUES ('cred_e2e_strand', 'orphan', NULL, 'orphan', 'oauth2', 'ref_orphan', '{"providerId":"github"}');
      `)
      raw.close()

      const result = await getDatabase(paths)
      expect(result.isErr()).toBe(true)
      if (result.isOk()) return
      expect(result.error.kind).toBe("migration-refused")
      if (result.error.kind !== "migration-refused") return
      expect(result.error.strandedCredentialIds).toEqual(["cred_e2e_strand"])

      // Re-open the raw file directly — untouched, providerId still present,
      // migration 0013 never got a chance to run.
      const verify = new Database(paths.dbFile)
      try {
        const row = verify
          .prepare("SELECT oauth_meta FROM credentials WHERE id = ?")
          .get("cred_e2e_strand") as { oauth_meta: string }
        expect(JSON.parse(row.oauth_meta)).toEqual({ providerId: "github" })
      } finally {
        verify.close()
      }
    })
  })
})

describe("getDatabase — migration 0014 (drop credentials.profile_name), end to end", () => {
  // Regression test for the boot-bricking defect in the FIRST cut of 0014:
  // it used a `__new_credentials` table-rebuild (DROP TABLE credentials)
  // guarded by `PRAGMA foreign_keys=OFF`. drizzle's better-sqlite3 migrator
  // wraps ALL pending migrations in ONE transaction, and `PRAGMA foreign_keys`
  // is a documented SQLite no-op INSIDE a transaction — so for any user with
  // a `source_refs` row bound to a credential (ON DELETE RESTRICT FK), the
  // DROP TABLE hit the live FK and raised `FOREIGN KEY constraint failed`,
  // rolling back the whole migration set and refusing to boot, permanently.
  //
  // This drives the REAL single-transaction `migrate()` via the public
  // `getDatabase` entry point (not the per-statement `applyMigration` test
  // helper used elsewhere in this repo, which runs each statement OUTSIDE a
  // transaction and therefore could never have caught this: the pragma
  // toggle actually takes effect per-statement, masking the bug). It must
  // FAIL against the old table-rebuild SQL and PASS against the new native
  // `ALTER TABLE ... DROP COLUMN` SQL.
  it("a pre-46 DB with a source_refs row BOUND to a credential boots cleanly through 0014, drops profile_name, and keeps the source_refs→credentials FK enforced", async () => {
    await withTempHome(async () => {
      const paths = getPaths()
      const { mkdir, readFile } = await import("node:fs/promises")
      const path = await import("node:path")
      const { fileURLToPath } = await import("node:url")
      await mkdir(path.dirname(paths.dbFile), { recursive: true })
      const raw = new Database(paths.dbFile)
      raw.pragma("foreign_keys = ON")
      const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url))
      // Stage the file up through 0013 (0014 is the only pending migration
      // getDatabase's migrate() will apply below) — mirrors the 0013 tests'
      // pattern of hand-building a pre-target-migration DB on the raw file.
      for (const tag of [
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
        "0013_drop_oauth_meta_provider_id",
      ]) {
        const sqlText = await readFile(`${migrationsDir}${tag}.sql`, "utf8")
        for (const stmt of sqlText.split("--> statement-breakpoint")) {
          const trimmed = stmt.trim()
          if (trimmed.length > 0) raw.exec(trimmed)
        }
      }
      raw.exec(`
        CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      `)
      const journalMod = await import("./migrations/meta/_journal.json", {
        with: { type: "json" },
      })
      const journal = journalMod.default as { entries: Array<{ when: number; tag: string }> }
      const insertMig = raw.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      for (const entry of journal.entries) {
        // Leave 0014 unseeded — it's the migration under test.
        if (entry.tag === "0014_drop_credential_profile_name") continue
        insertMig.run(`seed-${entry.tag}`, entry.when)
      }

      // The bound-source shape that bricked boot under the old rebuild SQL:
      // a platform, a credential, a profile, and a source_refs row whose
      // credential_id references that credential (ON DELETE RESTRICT FK).
      raw.exec(`
        INSERT INTO platforms (id, kind, display_name) VALUES ('gh', 'mcp', 'GitHub');
        INSERT INTO credentials (id, name, platform_id, profile_name, kind, secret_ref)
          VALUES ('cred_bound', 'gh-work', 'gh', 'work', 'oauth2', 'ref_bound');
        INSERT INTO profiles (id, name) VALUES ('prof_1', 'default');
        INSERT INTO source_refs (id, profile_id, platform_id, credential_id, tool_namespace, enabled)
          VALUES ('sref_1', 'prof_1', 'gh', 'cred_bound', 'gh', 1);
      `)
      raw.close()

      // The regression gate: this must NOT throw / return Err. Under the old
      // table-rebuild SQL, migrate() raised FOREIGN KEY constraint failed
      // here and getDatabase returned Err(migration-failed).
      const result = await getDatabase(paths)
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      const sqlite = result.value.$client

      // profile_name is gone.
      const cols = sqlite.prepare("PRAGMA table_info(credentials)").all() as Array<{
        name: string
      }>
      expect(cols.map((c) => c.name)).not.toContain("profile_name")

      // credentials_name_unique still exists and still rejects a duplicate name.
      const indexes = sqlite.prepare("PRAGMA index_list(credentials)").all() as Array<{
        name: string
        unique: number
      }>
      const nameIndex = indexes.find((i) => i.name === "credentials_name_unique")
      expect(nameIndex?.unique).toBe(1)
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO credentials (id, name, platform_id, kind, secret_ref) VALUES (?, ?, ?, ?, ?)",
          )
          .run("cred_dup", "gh-work", "gh", "oauth2", "ref_dup"),
      ).toThrow(/UNIQUE constraint failed/)

      // The source_refs → credentials FK is still enforced: deleting the
      // bound credential is RESTRICTED.
      expect(() =>
        sqlite.prepare("DELETE FROM credentials WHERE id = ?").run("cred_bound"),
      ).toThrow(/FOREIGN KEY constraint failed/)

      // The recovery snapshot captured the row before the drop.
      const backupRow = sqlite
        .prepare("SELECT profile_name FROM _profilename_drop_backup WHERE id = ?")
        .get("cred_bound") as { profile_name: string } | undefined
      expect(backupRow?.profile_name).toBe("work")
    })
  })
})
