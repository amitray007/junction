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

## THE CENTRAL DESIGN QUESTION (Fable ruling REQUIRED before build)

`name` is ALREADY the credential's global identity with a `UNIQUE(name)` index
(`credentials_name_unique`, inc 42). So after dropping `profileName`:

- The **refresh account label** and **vault `account`** trivially re-point to `name` (a display/label
  concern — `name` is a fine human label).
- But the **duplicate-account guard** protected "one `{platformId, account}` per platform" — with
  `account` = `profileName`. If `account` becomes `name`, and `name` is ALREADY globally unique,
  then **"one account per platform" may be subsumed by global name-uniqueness** (two credentials on
  one platform necessarily have different names → different accounts → no dup possible). OR the
  concept of "account" (multiple logins to the SAME platform, distinguished by a label) is something
  `name` alone doesn't capture and needs preserving differently.

**Fable must rule:**
- **RA — what does "account" mean post-drop?** Is a credential's account identity now simply its
  `name` (so the multi-account wedge = "multiple credentials with different names bound to the same
  platform"), or is a distinct account-label concept still needed (and if so, is dropping
  `profileName` even correct, vs. keeping it but renaming/re-scoping)?
- **RB — the DB uniqueness index Fable pre-signalled.** Given `UNIQUE(name)` already exists globally,
  is a `UNIQUE(platform_id, name)` (a) REDUNDANT (name alone is unique → skip it, the guard's job is
  already done by `credentials_name_unique`), or (b) still wanted as a defense-in-depth / to allow a
  future where names are only platform-scoped-unique? Rule on whether inc 46 adds a NEW index at all,
  or whether the existing `UNIQUE(name)` IS the restored invariant and the app-level guard can be
  DELETED (not just re-pointed) because the DB now enforces it.
- **RC — the duplicate-account guard's fate.** If RB makes `UNIQUE(name)` the enforcement, the
  app-level `forPlatform().some(c => c.profileName === account)` guard in add/bind/rename becomes
  redundant → delete it (and its `duplicate-account` error path) rather than re-point it? Or keep an
  app-level check for a friendlier error than a raw constraint violation? (inc 42/43 chose app-level
  for exactly the friendly-error reason — weigh that.)
- **RD — vault archive compat.** The archive's `account` field (`ManifestCredentialSchema` /
  `mc.account`) is a portability surface. Post-drop, does the archive keep `account` (mapped to/from
  `name` on export/import), or migrate to `name`? A pre-46 archive (with a distinct account ≠ name)
  must still import — how is its `account` reconciled with `name`?

## Migration 0014 (data-migration reviewer REQUIRED)

Whatever RA–RD rule, the DROP itself: `profile_name` is `NOT NULL` today. Dropping a column in
SQLite is a **table-rebuild** (like 0011) — the exact inc-42 brick lessons apply:
- Forward-only; if any re-point backfill is needed (e.g. `name` ← `profileName` for rows where they
  differ — SHOULDN'T exist since inc 42 set `name` from `platform-account`, but VERIFY), it must be
  `json_valid`/GLOB-guarded and NON-destructive.
- If RB adds a new UNIQUE index, the rebuild must not ABORT on a pre-existing violation (the 0011
  collision-suffix lesson) — dedup or refuse-with-list first.
- Adversarial tests: rows where `name` and `profileName` differ; two credentials on one platform;
  a pre-46 vault archive round-trip.
- **Recovery:** consider a recovery snapshot of `(id → profileName)` before the drop (mirror 0013's
  `_providerid_drop_backup`) if any information is being destroyed that isn't reconstructable from
  `name`.

## Slices (Fable RA–RD determine the exact shape; provisional)

- **A (blocking core):** schema — remove `profileName` from `CredentialSchema` + the DB column
  (migration 0014); re-point the duplicate-account guard per RB/RC; the refresh account label +
  `resolve-credential` account onto `name`.
- **B:** vault export/import `account` handling per RD.
- **C:** CLI + web display sites re-point `account` → `name` (or the RA-decided source).

Order A → (B ∥ C), serial-integrated, `pnpm verify` after each. (B∥C only if disjoint touches — the
inc-45 parallel-shared-symbol lesson: serialize if one creates a symbol the other compiles against.)

## Constraints

- **Touch ONLY the credential's `profileName` (sense 1). NEVER the Profile-name namespacing sites
  (sense 2).**
- The duplicate-account SECURITY invariant must be preserved (re-pointed or DB-enforced) at EVERY
  point — no window where two same-account credentials can land on one platform.
- Migration 0014 non-destructive + adversarial-tested (inc-42/44 brick lessons); recovery snapshot
  if information is lost.
- Vault pre-46 archive compat (RD).
- `docs/rules/`. `semgrep` (no-bare-throw-in-core), knip, depcruise, dup all outside `pnpm verify` —
  run before push (see the commit-hook memory).
- Scriptable `--json` CLI paths intact.

## Proof-of-done

- `credential.profileName` / `credentials.profile_name` are GONE (grep-clean of sense-1 sites); the
  Profile-name namespacing sites (sense 2) are untouched.
- The duplicate-account invariant holds (per Fable RB/RC) — proven a 2nd same-account credential
  can't land on one platform.
- A live OAuth credential still refreshes (account label now `name`); a pre-46 vault archive imports.
- Migration 0014 non-destructive + adversarial-tested; `pnpm verify` + knip + depcruise + dup +
  semgrep green; both mandatory reviews clean.
