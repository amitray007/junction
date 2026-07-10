-- Repoint source_refs off loser rows FIRST — MUST run before the dedup DELETE
-- below. source_refs.credential_id -> credentials.id is ON DELETE RESTRICT
-- (schema.ts, live since 0004) and PRAGMA foreign_keys=ON is set before
-- migrate() runs (db/index.ts) — the migrator wraps ALL pending migrations in
-- ONE transaction, so deleting a loser credential that a source_ref still
-- references would fail the FK check and roll back the whole migration,
-- bricking every real DB on next boot. Keep-newest: the route follows the
-- surviving credential (same group, MAX(id) = newest by ULID ordering).
UPDATE source_refs SET credential_id = (
  SELECT MAX(c2.id) FROM credentials c2, credentials c
  WHERE c.id = source_refs.credential_id
    AND c2.platform_id = c.platform_id AND c2.profile_name = c.profile_name
)
WHERE credential_id IS NOT NULL
  AND credential_id NOT IN (SELECT MAX(id) FROM credentials GROUP BY platform_id, profile_name);
--> statement-breakpoint
-- Dedup: keep only the newest row per (platform_id, profile_name) group.
-- ULIDs are lexicographically time-ordered, so MAX(id) is the newest add.
-- SQL-only — never routed through removeCredential/app code (a migration
-- cannot reach the keyring); losers' store secretRefs are consciously
-- orphaned (harmless dangling handles, covered by 32.7 orphan-observability).
DELETE FROM credentials WHERE id NOT IN (SELECT MAX(id) FROM credentials GROUP BY platform_id, profile_name);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_platform_profile_unique` ON `credentials` (`platform_id`,`profile_name`);
