# Method File 10 — Generic MCP-Source Create/Mutate Ops (Wedge increment A)

> **First feature increment. Source-AGNOSTIC by construction.** Adds a **generic MCP connection descriptor** to `Platform`, generic per-source **tool filtering** to `SourceRef`, the **create/mutate operations** (no `create` ops existed — only `profile list`), and **CLI primitives** so a user can define *any* MCP source (remote HTTP URL **or** local stdio command) + a bearer credential + a profile that activates it. **GitHub is only example DATA** typed into these generic commands — there is **no GitHub-specific code anywhere** (the design forbids `if (platform === "github")`). State-only: no upstream calls yet (that's increment B = `mcp/client`).
>
> **Builder:** Sonnet. This is the wedge's foundation — keep it generic; GitHub/Linear/anything are just rows.

---

## Part 1 — Spec (what & why)

### Goal

Make junction able to *record* an arbitrary MCP source and activate it in a profile, end to end, via CLI — so the later increments (B: connect, C: proxy) have something concrete to operate on. Realizes the "any source, any credential pattern, profiled" promise (idea.md §1). Proof: a user creates a Platform describing an MCP source (e.g. GitHub's remote MCP URL), adds a bearer Credential (token stored encrypted), and adds a SourceRef to a Profile — all via generic `--json` CLI commands, persisted, with zero source-specific code.

### Source-agnostic principle (load-bearing — the reviewer checks this)

- **Nothing in `core` knows what "github" is.** A Platform is *data*: an id, a kind, a display name, and (for `kind: "mcp"`) a generic **connection descriptor**. The connection descriptor models *transport*, not vendor.
- **Two generic transports** (a discriminated union — any MCP source fits one):
  - `http` — a remote MCP server: a `url` + optional generic bearer auth (which header carries the token). *Primary* (the universal "point junction at an MCP URL" pattern; user's choice).
  - `stdio` — a local MCP server: a `command` + `args` + the env var the token is injected into. Supported equally; for local-binary sources.
- **Generic tool filtering** replaces any vendor "toolset" notion: an optional per-source `allow`/`deny` list of upstream tool names. Absent = expose all (user's "full by default"). Applied uniformly to every source in increment C.
- **Bearer credential pattern** (user's PAT-first choice) is generic: a token the user provides, stored via `CredentialStore`, injected later as a header (http) or env (stdio). `oauth2` stays the reserved later pattern (increment E).

### Schema additions (additive — `z.object` strips unknowns; new migration, forward-only)

**`Platform.connection` (optional):**
```ts
export const McpConnectionSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    // generic bearer injection: the header the token rides in (default Authorization: Bearer <t>)
    auth: z.object({ scheme: z.literal("bearer"), header: z.string().min(1).default("Authorization") }).optional(),
  }),
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    tokenEnvVar: z.string().min(1).optional(), // env var the token is injected into
  }),
])
// Platform gains: connection: McpConnectionSchema.optional()  (meaningful when kind === "mcp")
```
**`SourceRef.toolFilter` (optional, generic):**
```ts
toolFilter: z.object({
  allow: z.array(z.string()).optional(), // if set, ONLY these upstream tool names are exposed
  deny: z.array(z.string()).optional(),  // these upstream tool names are hidden
}).optional() // absent = expose all
```
- **DB:** add a `connection` JSON/text column to `platforms` and a `tool_filter` JSON/text column to `source_refs`, via a **new forward-only migration `0001`** (the foundation's `0000` is merged/applied now — do NOT regenerate it; add `0001` additive). Validate JSON columns with Zod on read (boundary validation).

### Create/mutate operations (the gap — only `list`/`get`/`create`/`delete` exist; `profile.create` takes a whole Profile)

- `platformsRepo.upsert(platform)` — create-or-replace a Platform incl. its `connection` (a source is defined once, may be edited).
- **Credential capture:** a `core` helper `addCredential({ platformId, account, kind:"bearer", secret }, store, repos): ResultAsync<Credential, …>` that: mints a `secretRef` (ULID), `CredentialStore.set(secretRef, secret)`, then `credentialsRepo.create({ platformId, profileName: account, kind, secretRef })` — **in that order**, and on the DB-create failing, best-effort `store.delete(secretRef)` (no orphaned secret). The plaintext `secret` lives only in this call's memory; never logged/returned.
- `profilesRepo.addSource(profileId, sourceRef)` — append a `SourceRef` to an existing Profile (transactional; validates the platformId + credentialId exist via FK; rejects a duplicate `toolNamespace` within the profile). (Today `profile.create` only takes a whole Profile — this is the missing incremental mutation.)
- Reuse the inc-5 transaction + `mapDbError` discipline; Result-returning; typed errors.

### CLI primitives (generic, every one with a `--json`/headless path)

- `junction platform add` — define an MCP source. Flags: `--id`, `--kind mcp` (default), `--display-name`, `--transport http|stdio`, and transport-specific: `--url` (+ `--auth-header`) **or** `--command`/`--arg` (repeatable) (+ `--token-env`). Validates via `PlatformSchema`. `junction platform list [--json]` (extend/mirror `profile list`).
- `junction credential add` — `--platform`, `--account <label>`, `--kind bearer` (default). Token input: interactive **masked** `@clack/prompts` password prompt, **or** `--token-stdin` (read from stdin) for headless/agents. Stores via `addCredential`. **Never echoes the token; never prints it back.** `junction credential list --platform <id> [--json]` shows metadata only (account, kind, id — **never the secret**).
- `junction profile add-source` — `--profile`, `--platform`, `--credential`, `--namespace <toolNamespace>`, optional `--allow <tool>` / `--deny <tool>` (repeatable) → builds `toolFilter`. Appends the SourceRef. `--json`.
- These compose into the guided `junction connect` flow later (increment D); keep them as clean primitives now.

### Proof of done

- `pnpm verify` with tests:
  - Schema: `McpConnectionSchema` http+stdio parse/reject (bad url, missing command); `Platform` with/without `connection`; `SourceRef` with `toolFilter`.
  - Repos: `platforms.upsert` round-trips the connection; `addCredential` stores the secret in the CredentialStore (resolvable) AND persists a Credential row holding only the `secretRef` (**a whole-DB scan finds no token**); orphan-cleanup when the DB-create fails; `profiles.addSource` appends + rejects duplicate namespace + FK-validates.
  - Migration `0001` applies cleanly on top of `0000` (and a fresh DB → both); existing rows survive.
  - CLI: `platform add` (http + stdio) → `platform list --json` shows the connection; `credential add --token-stdin` → `credential list --json` shows metadata, **no token**; `profile add-source` → the profile reflects the SourceRef. **A test pipes a known token via `--token-stdin` and asserts it appears in NO command output and NO DB column** (only in the CredentialStore).
- `pnpm build`; the built commands work end-to-end against a temp `JUNCTION_HOME`; `pnpm depcruise` clean; `pnpm quality`. SPDX; committed; CI green.

### Out of scope (later wedge increments)

- **No upstream connection / no `mcp/client`** (increment B). No proxying / `deriveToolsFromProfile` wiring (increment C). No guided `connect` wizard (D). No OAuth (E). No built-in platform catalog/presets (GitHub is user-entered data, not a seed — keeps it source-agnostic; a preset registry, if ever, is later optional data). No edit/remove-source UX beyond `upsert` (rule-of-three).

---

## Part 2 — Implementation

### Step 1 — schema (generic, additive)

`packages/core/src/schema/`: add `McpConnectionSchema` (new file `mcp-connection.ts` or in `platform.ts`); add `connection: McpConnectionSchema.optional()` to `PlatformSchema`; add `toolFilter` to `SourceRefSchema`. Export from the schema barrel. Keep the discriminated union strict (`transport` discriminant). NO vendor fields.

### Step 2 — DB migration 0001 (forward-only, additive)

`packages/core/src/db/schema.ts`: add `connection` (text/JSON) to `platforms`, `tool_filter` (text/JSON) to `source_refs`. Generate migration **`0001`** via drizzle-kit (do NOT touch `0000`). Repos serialize/deserialize the JSON columns and **validate with Zod on read** (`McpConnectionSchema`/`toolFilter`). Confirm migrations are packaged into `dist` (the inc-5 gotcha).

### Step 3 — repos + the credential helper

`repositories/`: `platforms.upsert`; `profiles.addSource(profileId, sourceRef)` (transaction, duplicate-namespace guard, FK validation → typed errors via `mapDbError`). `credentials/` (or a `core` service): `addCredential(...)` orchestrating `store.set` → `credentialsRepo.create` with orphan cleanup. All `ResultAsync`. Add any new error kinds to `errors/index.ts` (e.g. `profile add-source` duplicate-namespace → a `ProfileError`/`DbError` variant). NO secret in any error `cause`.

### Step 4 — CLI primitives

`packages/cli/src/commands/`: `platform.ts` (`add` + `list`), `credential.ts` (`add` with masked clack prompt + `--token-stdin`, `list` metadata-only), extend `profile.ts` with `add-source`. Register in the citty root. Thin edges → call core. `--json` on every path. **Token discipline:** read masked/stdin, pass straight to `addCredential`, never echo, never include in `--json` output or errors. Reuse `formatDbError`-style exhaustive formatters.

### Step 5 — tests + skill

Vitest alongside: schema parse/reject, repo round-trips + the **no-token-in-DB** scan, migration apply, CLI `--json` + the **token-never-printed** assertion (pipe a sentinel token, grep all output). Update `.claude/skills/junction-dev` with the new commands (incl. a GitHub *example* invocation — as documentation, not code).

### Step 6 — verify, build, commit

`pnpm verify` + `pnpm quality` + `pnpm depcruise` (clean; cli→core only) + `pnpm build`; drive the built commands. SPDX. Commit; push; PR base main: "feat: generic MCP-source create/mutate ops + connection descriptor (wedge A / increment 10)".

---

## Review (background, after build)

- **Junction `junction-clean-code-reviewer` + `junction-package-boundary`** (always): thin edges, Result discipline, cli→core, narrow barrels, SPDX, no `fs.*Sync` in core.
- **`junction-credential-security`** (re-activate — it's a credential path): the token flows masked/stdin → `CredentialStore` → only a `secretRef` in the DB; **no token in argv/`--json`/logs/errors/DB columns**; orphan-cleanup on failure; `credential list` shows no secret.
- **Source-agnostic audit (call it out to the reviewers + `ce-architecture-strategist`):** confirm **zero** vendor/GitHub-specific code — `grep -ri github packages/{core,cli,mcp}/src` should hit only test fixtures/example strings, never control flow. The connection descriptor + tool filter are generic.
- CE: `ce-correctness-reviewer` (the upsert/add-source/credential-orphan logic, FK + duplicate-namespace), `ce-data-migration-reviewer` (the `0001` additive migration — applies on existing `0000` data, no destructive change), `ce-testing-reviewer` (the no-token scans + migration coverage).
- Then `/ce-simplify-code`.

## End-of-increment report (per CLAUDE.md)

**Visually testable — YES:** copy-paste commands creating a (generic) MCP-source Platform + a bearer Credential + a Profile SourceRef against a temp home, all `--json`; show `platform list`/`credential list`/the profile reflecting it, and that the token never appears. **QA'd by me:** drove the built commands; whole-DB scan finds no token (only the CredentialStore has it); migration `0001` applies on `0000`; the source-agnostic grep is clean. **Checklist:** generic connection descriptor (http+stdio, no vendor code), generic tool filter, bearer credential via CredentialStore (secrets-as-references), `addSource` transactional + duplicate-namespace guard, additive migration, token-never-printed, --json everywhere.

## User test gate

`pnpm build`, then (GitHub as *example* data — any MCP URL works):
```bash
JUNCTION_HOME=/tmp/jt10 node packages/cli/dist/index.js init
# define GitHub's remote MCP as a generic http source:
JUNCTION_HOME=/tmp/jt10 node packages/cli/dist/index.js platform add --id github --kind mcp \
  --display-name "GitHub" --transport http --url https://api.githubcopilot.com/mcp/ --auth-header Authorization
# add a work credential (paste or pipe a token):
echo "<your-token>" | JUNCTION_HOME=/tmp/jt10 node packages/cli/dist/index.js credential add --platform github --account work --kind bearer --token-stdin
JUNCTION_HOME=/tmp/jt10 node packages/cli/dist/index.js credential list --platform github --json   # metadata only, no token
JUNCTION_HOME=/tmp/jt10 node packages/cli/dist/index.js platform list --json
rm -rf /tmp/jt10
```
Approve → increment B (`mcp/client`: actually connect to that source and list its namespaced tools).
