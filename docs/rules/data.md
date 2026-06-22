# Data Architecture Rules

How junction persists data so future entities slot in **additively, never by rewrite**. These encode design spec §4a. They apply from increment 4 (data model) onward, and are load-bearing from increment 5 (persistence).

## Schema authority

- **MUST** define every persisted entity as a **Drizzle** table in `@junction/core`. Derive types from the schema (`$inferSelect` / `$inferInsert`); Zod validates at boundaries. One source of truth — no hand-duplicated shapes.
- **MUST NOT** define persisted shapes in `cli`/`web`/`mcp/*`. Persistence lives in `core`.

## Migrations

- **MUST** use `drizzle-kit` migrations, **committed** to the repo and **forward-only**. No hand-editing the DB schema; every change is a migration file.
- **MUST** make schema changes **additive**: new tables / new nullable columns. Do not repurpose or destructively alter existing columns. A new feature = a new migration, never a rewrite of an existing one.
- **SHOULD** keep migrations reversible where cheap, but forward-only is the contract.

## Identity & references

- **MUST** use opaque stable string IDs (ULID/uuid) for entities. No reliance on row order or autoincrement semantics in app logic.
- **MUST NOT** store secret plaintext or ciphertext inline in the main DB. A row holds a **reference/handle**; the actual secret lives via the `CredentialStore` (keyring / AES-GCM file). See `docs/rules/security.md`.

## Access

- **MUST** wrap Drizzle behind a **repository layer** in `core` (intent-revealing methods: `profiles.create`, `credentials.forPlatform`) — callers never write raw queries. This keeps a better-sqlite3 → libsql swap a driver change, not a caller change.

## Scope

- **MUST NOT** add `user_id` / multi-tenancy columns. Junction is single-user. Multi-user, if ever, is a deliberate additive migration — not a constraint carried now.

## The additive growth path (reference)

Foundation tables: `platforms`, `credentials`, `profiles`, `source_refs`. Future entities are each their own additive migration, in roughly this order: `oauthMeta` (reserved on `Credential`) → `token_refreshes` → `audit_events` (append-only) → `kb_entries` → `minted_tokens`. None of these touch existing rows.
