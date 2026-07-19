-- Increment 46 Slice A (Fable RA-RE) — drop `credentials.profile_name`. See
-- docs/methods/46-drop-profilename.md's Fable ruling.
--
-- RA: a credential's account identity IS its `name` now — `profileName` is
-- dropped outright, no renamed/retained account-label concept.
-- RB: NO new index — the existing global UNIQUE(name) (`credentials_name_unique`,
-- migration 0011) IS the restored invariant, and this migration changes NO
-- constraints at all, so it needs no rebuild step to touch them.
-- RE: `profile_name` is NOT reconstructable from `name` in general (explicit-
-- name creates, post-32.13 renames, and lossy slugification are three real
-- divergence paths) — so a full recovery snapshot `_profilename_drop_backup
-- (id, profile_name)` is written for EVERY row BEFORE the drop, mirroring
-- 0013's `_providerid_drop_backup`: forward-only, never read by app code.
--
-- IMPORTANT — why this is a native DROP COLUMN, not a table-rebuild (unlike
-- migration 0011, which HAD to rebuild because it changed constraints): an
-- earlier version of this migration used the `__new_credentials` rebuild
-- pattern (create __new_credentials, copy rows, DROP TABLE credentials,
-- RENAME, recreate the index) guarded by `PRAGMA foreign_keys=OFF` around the
-- DROP TABLE. That was WRONG and boot-bricking for any user with a
-- `source_refs` row bound to a credential: drizzle's better-sqlite3 migrator
-- wraps ALL pending migrations in ONE transaction, and in SQLite
-- `PRAGMA foreign_keys` is a documented no-op INSIDE a transaction — the
-- toggle to OFF never actually took effect, so `DROP TABLE credentials` hit
-- `source_refs.credential_id`'s `ON DELETE RESTRICT` FK and raised
-- `FOREIGN KEY constraint failed`, rolling back the whole migration set and
-- refusing to boot, permanently (retries fail identically — the inc-42
-- "brick" class). Since RB adds no new constraint here (unlike 0011, which
-- had to rebuild to move the unique index from (platform_id, profile_name)
-- to (name) alone), there is no reason to rebuild the table at all: SQLite
-- 3.35+ (better-sqlite3 here bundles 3.53.2) supports a native
-- `ALTER TABLE ... DROP COLUMN`, which never drops or recreates the table,
-- so the `source_refs → credentials` FK is never touched and
-- `credentials_name_unique` is preserved automatically. No `name` backfill,
-- no dedup pass either — just the snapshot, then the column drop.
CREATE TABLE `_profilename_drop_backup` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_name` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `_profilename_drop_backup` (`id`, `profile_name`)
SELECT `id`, `profile_name` FROM `credentials`;
--> statement-breakpoint
ALTER TABLE `credentials` DROP COLUMN `profile_name`;
