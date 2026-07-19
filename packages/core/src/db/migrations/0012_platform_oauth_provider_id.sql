-- Increment 44 Phase 3 (R1) — platforms gain their own OAuth design
-- reference. See docs/methods/44-oauth-designs-first-class.md and
-- docs/specs/2026-07-17-credential-platform-normalization.md.
--
-- 1. ADD COLUMN `oauth_provider_id` (nullable) — additive, no table rebuild
--    needed (no index/FK references it).
-- 2. BACKFILL from each platform's bound OAuth credentials'
--    `oauth_meta.providerId` (JSON — extracted via json_extract). Rules,
--    all load-bearing (data-migration review):
--      - NON-DESTRUCTIVE: never touches `credentials.oauth_meta` — the
--        credential's own copy is untouched (the column drop is a LATER
--        cleanup increment's job, gated on zero fallback hits).
--      - FILL-ONLY-IF-UNSET: `WHERE oauth_provider_id IS NULL` — never
--        overwrites an already-set value (re-running this migration, or a
--        prior manual set, is never clobbered).
--      - ORPHAN-SAFE: only platforms that have at least one bound OAuth
--        credential are touched; a platform with none (or only non-oauth2
--        credentials) is left alone. A credential with a NULL platform_id
--        (increment 42 — an unlinked/standalone secret) has no platform row
--        to backfill and is correctly excluded by the join.
--      - CONFLICT RULE (deterministic, never guess): if a platform's bound
--        OAuth credentials DISAGREE on providerId, this backfill leaves the
--        platform's oauth_provider_id UNSET — implemented via
--        `HAVING COUNT(DISTINCT json_extract(oauth_meta,'$.providerId')) = 1`,
--        which excludes any platform whose credentials don't unanimously
--        agree on exactly one providerId. The instrumented fallback
--        (resolveOAuthProviderId) keeps both credentials refreshing off
--        their own oauth_meta.providerId until a human resolves the
--        disagreement.
--      - IDEMPOTENT: re-running this migration is a no-op — the
--        fill-only-if-unset WHERE clause means a second run finds nothing
--        left to fill (already-set rows are skipped; still-conflicting rows
--        still conflict).
ALTER TABLE `platforms` ADD COLUMN `oauth_provider_id` text;
--> statement-breakpoint
-- The SET subquery is the ONLY conflict-rule/agreement check needed — no
-- separate WHERE-EXISTS guard: a correlated scalar subquery that matches ZERO
-- rows (no bound oauth2 credential, or a GROUP BY/HAVING-excluded conflict)
-- evaluates to SQL NULL, and assigning NULL to an already-NULL column
-- (guarded by the outer `oauth_provider_id IS NULL`) is a no-op — so a single
-- subquery correctly implements fill-only-if-unset + the conflict rule +
-- orphan-safety together, with nothing left to duplicate in a second clause.
-- MALFORMED-JSON SAFETY (data-migration review, inc 44): SQLite's
-- json_extract() THROWS "malformed JSON" — it does NOT degrade to NULL — on a
-- non-JSON oauth_meta value. Since drizzle wraps all pending migrations in ONE
-- transaction, a single malformed oauth_meta on a bound oauth2 credential would
-- abort the WHOLE migration → the vault can't open (the same brick class as
-- 0011's collision-suffix abort). No current write path stores malformed
-- oauth_meta (repositories.ts always JSON.stringify or NULL), but a manually-
-- edited / externally-restored / partially-written DB could — so we gate every
-- json_extract with json_valid() FIRST (a malformed blob is SKIPPED, excluded
-- from the group, never poisons an otherwise-agreeing platform), rather than
-- betting the write layer stays pristine.
-- Every json_extract is wrapped in CASE WHEN json_valid(...) THEN … ELSE NULL
-- END so a malformed blob yields NULL (skipped by the IS NOT NULL / GROUP BY)
-- rather than reaching json_extract at all — CASE guarantees the json_valid
-- test evaluates FIRST (unlike a WHERE-clause AND, whose term order SQLite does
-- not promise to short-circuit). A row with malformed oauth_meta contributes
-- NULL, which the `AND ... IS NOT NULL` predicate and COUNT(DISTINCT) both drop.
UPDATE `platforms`
SET `oauth_provider_id` = (
  SELECT CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END
  FROM `credentials` c
  WHERE c.platform_id = platforms.id
    AND c.kind = 'oauth2'
    AND c.oauth_meta IS NOT NULL
    AND CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END IS NOT NULL
  GROUP BY c.platform_id
  HAVING COUNT(DISTINCT CASE WHEN json_valid(c.oauth_meta) THEN json_extract(c.oauth_meta, '$.providerId') END) = 1
)
WHERE `oauth_provider_id` IS NULL;
