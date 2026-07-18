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
        if (entry.tag === "0013_drop_oauth_meta_provider_id") continue
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
        if (entry.tag === "0013_drop_oauth_meta_provider_id") continue
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
