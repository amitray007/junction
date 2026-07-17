---
increment: 42
title: Phase 1 — credentials become standalone secrets (no platform link)
depends_on: [41]
soft_after: []
touches: [core/schema, core/db, core/repositories, web]
parallel_group: A
---

# 42 — Phase 1: credentials become standalone secrets

North star: `docs/specs/2026-07-17-credential-platform-normalization.md`. This is the first of
three ordered phases. **Ships the felt fix immediately**: create a secret with no platform
picker. Phases 2 (inline bind) and 3 (OAuth normalization) build on this. **Does NOT touch
OAuth** — OAuth credentials keep working exactly as today.

## What / why

Today `credential.platformId` is a **required FK**, so creating a credential *starts* with
picking a platform — backwards. Make credentials standalone: a credential is a pure secret with
its own identity, no platform required to exist. Existing credentials keep their platform link
(back-compat); new ones may be unlinked.

## Interfaces / changes

### 1. Schema + migration (the core slice — lands first)

- **`credential.platformId` → nullable.** `packages/core/src/schema/credential.ts`:
  `platformId: PlatformIdSchema.nullable()` (or `.optional()` — pick nullable to match the DB
  column; keep the wire shape explicit). Migration **0011** via `pnpm drizzle-kit generate`
  (SQLite can't drop NOT NULL in place → drizzle emits a table-rebuild; **never hand-author**).
  Existing rows keep their non-null platformId.
- **Credential identity (name).** A standalone credential needs its own display identity (today
  it's identified by `(platform, account)`). Add a first-class **`name`** field
  (`z.string().min(1)`) — the credential's own label, shown everywhere. `profileName` stays as the
  **account** concept (which account, used at bind/verify time when a platform is present).
  Migration adds the `name` column; backfill existing rows' `name` from `profileName` (or
  `platform:account`) so nothing is nameless.
- **Unique index `(platform_id, profile_name)`**: with a nullable `platform_id`, SQLite treats
  NULLs as distinct, so multiple unlinked credentials coexist — keep the index (it still guards
  one-account-per-platform for *linked* rows). Add a **`name` uniqueness** guard for unlinked
  credentials (partial unique index on `name WHERE platform_id IS NULL`) so the vault has stable
  identities. Confirm the exact index shape with the data-migration reviewer.

### 2. Repository (`packages/core/src/repositories/credentials.ts`)

- `addCredential` no longer requires `platformId` — accepts `{name, kind, secret, platformId?}`.
  When `platformId` is absent → an unlinked vault entry.
- `list`/`get` return the nullable `platformId` + `name`. `forPlatform(platformId)` unchanged
  (linked rows only). Add a `listUnlinked()` / filter for the vault view.
- `renameCredential` already edits `profileName`; add/'`rename`' for the new `name`.
- Boundary-validate on every read (nullable platformId parses; `name` required).

### 3. Web — `/credentials` becomes pure CRUD (no platform picker)

- **Add Credential dialog** (`credentials.tsx` `AddCredentialDialog`): **drop the platform
  Select.** Fields become **Name · Kind · Secret** (+ optional Account when the user wants to
  pre-label). Kind is chosen directly (api-key/bearer/env/file — the raw kinds; **oauth2 is NOT
  offered here** in Phase 1 — OAuth still comes via a platform's Connect flow, unchanged).
- **Verify**: verifying a credential needs a platform to test against. For an **unlinked**
  credential, hide/disable verify with an honest note ("verify after linking to a platform").
  Linked credentials keep verify.
- **List**: show unlinked credentials (group them under an "Unlinked" / "Vault" divider; linked
  ones stay grouped by platform as today).
- Server fn: `addCredentialFn` validator drops the required `platformId` (make it optional), adds
  `name`. `packages/web/src/server/mutations.functions.ts`.

## Files

- **Edit** `packages/core/src/schema/credential.ts` (nullable platformId + `name`).
- **Create** migration `0011_*.sql` via drizzle-kit (+ snapshot + journal) — generated, backfilled.
- **Edit** `packages/core/src/db/schema.ts` (column nullable + `name` + index).
- **Edit** `packages/core/src/repositories/credentials.ts` (+ its test).
- **Edit** `packages/web/src/routes/credentials.tsx` (AddCredentialDialog: drop picker, add name/kind/secret) + `packages/web/src/server/mutations.functions.ts` (validator) + `platform-mutations`/`data` server fns as needed for the list.
- Tests: repo round-trip (unlinked + linked), migration up (existing rows keep platformId + get a name), web dialog (no platform picker; name+kind+secret creates an unlinked credential).

## Constraints

- **Back-compat sacred**: existing credentials (with platformId) parse + behave unchanged. OAuth
  untouched. Migration is additive/rebuild-safe; existing rows keep platformId + gain a backfilled name.
- Secrets-as-references unchanged — only linkage/identity columns change.
- Data-migration reviewer required (table-rebuild + index change). Typed errors, no sync fs, `docs/rules/`.

## Proof-of-done

- `/credentials` → "Add Credential" creates a secret from **Name + Kind + Value alone** — no
  platform selector. Driven against the real web server (`junction-web-verify`).
- An unlinked credential round-trips (repo + DB); existing linked credentials + OAuth unchanged.
- `pnpm verify` + `pnpm knip` + `pnpm depcruise` + `pnpm dup` green; migration test proves old
  rows keep their platformId and gain a name.
