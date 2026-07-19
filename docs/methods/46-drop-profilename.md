---
increment: 46
title: Drop credential.profileName — re-point onto `name`, restore a DB uniqueness index
depends_on: [45]
soft_after: []
touches: [core/schema, core/db, core/credentials, source-runtime, cli, web]
parallel_group: A
---

# 46 — Drop `credential.profileName` (a dedicated credential-identity refactor)

North star: `docs/specs/2026-07-17-credential-platform-normalization.md`. The final cleanup of the
normalization arc. **Fable E2 (inc 45) SPLIT this out of inc 45** because inc 42's "write-only
legacy / inert" claim about `profileName` was FACTUALLY WRONG — it is **live-read in ~30 sites**,
including the **sole enforcement of the duplicate-account SECURITY guard**. Dropping it is a
credential-identity refactor with a security invariant in the blast radius, NOT a column drop —
hence its own increment, its own review, its own migration.

> **Design authority.** Fable pre-signalled the shape (E2): re-point the duplicate-account guard +
> refresh account label + vault `account` from `profileName` onto `name`; **restore a DB-level
> uniqueness index** so the invariant stops living only in app code; then drop the column. **BUT one
> central design question (below) needs a fresh Fable ruling before build** — what the guard actually
> protects after the re-point, and therefore the exact DB constraint. data-migration +
> credential-security reviewers REQUIRED.

## CRITICAL — two DIFFERENT `profileName`s (do NOT conflate)

A naive `grep profileName` hits ~50 sites across TWO UNRELATED meanings. Inc 46 touches ONLY the
first:

### (1) The CREDENTIAL's `profileName` = the account label — THIS is what inc 46 drops
The `credentials.profile_name` column + `credential.profileName` field. Live readers:
- **Duplicate-account guard (the security invariant — sole enforcement since 0011):**
  `add-credential.ts:185`, `bind-credential-to-platform.ts:84,90`, `rename-credential.ts:64,78`
  (all `c.profileName === <account>`).
- **OAuth refresh account label:** `refresh.ts:239,282,401` (`account: credential.profileName`).
- **Vault archive `account` field:** `export-vault.ts:157,168,187,215,242`;
  `import-vault.ts:337,681,762,776,1120` (reads/writes `mc.account` ↔ `profileName`).
- **Create/derive:** `add-credential.ts:206`, `add-standalone-credential.ts:67`,
  `derive-name.ts:44`, `oauth-connect.ts:485,545`, `resolve-credential.ts:92`.
- **Repo:** `credentials.ts:41,62,148,151` (rowToCredential / setProfileName).
- **Schema/DB:** `credential.ts:118` (`profileName: z.string().min(1)`), `schema.ts:43`
  (`profile_name text NOT NULL`).
- **Display (CLI/web):** `credential.ts:478,1114,1135`, `connect.ts:80`, `profile.ts:233`,
  `mutations.server.ts:73`, `data.server.ts:262,475`, `platform-mutations.server.ts:1142`.

### (2) The PROFILE's name — UNRELATED, do NOT touch (the false-positive Fable flagged)
`{ profileName, proxy }` entries keyed by a **Profile's** `name` for tool-namespacing:
`scoped-proxy.ts:33,103`, `synthetic-tool.ts:66,79,175,181,186,193,246`, `mcp.ts:247,255`,
`serve.ts:213,223,242`, `profile.ts:190,375,415`, `audit-sink.ts:127`, `debug.ts:58`. These are the
Profile identity in the namespacing layer — **completely separate** from a credential's account
label. Inc 46 must leave every one of these untouched.

## FABLE RULING (binding — RA–RE decided, build from this)

`name` is ALREADY the credential's global identity with a `UNIQUE(name)` index
(`credentials_name_unique`, inc 42). The crux Fable ruled on: `name` is DERIVED from
`<platformId>-<account>` **but** an explicit `name` bypasses derivation, so `UNIQUE(name)` did NOT
already subsume "one account per platform" — the app-level guard was genuinely the sole enforcer.
The ruling collapses the two concepts:

- **RA — "account" ≡ `name`.** A credential's account identity IS its `name`. Drop `profileName`
  outright — no renamed/retained account-label concept. "account" survives only as an OPTIONAL,
  never-stored **name-derivation seed** at create time (`AddCredentialInput.account` becomes optional,
  used only when `name` is absent, to derive one — then discarded). `deriveCredentialName` keeps its
  two-part signature; **rename its 2nd param `profileName` → `label`** (a seed, not a field). Where a
  real account string exists at mint (OAuth connect fetches the provider username) it feeds the seed →
  `github-octocat`, meaning lands in `name`, nothing lost. *(Futures entry: an optional credential
  `description` field for annotating provider-side account identity — trigger: a user asks to record
  which real account a credential maps to.)*
- **RB — NO new index.** The existing global `UNIQUE(name)` (`credentials_name_unique`) IS the
  restored invariant. Do NOT add `UNIQUE(platform_id, name)` — strictly redundant (global name-unique
  ⟹ unique-per-platform) and it would falsely imply a "names only platform-scoped-unique" future that
  contradicts inc 42. Migration 0014's rebuild MUST recreate `credentials_name_unique` in the same
  transaction (no window where the table exists without it).
- **RC — DELETE the guard (a), with a typed replacement.** Once `account ≡ name`, "same account on a
  platform" IS "same name" — globally DB-enforced (stronger than the app guard, which had a documented
  read-then-write race). Delete the platform-scoped duplicate-account guard at all three sites
  (`add-credential.ts:185`, `bind-credential-to-platform.ts:83-92`, `rename-credential.ts:78`) and
  RETIRE the `duplicate-account` error kind (`errors/index.ts:50`), replacing it with a new typed
  **`{ kind: "duplicate-name"; name: string }`**. Friendly-error principle preserved, NOT abandoned:
  `addCredential`/`addStandaloneCredential` map the `credentials_name_unique` constraint violation to
  `duplicate-name` via the existing `writeCredential` `onConstraintViolation` hook (upgrading
  standalone's current stringly `invalid-input` at add-standalone-credential.ts:82-85 to the typed
  shape). Per-site: **add** — guard deleted, constraint mapping → `duplicate-name`; **bind** — gate 4
  guard + its `forPlatform` read deleted entirely (binding never touches `name`); **rename** —
  re-pointed to rename `name` (CredentialNameSchema-validated, rename-to-own-name no-op preserved,
  global `list()` pre-check → friendly `duplicate-name`, DB backstop behind it); also fix the stale
  `credentials_platform_profile_unique`/32.x index comment at rename-credential.ts:47 (that index died
  in 0011).
- **RD — vault keeps `account` (= `name`).** Manifest schema v1 UNCHANGED (`account` stays required).
  Export writes `account: cred.name` for every credential (the linked/unlinked branch at
  `export-vault.ts:242` collapses). Import: effective identity = `mc.name ?? deriveCredentialName(...,
  mc.account, ...)` (pre-42 archives with no `name` derive from `account` — the seed role); the
  collision check re-points from `c.profileName === mc.account` (`import-vault.ts:337,681`) to a
  **global name match** (the ONLY semantics coherent with RB — a per-platform account check would pass
  a cred whose add then explodes on `credentials_name_unique`). Within-archive dup key
  (`import-vault.ts:635`) re-keys `[platformId, account]` → effective name. Stop writing `profileName`
  (`import-vault.ts:762,776,1120`). Pre-46 archive where `account` ≠ `name` imports cleanly (`name`
  wins as identity); pre-42 archive with no `name` derives one.
- **RE — recovery snapshot REQUIRED.** `profileName` is NOT reconstructable from `name` in general —
  three real divergence paths: (1) explicit-name creates (`--name gh-main --account work` → name
  `gh-main`, profileName `work`, derivation never ran); (2) `renameCredential` has mutated
  `profileName` since 32.13 without touching `name`; (3) slugification/collision-suffix are lossy even
  where derivation ran. So migration 0014 MUST write `_profilename_drop_backup (id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL)` before the rebuild — mirroring 0013's `_providerid_drop_backup`:
  forward-only, never read by app code, populated in the same transaction as the drop. No `name`
  backfill needed (`name` is authoritative NOT NULL + unique since 0011). No pre-existing-violation
  dedup pass needed (RB adds no new constraint).

## Migration 0014 (data-migration reviewer REQUIRED)

`profile_name` is `NOT NULL` today. Dropping a column in SQLite is a **table-rebuild** (like 0011) —
the exact inc-42 brick lessons apply:
- **Same-transaction order:** create `_profilename_drop_backup(id, profile_name)` → copy all rows into
  it → rebuild the `credentials` table WITHOUT `profile_name` → recreate `credentials_name_unique`
  (RB) → forward-only. Never a window where `credentials` exists without its unique index.
- No `name` backfill, no dedup pass (RB adds no new constraint) — but the drop of a `NOT NULL` column
  via rebuild must copy every OTHER column faithfully (mirror 0011's rebuild exactly).
- Adversarial tests (data-migration): rows where `profileName` ≠ derived-from-`name` (explicit-name +
  renamed rows); two credentials on one platform; a pre-46 AND a pre-42 vault archive round-trip;
  the snapshot table is populated and app code never reads it.

## Slices (Fable BUILD SHAPE — binding)

- **A (blocking core) — lands first, ALONE:** `schema/credential.ts` (remove `profileName` from
  `CredentialSchema`) · `db/schema.ts` (drop the column) + **migration 0014** (snapshot → rebuild →
  recreate index, RE/RB) · `errors/index.ts` (retire `duplicate-account`; add `duplicate-name`) ·
  `repositories/credentials.ts` (`rowToCredential` drops profileName; `setProfileName` → `setName`) ·
  `add-credential.ts` (delete guard; `input.account` optional derivation-seed; `onConstraintViolation`
  → `duplicate-name`) · `add-standalone-credential.ts` (stop mirroring profileName; typed
  `duplicate-name`) · `bind-credential-to-platform.ts` (delete gate 4 + its `forPlatform` read) ·
  `rename-credential.ts` (re-point to rename `name`; fix stale index comment) · `derive-name.ts`
  (param `profileName` → `label`) · `oauth-connect.ts` (provider username → seed, not stored field) ·
  `oauth/refresh.ts:239,282,401` + `resolve-credential` (`account` label ← `credential.name`; error
  shapes keep their `account` FIELD name, now fed by `name`).
- **B (after A):** vault — `export-vault.ts` (`account: cred.name` everywhere; branch at 242
  collapses) · `import-vault.ts` (effective-name identity; global name collision check at 337/681;
  dup-key at 635 re-keyed; drop profileName writes at 762/776/1120). Adversarial tests per RD/RE.
- **C (after A; ∥ B ONLY if no shared symbols — inc-45 lesson):** CLI + web display re-point every
  sense-1 read/display site (`credential.ts:478,1114,1135`, `connect.ts:80`, `profile.ts:233`, web
  `mutations.server.ts:73`, `data.server.ts:262,475`, `platform-mutations.server.ts:1142`) → `name`;
  CLI `--account` survives as a derivation-seed/alias input (scriptable paths intact); `--json` shapes
  drop `profileName`.

Order A → (B ∥ C), serial-integrated, `pnpm verify` after each. (B∥C only if disjoint touches — the
inc-45 parallel-shared-symbol lesson: serialize if one creates a symbol the other compiles against.)

## Constraints

- **Touch ONLY the credential's `profileName` (sense 1). NEVER the Profile-name namespacing sites
  (sense 2).**
- The duplicate-account SECURITY invariant is now DB-enforced by `credentials_name_unique` (RC) — the
  app guard is DELETED, not re-pointed. There must be no window where two same-name credentials can
  land (the migration recreates the index atomically; the friendly `duplicate-name` error + DB
  backstop replace the guard).
- Migration 0014 non-destructive + adversarial-tested (inc-42/44 brick lessons); the
  `_profilename_drop_backup` recovery snapshot is REQUIRED (RE — profileName is unreconstructable).
- Vault pre-46 archive compat (RD).
- `docs/rules/`. `semgrep` (no-bare-throw-in-core), knip, depcruise, dup all outside `pnpm verify` —
  run before push (see the commit-hook memory).
- Scriptable `--json` CLI paths intact.

## Proof-of-done

- `credential.profileName` / `credentials.profile_name` are GONE (grep-clean of sense-1 sites); the
  Profile-name namespacing sites (sense 2) are untouched.
- The invariant holds via `credentials_name_unique` (RC) — proven a 2nd same-NAME credential is
  rejected with the friendly typed `duplicate-name` error AND the DB backstop.
- A live OAuth credential still refreshes (account label now `name`); a pre-46 AND a pre-42 vault
  archive import cleanly.
- Migration 0014 non-destructive + adversarial-tested; `_profilename_drop_backup` populated + never
  app-read; `pnpm verify` + knip + depcruise + dup + semgrep green; both mandatory reviews clean.
