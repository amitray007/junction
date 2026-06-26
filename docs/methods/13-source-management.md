# Method File 13 — MCP source management + visibility (idea.md goal #1 complete)

> **Make the MCP capability genuinely *organized*.** Today junction is **create-only** — you can `add`/`create`/`add-source` but can't **remove, disable, or inspect** what's wired. This increment completes the management surface (delete/remove-source/enable-disable + a headless `profile show`) and the **visibility** (the dashboard + status reflect real sources and their enabled state) — realizing idea.md §3 goal #1 ("granular access, *organized* by profiles and platforms"). Still source-agnostic; no new source TYPES (that's increment 14).
>
> **Builder:** Sonnet. Security-relevant: removing a credential must delete its secret from the store (no orphan), and RESTRICT must surface as a clean "in use" error (never an orphaned source).

---

## Part 1 — Spec (what & why)

### Goal

Round out the source/profile/credential lifecycle so a user can curate what's connected: remove a source, disable it without deleting, delete a profile/credential/platform safely, and *see* the wiring. Proof: every entity has a full create→inspect→disable→remove lifecycle via CLI (`--json`), the dashboard shows sources + enabled state, and a disabled source stops being served (the proxy already honors `enabled`).

### The gaps being filled (current state)

- **Repos have `delete` (all three) + `platforms.upsert`** but the CLI exposes none. New repo methods needed: `profiles.removeSource`, `profiles.setSourceEnabled`.
- **No enable/disable** — the `SourceRef.enabled` flag is set `true` on add-source and never toggled; the proxy already filters to enabled sources (proxy.ts), so a toggle is meaningful end-to-end.
- **Removing a credential** must also delete its secret from the `CredentialStore` (the reverse of inc-10 `addCredential`) — no orphaned secret.
- **FKs:** `source_refs.platform_id`/`credential_id` are `RESTRICT` → deleting a platform/credential still referenced by a source must fail with a clean "in use by N source(s)" error, not a raw SQLite constraint message. `source_refs` cascade with a profile delete (so `profile delete` cleans up its sources).
- **Visibility:** the dashboard loads profiles/platforms/credential-counts (inc 9) but shows only a profile's *source count*; there's no source-wiring detail and no headless "what's in this profile."

### New CLI surface (all `--json`/headless)

- `junction profile show <name>` — the profile's sources: per SourceRef → `{ namespace, platform, credentialAccount, enabled, toolFilter? }`. **No secret.** The authoritative "what's wired" view.
- `junction profile remove-source --profile <name> --namespace <ns>` — remove one SourceRef.
- `junction profile enable-source` / `disable-source --profile <name> --namespace <ns>` — toggle `enabled` (a disabled source stays configured but isn't served).
- `junction profile delete --name <name>` — delete a profile (its sources cascade).
- `junction credential remove --id <id>` — delete a credential **and** its stored secret; RESTRICT (in use) → clean error.
- `junction platform remove --id <id>` — delete a platform; RESTRICT (in use) → clean error.
- (Out of scope: edit/update beyond the existing `platforms.upsert` — defer per rule-of-three; "edit a credential" = remove + re-add.)

### Visibility (the dashboard + status)

- **TUI dashboard:** enrich the Profiles panel so each profile shows its **source rows** (`namespace · platform · ✓/✗ enabled`) instead of only a count — so bare `junction` *shows* the wiring (and which sources are disabled, dimmed). Keep it read-only, no secret.
- **`status`:** add a one-line summary (e.g. `sources  3 platforms · 2 credentials · 1 profile`). Human + `--json`.

### Security / correctness invariants

- `removeCredential(id, store, repos)` (core helper, reverse of `addCredential`): `credentialsRepo.delete(id)` **and** `store.delete(secretRef)` — on a RESTRICT (in-use) DB error, do NOT delete the secret (the credential still exists/used); return the typed "in-use" error. Order: attempt the DB delete first (it enforces RESTRICT); only on success delete the secret. No secret in any error/log.
- RESTRICT errors map to a typed domain error (e.g. `DbError{kind:"in-use"}` or reuse the constraint classification) → CLI prints "platform/credential <id> is in use by N source(s); remove those first."
- `removeSource`/`setSourceEnabled` are transactional, validate the `(profile, namespace)` exists (else typed not-found), and never touch credentials/secrets.
- `profile show` / dashboard NEVER render a secret (only metadata — account label, namespace, enabled, platform id).

### Proof of done

- `pnpm verify` with tests:
  - Repo: `removeSource` (removes one, leaves others; not-found namespace → typed err); `setSourceEnabled` (toggles; reflected in `get`); `removeCredential` (deletes row + secret resolvable→gone; **in-use credential → RESTRICT typed err, secret NOT deleted**); `platforms.delete` in-use → RESTRICT typed err; `profiles.delete` cascades sources.
  - CLI `--json`: full lifecycle — create→add-source→`show`(source listed, enabled)→`disable-source`→`show`(enabled:false)→`remove-source`→`show`(gone); `credential remove` of an unused cred (gone, secret gone) vs an in-use cred (clean "in use" error, exit≠0); `platform remove` in-use error. **A `profile show`/`credential` output scan asserts NO secret appears.**
  - **End-to-end enable/disable:** a profile with a source; `disable-source`; the proxy `listTools` (via createProfileProxy, in-memory) returns NO tools from the disabled source; `enable-source` → tools return. (Proves the toggle is honored end-to-end.)
  - TUI: dashboard renders a profile's source rows + enabled state (ink-testing-library, seeded); disabled source shown distinctly; no secret.
- `pnpm build`; `pnpm depcruise` clean (cli→core; no new edges); `pnpm quality`. SPDX; CI green.
- **MANUAL QA (orchestrator):** against a temp home — create a profile + a (local stdio) source, `profile show`, `disable-source`, confirm the served tool list drops it, `enable-source`, `remove-source`, `credential remove` (in-use error then after remove-source succeeds), `platform remove`. Dashboard shows the wiring.

### Out of scope

- New source TYPES (OpenAPI/GraphQL/CLI — increment 14). Edit/update flows (rule-of-three). Guided `junction connect` wizard (can come with/after; not required for "organized"). Bulk ops. The knowledge-base/catalog of tool descriptions (goal #2/#7 — later). Web UI.

---

## Part 2 — Implementation

### Step 1 — repo methods

`repositories/profiles.ts`: `removeSource(profileId, toolNamespace)` (transactional delete of the one `source_ref`; not-found → typed err) and `setSourceEnabled(profileId, toolNamespace, enabled)` (update the row; not-found → typed err). Reuse the inc-5 transaction + `mapDbError`. `delete` already exists for all three; confirm `profiles.delete` cascades source_refs (FK cascade) — add a test.

### Step 2 — `removeCredential` helper + RESTRICT mapping

`credentials/` (mirror inc-10 `addCredential`): `removeCredential(id, store, repos): ResultAsync<void, …>` — `credentialsRepo.delete(id)` first (enforces RESTRICT); on success `store.delete(secretRef)` (need the secretRef → fetch the row before delete, or have delete return it). On RESTRICT (in-use), return the typed in-use error and DO NOT touch the store. Ensure `mapDbError` classifies the RESTRICT/foreign-key constraint to a typed `in-use` (or equivalent) kind for platforms + credentials (check the inc-5 `mapDbError` by SQLITE_CONSTRAINT code). No secret in any error.

### Step 3 — CLI commands

`commands/profile.ts`: add `show`, `remove-source`, `enable-source`, `disable-source`, `delete`. `commands/credential.ts`: add `remove` (calls `removeCredential`). `commands/platform.ts`: add `remove`. All `--json`; exhaustive error formatters incl. the in-use message; `exitCode`+return on `--json` error paths (not `process.exit`). Thin edges → core. `profile show` builds the source view by joining SourceRef → platform id + credential account (via repos) — **never the secret**.

### Step 4 — visibility

`tui/data.ts`: enrich `DashboardProfile` with its sources (`{namespace, platformId, enabled}[]` — no secret); `ProfilesPanel.tsx`: render source rows (namespace · platform · enabled glyph), disabled dimmed. `commands/status.ts`: add the counts summary (human + `--json`). Keep stdout/secret discipline.

### Step 5 — tests + skill

Per Proof-of-done (repo CRUD + in-use RESTRICT + secret-cleanup; CLI lifecycle + no-secret scan; end-to-end enable/disable through the proxy; TUI source rows). Update `.claude/skills/junction-dev` with the management commands.

### Step 6 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` + `pnpm build`. SPDX. Commit; push; PR base main: "feat: MCP source management — remove/enable/disable/show + visibility (increment 13)".

---

## Review (background, after build)

- **`junction-credential-security`** (a credential-removal path): `removeCredential` deletes the secret on success AND only on success (RESTRICT → secret retained); no secret in `show`/error/log; in-use credential can't be silently orphaned.
- **`ce-data-migration-reviewer`**: no new migration expected (no schema change); confirm the RESTRICT/cascade behavior is exercised + that delete paths are transactional + safe on real data.
- **`junction-mcp-contract`**: disabled source is NOT served (the proxy honors `enabled` end-to-end); `profile show` reflects the true wiring.
- Junction `junction-clean-code-reviewer` + `junction-package-boundary` (thin edges, cli→core, no secret). `junction-tui` (the dashboard source-row rendering, headless-path intact, no secret). CE: `ce-correctness-reviewer` (the delete/restrict/secret-cleanup ordering, removeSource/setSourceEnabled), `ce-testing-reviewer` (the in-use + secret-cleanup + enable/disable-through-proxy coverage).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** copy-paste the full lifecycle (create → add-source → `profile show` → `disable-source` → served list drops it → `remove-source` → `credential remove`), and bare `junction` shows the source rows + enabled state. **QA'd by me:** drove the lifecycle against a temp home + a local stdio source; confirmed disable actually stops a tool being served; confirmed `credential remove` deletes the secret (resolves→gone) and an in-use cred gives a clean error (no orphan); no secret in any output. **Checklist:** full CRUD (remove/delete) + enable/disable, removeCredential secret-cleanup, RESTRICT→clean in-use error (no orphaned source), disabled-source-not-served end-to-end, dashboard source rows + enabled state, no-secret-rendered, --json everywhere.

## User test gate

`pnpm build`, then (build on the everything-demo setup you already tested):
```bash
JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js profile show --name test --json     # see the source wiring (no secret)
JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js profile disable-source --profile test --namespace demo
# re-run mcp serve / the inspector → demo__* tools gone
JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js profile enable-source --profile test --namespace demo   # back
JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js profile remove-source --profile test --namespace demo
JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js credential remove --id <cid>   # now succeeds (no longer in use)
JUNCTION_HOME=/tmp/jtest node packages/cli/dist/index.js                                 # bare → dashboard shows the wiring
```
Approve → increment 14 (OpenAPI/REST source type — the "any source" breadth), then Web UI, then OAuth (your sequence).
