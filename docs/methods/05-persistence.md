# Method File 05 — Persistence (Increment 5)

> **The data model gets a home.** Adds Drizzle + better-sqlite3 to `@junction/core`: a migrated SQLite schema at `~/.junction/junction.db`, a **repository layer** wrapping Drizzle, and `junction profile list` — the first command that reads persisted data. Activates `docs/rules/data.md` (forward-only migrations, secrets-as-references at the DB, repository access).
>
> **Builder:** Sonnet. This is the increment where `data.md` is load-bearing — obey it exactly. **Visually testable** by the user at the end (`junction profile list`).

---

## Part 1 — Spec (what & why)

### Goal

Persist the increment-4 entities to an embedded single-file SQLite DB, behind a repository API, with committed forward-only migrations. Realizes design spec §6 increment 5 + §4a (data architecture). Proof: CRUD round-trips in tests; `junction profile list` reads an (initially empty) table end-to-end.

### Decided design (from data.md + spec §3 — implement exactly)

- **Driver:** **better-sqlite3** (synchronous, embedded, single-file) + **Drizzle ORM**. DB file at **`~/.junction/junction.db`** (add `dbFile` to `JunctionPaths`).
- **Schema authority:** every persisted entity is a **Drizzle table in `core`** (`db/schema.ts`). Row types derive via `$inferSelect`/`$inferInsert`. Persisted shapes live ONLY in `core`, never in cli/web/mcp (`data.md`).
- **Boundary-shape vs row-shape** (the api-contract reviewer's flag, now concrete): the inc-4 Zod schemas are the **boundary/validation** shapes; Drizzle `$inferSelect` is the **row** shape. Repository methods **validate input with Zod** at the boundary, persist via Drizzle, and **reconstruct + Zod-validate** entities on read. Don't conflate the two type sources.
- **Migrations:** **drizzle-kit** generates SQL migration files, **committed** to the repo, **forward-only**. First migration creates `platforms`, `credentials`, `profiles`, `source_refs`. Applied at runtime via drizzle's `migrate()` (idempotent).
- **Repository layer:** callers never write raw queries. `createRepositories(db)` → `{ platforms, credentials, profiles }`, each an object of intent-revealing methods returning **`ResultAsync<T, DbError>`** (consistent async API even though better-sqlite3 is sync — keeps a future libsql swap a driver change, not a signature change). **No generic `Repository<T>` base** (dry.md — keep the three repos duplicated until proven).
- **secrets-as-references:** the `credentials` table has a **`secret_ref`** TEXT column (opaque handle) — **NO** plaintext/ciphertext column. (`data.md` + `security.md`.) The actual secret lands in the CredentialStore (increment 6).
- **Normalization:** `Profile.sources: SourceRef[]` (nested in the boundary schema) is stored as a separate **`source_refs`** table with a `profile_id` FK. `source_refs` has **no independent lifecycle** — it's managed *through* the profiles repo (create profile with its sources; get/list reconstruct the nested `Profile` and Zod-validate it). No standalone source-refs repo is exposed.
- **IDs:** opaque ULID strings (from `ids/`); IDs are the primary keys (TEXT). No autoincrement reliance.
- **No `user_id`/multi-tenancy** (single-user; `data.md`).

### better-sqlite3 / sync-I/O note

better-sqlite3 is **synchronous by design** — that's why it was chosen (single-user embedded DB; `docs/specs` §3). This is the **sanctioned exception** to `performance.md`'s "no sync I/O in core": the sync calls happen *inside* repository methods that present an **async `ResultAsync` API**, so callers aren't coupled to sync, and the boundary-guard hook (which blocks `fs.*Sync`, not native sqlite calls) is not tripped. Add a one-line note to `docs/rules/performance.md` recording this carve-out (better-sqlite3 is the approved embedded driver).

### New deps (to `@junction/core`)

- `drizzle-orm@^0.45` (runtime), `better-sqlite3@^12` (runtime) + `@types/better-sqlite3@^7` (dev), `drizzle-kit@^0.31` (dev).
- **`better-sqlite3` is a native module** — add it to root `package.json` `pnpm.onlyBuiltDependencies` (alongside esbuild/lefthook) so its binding compiles on install.

### Proof of done

- `pnpm verify` passes with real CRUD tests (temp DB via `JUNCTION_HOME=<tmpdir>`): create/get/list/delete for platforms, credentials, profiles; the **wedge persisted** (two credentials, same `platform_id`, different `profileName`); a **Profile round-trips with its nested `source_refs`** (write nested → normalized rows → read reconstructs the same nested Profile, Zod-validates).
- Migrations apply idempotently on a fresh DB; re-running is a no-op.
- **No secret column:** a test asserts the `credentials` table/schema has `secret_ref` and NO column holding a secret value; nothing plaintext written.
- **`junction profile list`** works end-to-end: on a fresh home it creates/migrates the DB and prints an empty list (human + valid `--json`).
- `pnpm depcruise` clean; `pnpm build` ships the migrations so a built `junction` can migrate a fresh DB (see Step 6 — the migrations-packaging gotcha).
- SPDX headers; committed; PR green.

### Out of scope

- The `CredentialStore` / actual secret encryption (increment 6 — inc 5 only stores `secret_ref`).
- MCP serving (7), sandbox (8), TUI (9). Profile *creation/editing* commands — inc 5 ships `profile list` (read) only; create/connect flows come with real platform-connection features (post-foundation). A web UI.
- OAuth tables (`token_refreshes` etc.) — future additive migrations.

---

## Part 2 — Implementation (step by step)

### Step 0 — tsconfig reference is already there (inc 3) — but core has no new cross-package edge

This is all in `core` (+ a `cli` command importing the repo via `@junction/core`). `cli/tsconfig.json` already references `../core` (inc 3). No new references needed.

### Step 1 — paths: add `dbFile`

In `core/src/paths/index.ts`, add `dbFile: <home>/junction.db` to `JunctionPaths` and `getPaths()`. Update the paths test.

### Step 2 — `db/schema.ts` (Drizzle tables)

Define `platforms`, `credentials`, `profiles`, `source_refs` as Drizzle sqlite tables matching the inc-4 entities. Key points:
- TEXT primary keys (the ULID IDs). Use the branded-ID values as strings.
- `platforms`: id (pk), kind, display_name, spec_url (nullable), base_url (nullable).
- `credentials`: id (pk), platform_id (FK → platforms.id), profile_name, kind, **secret_ref** (TEXT, NOT NULL — opaque handle, NEVER a secret), oauth_meta (TEXT nullable — JSON-serialized OAuthMeta, reserved). The wedge: **no unique constraint** forcing one credential per platform; (platform_id, profile_name) may be unique together if you want to prevent dup accounts — decide and note.
- `profiles`: id (pk), name (unique), mcp_endpoint_path.
- `source_refs`: id (pk, internal — or composite), profile_id (FK → profiles.id, ON DELETE CASCADE), platform_id, credential_id, tool_namespace, enabled (integer/boolean). Belongs to a profile.
- Derive row types via `$inferSelect`/`$inferInsert`. Do NOT re-declare entity shapes — these are the *row* types; the Zod schemas remain the *boundary* types.

### Step 3 — `drizzle.config.ts` + generate the first migration

- `drizzle.config.ts` (repo root or `packages/core/`): dialect `sqlite`, `schema: "./packages/core/src/db/schema.ts"`, `out: "./packages/core/src/db/migrations"`.
- Run `pnpm drizzle-kit generate` → produces `migrations/0000_*.sql` + the journal. **Commit these** (forward-only, `data.md`). Do NOT hand-edit.

### Step 4 — `db/index.ts` — `getDatabase(paths)`

- Open better-sqlite3 at `paths.dbFile` (creates the file if absent); wrap with `drizzle(...)`.
- Run `migrate(db, { migrationsFolder })` — idempotent; applies pending migrations. Resolve the migrations folder relative to the package (see Step 6 packaging note).
- Return the drizzle `db` handle (or a small `{ db, close() }`). Enable `PRAGMA foreign_keys = ON` and a sane `journal_mode` (WAL).
- Return `ResultAsync<Database, DbError>` — `migration-failed` on migrate error.

### Step 5 — repository layer (`core/src/repositories/`)

`createRepositories(db)` → `{ platforms, credentials, profiles }`. Each repo its own file, async `ResultAsync<…, DbError>` methods:
- `platforms`: `create(input)`, `get(id)`, `list()`, `delete(id)`.
- `credentials`: `create(input)`, `get(id)`, `forPlatform(platformId)` (→ many — the wedge), `list()`, `delete(id)`.
- `profiles`: `create(profile)` (writes the profile row + its `source_refs` rows in a **transaction**), `get(id)` / `getByName(name)` (reconstructs the nested `Profile` from `profiles` + `source_refs`, then `ProfileSchema.parse` to validate), `list()`, `delete(id)` (cascades source_refs).
- **Validate input with the inc-4 Zod schemas at the boundary** before insert; **validate reconstructed entities** on read. Map sqlite/constraint errors to `DbError` (`constraint-violation`, `not-found`, `query-failed`). `source_refs` is managed only through `profiles` — no exposed standalone repo.
- Add `DbError` discriminated union to `core/src/errors/index.ts`.

### Step 6 — packaging the migrations (the gotcha — verify empirically)

The committed SQL migrations must be available at **runtime** so a built `junction` can migrate a fresh DB. Options (pick one, verify it works from `dist`):
- Resolve the migrations folder relative to the built file (`new URL("./migrations", import.meta.url)`), and ensure tsdown **copies** `db/migrations/**` into `dist/` (tsdown asset copy / a build step). OR
- Bundle the migration SQL as strings.
**This is the single most likely thing to break** — the `getDatabase` must find the migrations after `pnpm build`. **Verify:** `pnpm build`, then run the built CLI against a fresh `JUNCTION_HOME` and confirm tables are created and `profile list` works (not just `pnpm verify`, which runs from source).

### Step 7 — `junction profile list` command (cli)

- `packages/cli/src/commands/profile.ts` — a `profile` command with a `list` subcommand (citty). `list` opens the DB via `@junction/core` (`getDatabase(getPaths())` → `createRepositories`), calls `profiles.list()`, prints.
- Human: a small table (name, # sources, endpoint) or "No profiles yet. (Connecting platforms comes later.)". `--json`: a pure JSON array.
- Consume the `Result`; translate `DbError` → exit code + message (human) / JSON error (under `--json`). Edge stays thin — all logic in core; the command just calls + formats. Register `profile` in the citty root.
- Update `junction-dev` skill with the new command.

### Step 8 — tests

- **Repository CRUD** (temp DB via `JUNCTION_HOME=<tmpdir>` + `getDatabase`): each repo create→get→list→delete.
- **The wedge persisted:** insert one platform, two credentials same `platform_id` different `profileName`; `credentials.forPlatform(id)` returns both.
- **Profile normalization round-trip:** create a Profile with 2 source_refs → `getByName` returns the nested Profile equal to input (sources reconstructed, order stable or sorted), passes `ProfileSchema`.
- **Migration idempotency:** call `getDatabase` twice on the same home — no error, no dup tables.
- **Security:** assert no column/value holds a secret; a credential row has `secret_ref` only.
- **CLI:** `profile list` on a fresh home → empty (human + valid `--json`, exit 0); a child-process smoke test against the built bin.

### Step 9 — deps, verify, build, commit

- Add deps (Step "New deps"); add `better-sqlite3` to `pnpm.onlyBuiltDependencies`; `pnpm install`.
- `pnpm verify`; `pnpm build`; **the runtime-migration check from Step 6**; `pnpm depcruise`.
- Add the better-sqlite3 sync carve-out note to `docs/rules/performance.md`.
- SPDX headers; commit; push; open PR (base main): "feat: persistence — Drizzle + better-sqlite3 + profile list (increment 5)".

---

## Review (background, after build)

- Junction: `junction-package-boundary` (persistence in `core` only; cli `profile list` thin), `junction-clean-code-reviewer` (no secret column; repository wraps Drizzle; no raw queries in cli; Result discipline; narrow barrel; no generic Repository base).
- CE: **`ce-data-migration-reviewer`** + **`ce-data-integrity-guardian`** (migration safety, forward-only, FK/cascade correctness, transaction boundaries on the profile+source_refs write, additive-growth shape), `ce-correctness-reviewer` (CRUD edge cases, the normalization reconstruction, not-found/constraint handling), `ce-testing-reviewer` (CRUD + wedge + round-trip coverage, the runtime-migration test), `ce-security-reviewer` (secrets-as-references holds at the DB; no plaintext path).
- Then `/ce-simplify-code` on the diff.

## End-of-increment report (per CLAUDE.md)

Close with: **visually testable — YES** (`junction profile list` + `--json`, empty on a fresh home; commands provided); **QA'd by me** (gates + driving the built CLI against a fresh `JUNCTION_HOME` to confirm migrations create tables and list works, the wedge + normalization round-trips, no secret column); **checklist** of the intricate details (forward-only migration applied, FK cascade, transaction on profile write, boundary-vs-row types, secrets-as-references, migrations packaged for runtime).

## User test gate

`pnpm build`, then `JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js init` then `... profile list` (+ `--json`) — confirm a real DB at `/tmp/jtest/junction.db` and an empty profile list. Approve before increment 6 (CredentialStore — where `secret_ref` gets its meaning).
