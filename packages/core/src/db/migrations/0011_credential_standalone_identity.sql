-- Increment 42 Phase 1 — credentials become standalone secrets. See
-- docs/methods/42-credentials-standalone.md and
-- docs/specs/2026-07-17-credential-platform-normalization.md.
--
-- Backfill FIRST (before the table rebuild): every existing row gets a
-- deterministic `name = platform_id || '-' || profile_name`, deduped with a
-- `-2`/`-3` suffix on collision (same rule the app-layer deriveCredentialName
-- helper uses for new rows lacking a user-supplied name). Ties broken by `id`
-- (a ULID — lexicographically time-ordered), so the backfill is deterministic
-- across re-runs of the SAME source data. A temp table holds the computed
-- name per credential id; the table-rebuild INSERT below joins against it.
--
-- CRITICAL (inc 42 data-migration review): platform_id and profile_name are
-- BOTH unconstrained (`z.string().min(1)` — no charset), so a raw concat can
-- produce a value that is NOT a valid CredentialNameSchema slug
-- (`^[a-z0-9][a-z0-9-]*$`) — e.g. platform_id "openapi:acme" or profile_name
-- "Work"/"client_acme" — which would then FAIL boundary validation on every
-- read, bricking the row. So we SLUGIFY, mirroring the app-layer slugifyPart
-- (lower + map non-[a-z0-9] runs to a single hyphen, trim hyphens): lower(),
-- map the realistic ASCII punctuation set to '-', collapse doubled hyphens,
-- trim. A GLOB guard is the backstop for ANYTHING still not a valid slug
-- (exotic/unicode chars the REPLACE chain didn't enumerate) → fall back to
-- lower(id) (a ULID is always a valid, unique slug). Result: a valid slug for
-- every row, human-friendly for realistic labels, safe for the rest.
CREATE TEMP TABLE `_cred_name_backfill` AS
WITH mapped AS (
  SELECT
    id,
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(platform_id || '-' || profile_name),
      ' ', '-'), ':', '-'), '_', '-'), '.', '-'), '/', '-'), '@', '-'),
      '+', '-'), '#', '-'), '!', '-'), '?', '-'), ',', '-') AS s
  FROM credentials
),
collapsed AS (
  -- collapse doubled hyphens (3 passes → up to 8 consecutive) then trim ends
  SELECT id, trim(replace(replace(replace(s, '--', '-'), '--', '-'), '--', '-'), '-') AS base
  FROM mapped
),
guarded AS (
  -- GLOB backstop: keep `base` only if it's a valid slug (starts alphanumeric,
  -- no char outside [a-z0-9-]); otherwise fall back to the always-valid lower(id).
  SELECT
    id,
    CASE
      WHEN base <> '' AND base GLOB '[a-z0-9]*' AND base NOT GLOB '*[^a-z0-9-]*'
        THEN base
      ELSE lower(id)
    END AS base_name
  FROM collapsed
),
ranked AS (
  SELECT
    id,
    base_name,
    ROW_NUMBER() OVER (PARTITION BY base_name ORDER BY id) AS rn
  FROM guarded
)
-- CRITICAL (inc 42 data-migration review, 2nd finding): the FIRST row in each
-- base partition (rn=1) keeps the pretty base name; every OTHER row is suffixed
-- with its own `lower(id)` — a ULID, GLOBALLY unique. A plain `-2`/`-rn` suffix
-- is only unique WITHIN the partition and can collide with a DIFFERENT row whose
-- LITERAL base equals the suffixed string (e.g. base "a-b-c" rn=2 → "a-b-c-2"
-- colliding with a row whose platform_id-profile_name IS "a-b-c-2"). That
-- duplicate would violate `credentials_name_unique` and ABORT the whole
-- (single-transaction) upgrade → boot-brick. `base||'-'||lower(id)` cannot
-- collide with any base (the 26-char ULID tail is unique to that row) nor with
-- another suffixed row (distinct ids). Trade-off: a collided row's name is
-- `base-<ulid>` (less pretty) instead of `base-2` — but collisions are rare and
-- the name is a renameable identity handle. Correctness over prettiness.
SELECT
  id,
  CASE WHEN rn = 1 THEN base_name ELSE base_name || '-' || lower(id) END AS name
FROM ranked;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform_id` text,
	`profile_name` text NOT NULL,
	`kind` text NOT NULL,
	`secret_ref` text NOT NULL,
	`oauth_meta` text,
	`last_verified_at` integer,
	`last_verify_result` text,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_credentials`("id", "name", "platform_id", "profile_name", "kind", "secret_ref", "oauth_meta", "last_verified_at", "last_verify_result")
SELECT
  c."id",
  b."name",
  c."platform_id",
  c."profile_name",
  c."kind",
  c."secret_ref",
  c."oauth_meta",
  c."last_verified_at",
  c."last_verify_result"
FROM `credentials` c
JOIN `_cred_name_backfill` b ON b."id" = c."id";
--> statement-breakpoint
DROP TABLE `credentials`;--> statement-breakpoint
ALTER TABLE `__new_credentials` RENAME TO `credentials`;--> statement-breakpoint
DROP TABLE `_cred_name_backfill`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_name_unique` ON `credentials` (`name`);
