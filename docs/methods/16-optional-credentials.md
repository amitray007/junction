# Method File 16 — Optional credentials (public / no-auth sources)

> **Be open-minded about what a source needs.** Not every source requires a credential — public MCP servers and public/read-only REST APIs (and many OpenAPI specs) need none. junction currently *forces* one: `SourceRef.credentialId` is required. This increment makes it **optional**, source-agnostic, so a no-auth source connects with no credential. The pleasant truth: the execution layer **already supports it** (both providers take `secret: string | null`; OpenAPI's `injectAuth` already short-circuits on `null`; the `auth` descriptors are already optional) — the only artifact forcing a credential is the `SourceRef` schema + DB column. This is a small, contained change, not a rework.
>
> **Builder:** Sonnet. The one careful part is the migration (SQLite must rebuild `source_refs` to drop `NOT NULL` while preserving data + the RESTRICT FK).

---

## Part 1 — Spec (what & why)

### Goal

Allow a `SourceRef` with **no credential**: the proxy resolves `secret = null`, the provider connects without auth. Works for MCP (stdio/http) and OpenAPI alike (source-agnostic). Proof: a public source (no `--credential`) is created, served, and an agent lists + calls its tools with no credential involved — while credentialed sources behave exactly as before.

### What's already there vs the one gap

- **Already supports no-auth (verified):** `createMcpProvider(connection, secret: string|null)`, `createOpenApiProvider(connection, secret: string|null)`; OpenAPI `injectAuth`: `if (!auth || secret === null) return`; `McpConnection.auth`/`OpenApiConnection.auth` are `.optional()`.
- **The only gap:** `SourceRef.credentialId` is required (`CredentialIdSchema`, no `.optional()`) and the DB `source_refs.credential_id` is `.notNull()`. The cli `resolveProvider` always does `credentials.get(sourceRef.credentialId)` → `store.get` → secret. CLI `profile add-source --credential` is required; `profile show` always resolves the account.

### The change (source-agnostic)

1. **Schema:** `SourceRef.credentialId` → `CredentialIdSchema.optional()`. (Stays a branded ID when present.)
2. **DB:** `source_refs.credential_id` → **nullable** (drop `.notNull()`); keep the **RESTRICT FK** (NULL is FK-exempt, so it still protects credentials that *are* referenced). **Migration 0004** — SQLite cannot `ALTER COLUMN` to drop `NOT NULL`, so drizzle-kit will generate a **table-recreate** (create new `source_refs` with the nullable column + same FKs/indexes, `INSERT … SELECT` to preserve rows, drop old, rename). All existing rows have a non-null credential_id → widening is safe.
3. **Resolver (`cli/commands/mcp.ts` `resolveProvider`):** if `sourceRef.credentialId` is **absent/undefined** → `secret = null`, **skip** `credentials.get` + `store.get` entirely → pass `null` to the provider (already handled). If **present** → resolve exactly as today (credential-not-found or store-fail → skip the source with the existing stderr note).
4. **CLI:** `profile add-source --credential` becomes **optional** (omit → a no-credential source). `debug mcp-probe --credential` becomes **optional** too (probe a public source). `addSource` repo accepts an optional `credentialId` (insert NULL when absent; FK validation only applies when present).
5. **Honest UX (nice, keep it):** if a source's Platform **connection declares auth** (`McpConnection.auth` present, or `OpenApiConnection.auth` present) but the SourceRef has **no credential**, emit a **stderr warning** at `add-source` and at serve ("source `<ns>`: platform `<id>` declares auth but no credential is attached — calls may be unauthorized"). Permissive (still works), but not silent.
6. **Visibility:** `profile show` + the TUI dashboard show `account = "(none)"`/`public` for a credential-less source (don't call `credentials.get`; no secret regardless). `status` counts unaffected.

### Invariants preserved

- **Credentialed sources are byte-identical** — present credentialId path unchanged (resolve → inject).
- **RESTRICT still holds** — you still can't delete a credential that a source references (FK on the non-null values). A no-credential source simply has no such link.
- **No secret anywhere** — unchanged; a null secret means no auth header, never a leak.
- **Multi-account wedge intact** — optional ≠ removed; a source can still attach any of N credentials; a public one attaches none.

### Proof of done

- `pnpm verify` with tests:
  - Schema: `SourceRef` parses with and without `credentialId`.
  - Repo: `addSource` with no `credentialId` → row with NULL credential_id; `addSource` WITH a (valid/invalid) credentialId → FK-validated as before; `profile.get`/reconstruct handles a NULL credential_id (no crash). The RESTRICT FK still blocks deleting a referenced credential (and a no-credential source doesn't reference one).
  - **Resolver/proxy no-auth path:** a `resolveProvider` over a credential-less SourceRef → builds the provider with `secret = null` (no `store.get` called); an MCP **and** an OpenAPI no-credential source both list/call (in-memory MCP server with no auth; OpenAPI `injectAuth` adds no header — assert NO auth header sent).
  - CLI: `profile add-source` without `--credential` → a no-credential source; `profile show` shows `account: "(none)"` (no secret); `debug mcp-probe` without `--credential` probes a public source. The auth-declared-but-no-credential **warning** fires (stderr).
  - **Migration 0004** recreates `source_refs` preserving existing rows + the RESTRICT FK + the `(profile_id, tool_namespace)` unique index; applies on 0000-0003 with data; a NULL credential_id round-trips.
- `pnpm build`; `pnpm depcruise` clean; `pnpm quality`. SPDX (`AGPL-3.0-only`); CI green.
- **MANUAL QA (orchestrator) — a real PUBLIC source, no credential:** stand up a local OpenAPI server **without** auth (or a no-auth MCP source); `platform add` it; `profile create` + `profile add-source --profile … --platform … --namespace …` (**no `--credential`**); `debug mcp-probe --platform … ` (no credential) → lists the tools; drive a call → real response, **no credential involved**. Confirm a credentialed source still works unchanged.

### Out of scope

- Removing/changing the credential model where one IS used (unchanged). Per-source auth *override* beyond the platform descriptor. Large-spec selection (now increment 17). GraphQL (18). Web UI / OAuth.

---

## Part 2 — Implementation

### Step 1 — schema + migration

`schema/source-ref.ts`: `credentialId: CredentialIdSchema.optional()`. `db/schema.ts`: drop `.notNull()` on `source_refs.credential_id` (keep the `.references(..., {onDelete:"restrict"})`). Generate **migration 0004** via drizzle-kit (it will recreate the table — verify the generated SQL preserves the FKs/cascade/restrict + the unique index + copies data; snapshot included; dist packaging). Repos: `addSource` accepts `credentialId?`; insert NULL when absent. `reconstructProfile`/`get` map a NULL DB value → `credentialId: undefined` and Zod-validate.

### Step 2 — resolver no-auth path

`commands/mcp.ts` `resolveProvider`: branch — `sourceRef.credentialId === undefined` → `secret = null`, skip `credentials.get`/`store.get`, build the provider (mcp or openapi) with `secret = null`. Present → unchanged path. Add the auth-declared-but-no-credential stderr warning (check the platform's `connection`/`openapi` for an `auth` field).

### Step 3 — CLI

`commands/profile.ts` `add-source`: make `--credential` optional; pass `credentialId` only when given; if given but not found → the existing not-found error. `profile show`: when a SourceRef has no `credentialId` → `account: "(none)"` (skip `credentials.get`). `commands/debug.ts` `mcp-probe`: make `--credential` optional → `secret = null`. `tui/data.ts`/`ProfilesPanel`: show `(none)` account for credential-less sources. All `--json`; no secret.

### Step 4 — tests + skill

Per Proof-of-done (schema both-ways; addSource NULL; resolver null-secret for MCP + OpenAPI with NO auth header asserted; FK-still-restricts; migration 0004 data-preservation; CLI no-credential lifecycle + the warning; `profile show "(none)"`). Update `junction-dev` skill (add-source/`mcp-probe` without a credential; public sources).

### Step 5 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` + `pnpm build` (migration 0004 + snapshot in dist). SPDX. Commit; push; PR base main: "feat: optional credentials — public/no-auth sources (increment 16)".

---

## Review (background, after build)

- **`ce-data-migration-reviewer`** (the load-bearing part): migration 0004 recreates `source_refs` — verify it preserves ALL existing rows, the RESTRICT FK on credential_id (still blocks deleting a referenced credential), the CASCADE FK on profile_id, the platform_id RESTRICT, and the `(profile_id, tool_namespace)` unique index; applies cleanly on 0000-0003 with real data; NULL round-trips; no data loss in the rebuild.
- **`junction-credential-security`**: the null-secret path is genuinely no-auth (no `store.get`, no header injected, no secret materialized); a present credential still resolves + injects as before; no secret in `profile show`/dashboard/`(none)` display.
- **`junction-mcp-contract`**: a no-credential source lists/calls correctly (MCP + OpenAPI); the auth-declared-but-no-credential warning is informative, not blocking; credentialed sources unchanged.
- Junction `junction-clean-code-reviewer` + `junction-package-boundary` (thin edges, cli→core, optional plumbing); `ce-correctness-reviewer` (the optional-credentialId branches everywhere it's read: resolver, addSource, profile show, dashboard, FK-validation-when-present). `junction-tui` (the `(none)` account rendering).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** create a public source with NO `--credential`, `profile show` it (account `(none)`), `debug mcp-probe` it (no credential) → tools listed, a call returns a real response with no credential involved; a credentialed source still works unchanged. **QA'd by me:** drove a real public (no-auth) OpenAPI/MCP source end-to-end with no credential; confirmed no `store.get`/no auth header on the null path; confirmed the RESTRICT FK still blocks deleting a referenced credential; migration 0004 preserves existing data + FKs + the unique index; reviews addressed. **Checklist:** `SourceRef.credentialId` optional, migration 0004 (nullable + FK/index/data preserved), resolver null-secret no-auth path (MCP + OpenAPI), `--credential` optional on add-source + mcp-probe, auth-declared-but-no-credential warning, `profile show`/dashboard `(none)`, credentialed sources byte-identical, RESTRICT-FK + multi-account-wedge intact, no secret anywhere.

## User test gate

`pnpm build`, then a public REST API (no auth) — e.g. a public OpenAPI spec, or your own no-auth local server:
```bash
JUNCTION_HOME=/tmp/jt16 node packages/cli/dist/index.js init
JUNCTION_HOME=/tmp/jt16 node packages/cli/dist/index.js platform add --id pub --kind openapi --display-name "Public API" --spec-url <some-no-auth-openapi-spec-url>
JUNCTION_HOME=/tmp/jt16 node packages/cli/dist/index.js profile create --name p
JUNCTION_HOME=/tmp/jt16 node packages/cli/dist/index.js profile add-source --profile p --platform pub --namespace pub   # NO --credential
JUNCTION_HOME=/tmp/jt16 node packages/cli/dist/index.js profile show --name p --json                                    # account: "(none)"
JUNCTION_HOME=/tmp/jt16 node packages/cli/dist/index.js debug mcp-probe --platform pub                                   # NO --credential → lists tools
```
Approve → increment 17 (large-spec `--tag/--path` selection + `platform refresh`), then GraphQL, Web UI, OAuth.
