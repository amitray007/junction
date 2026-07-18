// SPDX-License-Identifier: AGPL-3.0-only
// verifyProviderIdDropSafe — the fail-closed pre-migration guard for dropping
// `credentials.oauth_meta`'s `providerId` key (increment 45, Slice E / Fable
// E4). See docs/methods/45-custom-oauth-designs.md's "Slice E" section for
// the full design rationale — restated here at the point that matters:
//
// WHY THIS CAN'T BE A PURE .sql MIGRATION: "does this credential resolve
// WITHOUT the legacy fallback" is the resolver's job (resolveOAuthProviderId
// — TypeScript logic that also consults the merged built-in + custom OAuth
// design set), not something a .sql migration can express. The SQL-
// expressible SAFE approximation is narrower: "does the credential's bound
// platform have `oauth_provider_id` set at all" — a platform with a
// providerId set is guaranteed to resolve (assuming the id isn't dangling,
// which drop-time can't fix anyway — a dangling reference already fails
// closed at every live read/refresh path, independent of this migration).
//
// WHY THIS RUNS BEFORE `migrate()`, NOT AS A MIGRATION STEP: drizzle's
// better-sqlite3 migrator wraps ALL pending .sql files in ONE transaction
// with no JS callback between them (see drizzle-orm/sqlite-core/dialect.js's
// `SQLiteSyncDialect.migrate` — BEGIN, run every pending migration.sql,
// COMMIT). So a verification pass that must run TypeScript logic and decide
// whether to allow a LATER .sql file to execute cannot be interleaved with
// migrate() — it must run as a separate step BEFORE migrate() is invoked at
// all, deciding whether migration 0013 is allowed to be among the pending
// set migrate() will apply. This module IS that separate step; `getDatabase`
// calls it on the raw better-sqlite3 handle, before handing off to drizzle.
//
// SEQUENCE (idempotent, safe to run on every boot):
//   1. Skip entirely if migration 0013 is already applied (checked against
//      `__drizzle_migrations`, the SAME table/column drizzle itself uses to
//      decide "already applied" — see MIGRATION_0013_WHEN below, which MUST
//      stay byte-identical to meta/_journal.json's 0013 entry's `when`).
//   2. Backfill: `platforms.oauth_provider_id` ← the bound oauth2
//      credentials' legacy `oauth_meta.providerId`, FILL-ONLY-IF-UNSET, same
//      conflict rule as migration 0012 (disagreement → leave unset, never
//      guess). Re-derived here (not reused from 0012) because 0012 already
//      ran in a prior boot — this is a SECOND backfill pass over whatever
//      wrote providerId since, mirroring import-vault.ts's inline 0012-
//      equivalent backfill for the exact same reason.
//   3. Verify: for every credential with a non-null `oauth_meta.providerId`,
//      its platform must have `oauth_provider_id` SET (post-backfill). Any
//      credential that still can't be backfilled → collected as a stranded
//      id, ROW BY ROW (never abort-on-first — the inc-42/44 lesson: a single
//      wrapping transaction where one bad row bricks + hides the rest is the
//      exact failure mode to avoid; this function iterates and collects,
//      never throws mid-pass).
//   4. If ANY credential would strand → REFUSE. No recovery snapshot, no
//      backfill commit persisted (backfill runs in its own transaction,
//      rolled back on refusal — see below), no drop. Return a typed
//      `migration-refused` error listing every stranded credential id.
//   5. If zero would strand → the backfill's transaction COMMITS, then a
//      recovery snapshot `(credentialId → legacy providerId)` is written to
//      a dedicated `_providerid_drop_backup` table (created here, outside
//      drizzle's schema — insurance data, never read by the app; the vault
//      archive already carries an independent copy for restore, per Slice E's
//      "archive keeps providerId" rule). Only THEN does this function return
//      ok — migrate() runs next and 0013's DROP is now safe to apply.
//
// json_valid-GUARD: every `json_extract` on `oauth_meta` is guarded by
// `json_valid()` first (inc-44 gotcha — SQLite's `json_extract` THROWS on
// malformed JSON rather than returning NULL; an unguarded extract would brick
// the WHOLE boot on a single malformed row, not just skip it).

import type Database from "better-sqlite3"
import { err, ok, type Result } from "neverthrow"
import type { DbError } from "../errors/index.js"

/**
 * MUST stay byte-identical to `meta/_journal.json`'s entry for
 * `0013_drop_oauth_meta_provider_id` — this is how this guard decides
 * whether migration 0013 is still PENDING (drizzle itself decides the same
 * way: `__drizzle_migrations.created_at` compared against a migration's
 * journal `when`). If the journal timestamp ever changes, this constant must
 * move with it (a regression test in verify-provider-id-drop-safe.test.ts
 * asserts they match).
 */
export const MIGRATION_0013_WHEN = 1784405288167

const RECOVERY_TABLE = "_providerid_drop_backup"

interface StrandedCredential {
  id: string
  legacyProviderId: string
}

/**
 * Returns `true` if migration 0013 (or anything after it) has already been
 * applied — mirrors drizzle's own "already applied" check exactly
 * (`__drizzle_migrations` may not exist yet on a brand-new DB, which reads
 * as "nothing applied", i.e. NOT yet applied).
 */
function migration0013AlreadyApplied(sqlite: Database.Database): boolean {
  const tableExists = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`)
    .get()
  if (tableExists === undefined) return false
  const row = sqlite
    .prepare(`SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1`)
    .get() as { created_at: number } | undefined
  if (row === undefined) return false
  return row.created_at >= MIGRATION_0013_WHEN
}

/**
 * A BRAND-NEW database — `migrate()` has never run at all, so `platforms`/
 * `credentials` don't exist yet. Nothing to backfill/verify/snapshot: there
 * is no possible stranding data on a database that doesn't have the tables
 * migration 0013 touches. `migrate()` (called right after this guard) will
 * apply EVERY migration from 0000 through 0013 in one pass, including this
 * one, with nothing for this guard to gate.
 */
function credentialsTableExists(sqlite: Database.Database): boolean {
  return (
    sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credentials'`)
      .get() !== undefined
  )
}

/**
 * Backfill `platforms.oauth_provider_id` from bound oauth2 credentials'
 * legacy `oauth_meta.providerId`, FILL-ONLY-IF-UNSET, same conflict rule as
 * migration 0012's SQL (disagreement among bound credentials → leave unset).
 * Runs inside `txn` (caller-managed) so it can be rolled back atomically if
 * the verify pass that follows finds a stranded credential.
 */
function backfillPlatformOauthProviderId(sqlite: Database.Database): void {
  sqlite.exec(`
    UPDATE platforms
    SET oauth_provider_id = (
      SELECT CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END
      FROM credentials c
      WHERE c.platform_id = platforms.id
        AND c.kind = 'oauth2'
        AND c.oauth_meta IS NOT NULL
        AND CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END IS NOT NULL
      GROUP BY c.platform_id
      HAVING COUNT(DISTINCT CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END) = 1
    )
    WHERE oauth_provider_id IS NULL;
  `)
}

/**
 * Row-by-row (never a single aggregate query that could abort-and-hide) scan
 * of every oauth2 credential carrying a legacy `oauth_meta.providerId`,
 * checking whether its platform now has `oauth_provider_id` set (post-
 * backfill). Returns every credential that would strand — empty = safe to
 * drop.
 */
function findStrandedCredentials(sqlite: Database.Database): StrandedCredential[] {
  const rows = sqlite
    .prepare(
      `
      SELECT
        c.id AS id,
        CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END AS legacy_provider_id,
        p.oauth_provider_id AS platform_provider_id
      FROM credentials c
      LEFT JOIN platforms p ON p.id = c.platform_id
      WHERE c.kind = 'oauth2'
        AND c.oauth_meta IS NOT NULL
        AND CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END IS NOT NULL
      `,
    )
    .all() as Array<{
    id: string
    legacy_provider_id: string | null
    platform_provider_id: string | null
  }>

  const stranded: StrandedCredential[] = []
  for (const row of rows) {
    // legacy_provider_id is guaranteed non-null by the WHERE clause above —
    // the CASE/json_valid guard means a malformed oauth_meta row simply
    // never matches the WHERE (excluded, not stranded — nothing to strand:
    // a credential with unparseable oauth_meta has no legacy providerId this
    // migration could be dropping anyway).
    if (row.legacy_provider_id === null) continue
    if (row.platform_provider_id === null || row.platform_provider_id === undefined) {
      stranded.push({ id: row.id, legacyProviderId: row.legacy_provider_id })
    }
  }
  return stranded
}

/** Create the recovery table if absent — outside drizzle's schema (insurance data only). */
function ensureRecoveryTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${RECOVERY_TABLE} (
      credential_id TEXT PRIMARY KEY,
      legacy_provider_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
  `)
}

/**
 * Snapshot `(credentialId → legacy providerId)` for EVERY oauth2 credential
 * that currently carries one — not just ones that were backfilled — so the
 * recovery table is a complete pre-drop record, independent of whether the
 * backfill needed to touch that credential's platform. `INSERT OR REPLACE`
 * keeps this idempotent (a re-run before 0013 has committed — e.g. a crash
 * between this snapshot and migrate() — simply re-snapshots the same rows).
 */
function writeRecoverySnapshot(sqlite: Database.Database): void {
  ensureRecoveryTable(sqlite)
  const now = Date.now()
  sqlite.exec("BEGIN")
  try {
    const rows = sqlite
      .prepare(
        `
        SELECT id, CASE WHEN json_valid(oauth_meta) THEN json_extract(oauth_meta, '$.providerId') END AS legacy_provider_id
        FROM credentials
        WHERE kind = 'oauth2'
          AND oauth_meta IS NOT NULL
          AND CASE WHEN json_valid(oauth_meta) THEN json_extract(oauth_meta, '$.providerId') END IS NOT NULL
        `,
      )
      .all() as Array<{ id: string; legacy_provider_id: string }>
    const insert = sqlite.prepare(
      `INSERT OR REPLACE INTO ${RECOVERY_TABLE} (credential_id, legacy_provider_id, recorded_at) VALUES (?, ?, ?)`,
    )
    for (const row of rows) {
      insert.run(row.id, row.legacy_provider_id, now)
    }
    sqlite.exec("COMMIT")
  } catch (cause) {
    sqlite.exec("ROLLBACK")
    throw cause
  }
}

/**
 * The fail-closed guard `getDatabase` calls BEFORE `migrate()`. Ok(undefined)
 * means it is safe to let `migrate()` proceed (0013 will find every
 * credential's platform backfilled, and a recovery snapshot is already on
 * disk). Err(migration-refused) means the DB was left UNCHANGED (the
 * backfill transaction was rolled back) and 0013 must NOT run this boot —
 * the caller should surface the remediation list and refuse to open.
 */
export function verifyProviderIdDropSafe(sqlite: Database.Database): Result<void, DbError> {
  if (migration0013AlreadyApplied(sqlite)) {
    return ok(undefined)
  }
  if (!credentialsTableExists(sqlite)) {
    return ok(undefined)
  }

  // Backfill runs inside its own transaction so a refusal leaves the DB
  // byte-for-byte unchanged (never a partially-applied backfill sitting
  // around from a refused attempt).
  sqlite.exec("BEGIN")
  try {
    backfillPlatformOauthProviderId(sqlite)
    const stranded = findStrandedCredentials(sqlite)
    if (stranded.length > 0) {
      sqlite.exec("ROLLBACK")
      return err({
        kind: "migration-refused",
        migration: "0013_drop_oauth_meta_provider_id",
        strandedCredentialIds: stranded.map((s) => s.id),
        remediation:
          "these credentials' platforms need an oauthProviderId before the providerId column can be dropped — reconnect the credential or bind its platform to an OAuth design (built-in or custom) that matches",
      })
    }
    sqlite.exec("COMMIT")
  } catch (cause) {
    sqlite.exec("ROLLBACK")
    return err({ kind: "migration-failed", cause })
  }

  // Verification passed and the backfill is committed — snapshot BEFORE
  // migrate() runs 0013's destructive json_remove. Outside the backfill's
  // transaction on purpose: the backfill's correctness doesn't depend on the
  // snapshot, and a snapshot failure should surface as migration-failed
  // (retryable) rather than unwind an already-safe backfill.
  try {
    writeRecoverySnapshot(sqlite)
  } catch (cause) {
    return err({ kind: "migration-failed", cause })
  }

  return ok(undefined)
}
