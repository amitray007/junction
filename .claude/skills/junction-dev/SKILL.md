---
name: junction-dev
description: How to run, build, and test junction. Use when starting work on junction, running the CLI, building packages, running tests, or setting up the dev environment. Grows as each increment adds runnable surface.
---

# Junction Dev

How to work on junction locally. This skill grows per increment — update it whenever a new runnable surface lands.

## Prerequisites

- **Node 22 LTS** (floor: Node 20). ESM-only repo.
- **pnpm** (workspace manager).

## Core commands

```bash
pnpm install            # install workspace deps
pnpm verify             # THE gate: typecheck + Biome + Vitest. Run before every commit.
pnpm test               # Vitest (watch)
pnpm test:related       # Vitest, only tests affected by changed files (fast loop)
pnpm lint               # Biome check
pnpm format             # Biome format --write
pnpm build              # tsdown build all packages
```

Per-package (once packages exist):

```bash
pnpm -F @junction/core test
pnpm -F @junction/core build
```

## Config home

- Junction's home is `~/.junction` (override with `JUNCTION_HOME`).
- **In tests, always set `JUNCTION_HOME=<tmpdir>`** to isolate filesystem state.

## CLI (once increment 3 lands)

```bash
pnpm -F junction dev -- <args>      # run the CLI in dev
# or after build:
node packages/cli/dist/index.js <args>
junction init                        # create the home + default config
junction status                      # print state (supports --json)
```

## Persistence (increment 5)

The DB lives at `~/.junction/junction.db` (SQLite, via Drizzle + better-sqlite3),
created and migrated on first use (`junction init` or the first `profile` command).

```bash
junction profile list                # list profiles (empty on a fresh home)
junction profile list --json         # machine-readable JSON array
```

- Persistence (Drizzle schema, migrations, repository layer) lives in `@junction/core` only; the CLI edge is thin.
- Migrations are committed + forward-only under `packages/core/src/db/migrations/` and copied into `dist/` at build so the built CLI can migrate a fresh DB.

## Platforms, credentials, and profile sources (increment 10)

Define a generic MCP source platform, add a bearer credential, and wire a profile source:

```bash
# Define a remote (http) MCP source:
JUNCTION_HOME=/tmp/jt10 junction platform add \
  --id my-server --display-name "My Server" \
  --transport http --url https://api.example.com/mcp/ \
  --auth-header Authorization --json

# Define a local (stdio) MCP source:
JUNCTION_HOME=/tmp/jt10 junction platform add \
  --id local-mcp --display-name "Local MCP" \
  --transport stdio --command npx \
  --arg "-y" --arg "some-mcp-package" \
  --token-env MY_TOKEN --json

# List all platforms:
junction platform list --json

# Add a bearer credential (reads token from stdin — never echoed):
echo "<token>" | junction credential add \
  --platform my-server --account work --kind bearer --token-stdin --json

# List credentials for a platform (metadata only — never secretRef or secret):
junction credential list --platform my-server --json

# Add an MCP source to a profile (profile must already exist):
junction profile add-source \
  --profile default --platform my-server \
  --credential <credential-id> --namespace mcp_work \
  --allow list_tools --allow get_info \   # optional tool filter (repeatable)
  --json
```

**Token security invariants (enforced by tests):**
- The token NEVER appears in any command stdout or stderr.
- A whole-DB scan (`readFile(dbPath).toString("utf8")`) finds NO trace of the token.
- `credential list` emits metadata only: `id`, `platformId`, `account`, `kind` — never `secretRef`.

**Source-agnostic:** platforms are generic data rows. No `if (platform === "github")` logic
anywhere in `core`/`cli`/`mcp`. `grep -ri github packages/core/src packages/cli/src packages/mcp`
must hit only comments and example strings.

**Override credential store backend** (useful in tests/CI — avoids keyring access):
```bash
JUNCTION_STORE=file junction credential add ...   # use AES-256-GCM encrypted file store
```

## Debug a source — probe + call (increment 11, generalized in 17)

`junction debug probe` connects to **any** source (MCP or OpenAPI), lists tools, and prints
both raw and **namespaced** names (`<namespace>__<tool>`). `junction debug call` invokes a
single tool against any source and prints the result. Secret/URL never appear in output.
`--credential` is optional (omit for public/no-auth sources). Both have `--json`.

```bash
# List credentials to find the credential ID:
JUNCTION_HOME=/tmp/jt10 junction credential list --platform github --json

# Probe any upstream source (replace <id> with the credential id; omit --credential if public):
JUNCTION_HOME=/tmp/jt10 junction debug probe \
  --platform github --credential <id>
# → github_work__list_issues  (raw: list_issues), ... + count

# Machine-readable:
JUNCTION_HOME=/tmp/jt10 junction debug probe --platform github --credential <id> --json
# → {"ok":true,"namespace":"github_work","count":N,"tools":[{"raw":"...","namespaced":"..."}]}

# Invoke one tool (raw upstream name) against the source:
JUNCTION_HOME=/tmp/jt10 junction debug call \
  --platform github --credential <id> --tool list_issues --args '{"state":"open"}'
# → {"ok":true,"content":[{"type":"text","text":"..."}],"isError":false}
```

**Security invariants (enforced by tests):**
- The bearer token NEVER appears in stdout, stderr, or any error message.
- The probe prints only tool names and counts — no credential values.
- The namespace is derived from `{platformId}_{credentialAccount}` (e.g. `github_work`).

**Source-agnostic:** `mcp-client` knows transports (http / stdio), not vendors.
`grep -rin github packages/mcp/client/src` must hit only comments and test examples —
never control flow or hardcoded URLs/tool names.

## MCP server (increment 7)

`junction mcp serve` speaks MCP over stdio — point any MCP client at it.

```bash
# Serve the synthetic default profile (no DB needed):
junction mcp serve

# Serve a named profile from the DB:
junction mcp serve --profile work

# Manual MCP handshake smoke test (initialize + tools/list):
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | JUNCTION_HOME=/tmp/jt node packages/cli/dist/index.js mcp serve
# → initialize result + {"result":{"tools":[]},...}
```

**CRITICAL:** stdout is the MCP channel — nothing except JSON-RPC frames may appear on stdout.
Human-readable output always goes to stderr.

## Profile proxy — full agent tool call (increment 12)

`junction profile create` creates a named profile. `junction mcp serve --profile <name>` then
serves it as a real proxy: namespaced tools (`<namespace>__<tool>`) are returned to agents, and
tool calls are proxied upstream with the credential injected at call-time. The credential never
reaches the agent.

```bash
# Create a named profile:
junction profile create --name work --json
# → {"ok":true,"id":"profile-work","name":"work","mcpEndpointPath":"/mcp/work"}

# Full end-to-end flow (add platform + credential + source + serve):
JUNCTION_HOME=/tmp/jt12 junction init --json
JUNCTION_HOME=/tmp/jt12 junction platform add \
  --id my-server --display-name "My Server" \
  --transport http --url https://api.example.com/mcp/ \
  --auth-header Authorization --json
echo "my-bearer-token" | JUNCTION_HOME=/tmp/jt12 junction credential add \
  --platform my-server --account work --kind bearer --token-stdin --json
JUNCTION_HOME=/tmp/jt12 junction profile create --name work --json
JUNCTION_HOME=/tmp/jt12 junction profile add-source \
  --profile work --platform my-server --credential <credential-id> --namespace srv --json

# Serve (proxy mode — tools come from the upstream MCP source):
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"srv__some_tool","arguments":{}}}' \
  | JUNCTION_HOME=/tmp/jt12 node packages/cli/dist/index.js mcp serve --profile work
# → tools/list returns ["srv__<tool>", ...]; tools/call proxies upstream and returns the result
```

**Architecture (injection, boundary-preserving):**
- `mcp/server` takes injected `McpServerHandlers { listTools, callTool }` — it knows nothing about credentials.
- `mcp/client` exports `createProfileProxy(sources, resolveSource)` — it knows nothing about the DB.
- The **cli** is the composition root: it builds `resolveSource` (from repos + credential store),
  creates the proxy, adapts `ResultAsync` → `Promise`, and passes the handlers to `serveStdio`.
- Boundary: `mcp/server → core only`; `mcp/client → core only`; `cli → core + both mcp packages`.
  `depcruise` enforces this; do **not** edit `.dependency-cruiser.cjs` to add `mcp/server → mcp/client`.

**Per-source resilience:** `listTools` always returns Ok — failing sources are silently skipped.
`callTool` propagates errors as safe MCP error responses (no secret in the message).

**Credential discipline:** the secret flows `resolveSource → sessionFactory → transport` only.
It is never stored on the proxy, never returned in any result, error, or log.
`safeUpstreamMessage` (exported from `@junction/mcp-server`, used in cli) maps errors to safe strings.

**toolFilter:** `allow`/`deny` lists on a source are applied to UPSTREAM tool names (the part
after `__`). Set via `profile add-source --allow <tool> --deny <tool>` (repeatable flags).

## Enforcement

- Git hooks (lefthook) run `pnpm verify` pre-commit — a failing verify blocks the commit.
- Claude Code hooks (`.claude/settings.json`) format on edit and guard package boundaries.
- See `docs/rules/` for the coding rules and `docs/workflow.md` for the per-increment loop.

## TUI dashboard (increment 9)

Bare `junction` in an interactive terminal launches the full-screen Ink TUI dashboard.
The TUI shows three panels (Status / Profiles / Platforms), is keyboard-driven, and exits
cleanly with `q`. Use Tab to move between panels, ↑/↓ or j/k to navigate within a panel,
`r` to reload live data.

```bash
# Interactive TUI — only in a real TTY:
junction

# Headless fallback (non-TTY / piped / CI / agent) — same as `junction status`:
junction | cat            # outputs human-readable status, no hang, no pipe corruption

# --json always bypasses the TUI:
junction --json           # machine-readable JSON status

# Subcommands are unchanged:
junction status --json
junction profile list --json
```

**Headless contract (load-bearing):**
- `bare + both TTYs + no --json` → Ink TUI dashboard
- `bare + no TTY (pipe/CI/agent)` → headless status (no hang)
- `any subcommand or meta flag` → citty as before

**Security:** the TUI never renders credential secret values — only metadata
(displayName, kind, credentialCount per platform). `secretRef` is intentionally absent
from every `DashboardSnapshot` type.

## Source management — inspect, disable, remove (increment 13)

Complete the create→inspect→disable→remove lifecycle for profile sources:

```bash
# Inspect a profile (shows name, mcpEndpointPath, and each source with enabled state):
JUNCTION_HOME=/tmp/jt13 junction profile show --profile work --json
# → {"id":"...","name":"work","mcpEndpointPath":"/profiles/work/mcp","sources":[{"namespace":"srv","enabled":true,"platformId":"...","account":"work"}]}

# Disable a source (tools stop being served; credential + source retained):
JUNCTION_HOME=/tmp/jt13 junction profile disable-source --profile work --namespace srv --json
# → {"ok":true}

# Re-enable a source:
JUNCTION_HOME=/tmp/jt13 junction profile enable-source --profile work --namespace srv --json
# → {"ok":true}

# Remove a source (permanently unlinks it from the profile):
JUNCTION_HOME=/tmp/jt13 junction profile remove-source --profile work --namespace srv --json
# → {"ok":true}

# Delete a profile by name (cascades — source_refs removed automatically):
JUNCTION_HOME=/tmp/jt13 junction profile delete --profile work --json
# → {"ok":true}

# Remove a credential (RESTRICT: fails if still referenced by a source; secret deleted only on DB success):
JUNCTION_HOME=/tmp/jt13 junction credential remove --id <credential-id> --json
# → {"ok":true} on success
# → {"ok":false,"error":"credential is in use by one or more sources — remove those sources first"} if in-use

# Remove a platform (RESTRICT: fails if any credential references it):
JUNCTION_HOME=/tmp/jt13 junction platform remove --id <platform-id> --json
# → {"ok":true} on success
# → {"ok":false,"error":"platform is in use — remove its credentials and sources first"} if in-use

# Status now shows counts summary:
JUNCTION_HOME=/tmp/jt13 junction status
# includes: "sources  2 platforms · 3 credentials · 1 profiles"
```

**Security invariants (enforced by tests):**
- `removeCredential` deletes the secret ONLY after a successful DB delete (RESTRICT = secret never orphaned).
- `credential remove` while source still references it → clean "in-use" error, exit≠0, secret untouched.
- `profile show` / `status` / dashboard NEVER expose `secretRef` — only IDs, namespace, enabled flag.
- RESTRICT FK on `source_refs.credential_id` and `source_refs.platform_id` — no cascade deletes into credentials/platforms.

**TUI dashboard (increment 13):**
The Profiles panel now shows per-source rows beneath each profile, with ✓/✗ enabled/disabled glyphs.
`sourceCount` removed from `DashboardProfile`; replaced with `sources: DashboardSource[]`.

## Optional credentials — public/no-auth sources (increment 16)

`--credential` is now optional in `add-source` and `debug probe`/`debug call`. Omit it to
create a public/no-auth source that connects with `secret = null`.

```bash
# Add a public (no-auth) OpenAPI source — no --credential needed:
JUNCTION_HOME=/tmp/jt16 junction profile add-source \
  --profile p --platform pub --namespace pub --json
# → {"ok":true,"profileName":"p","namespace":"pub"}

# profile show: account column shows "(none)" for credential-less sources:
JUNCTION_HOME=/tmp/jt16 junction profile show --name p --json
# → {...,"sources":[{"namespace":"pub","platform":"pub","credentialAccount":"(none)","enabled":true}]}

# Probe a public platform without a credential:
JUNCTION_HOME=/tmp/jt16 junction debug probe --platform pub
# → prints raw + namespaced tools; secret = null (no auth header injected)

# With --credential still works unchanged (credentialed sources are byte-identical):
JUNCTION_HOME=/tmp/jt16 junction debug probe --platform github --credential <id>
```

**Auth-declared-but-no-credential warning (informative, not blocking):**
When `--credential` is omitted but the platform declares auth (MCP `connection.auth` or
OpenAPI `openapi.auth`), a warning is written to **stderr only** (stdout is the MCP channel):
```
junction mcp serve: source "pub": platform "github" declares auth but no credential is attached — calls may be unauthorized
```

**Security invariants:**
- `secret = null` → `injectAuth` short-circuits; no auth header sent (already verified in openapi-client tests).
- No `store.get` call is made when `credentialId` is absent — the credential store is untouched.
- RESTRICT FK on `credential_id` still blocks deleting a credential referenced by a credentialed source.
- NULL `credential_id` in DB is FK-exempt — it does NOT reference any credential row.

## Web dashboard (increment 22)

`junction web` launches the local read-only dashboard on `http://127.0.0.1:4321`. The web package must be built first.

```bash
# Build everything (includes the web Nitro server):
pnpm build

# Launch the dashboard (opens browser automatically):
JUNCTION_HOME=/tmp/jt22 junction web

# Custom port, no browser open:
JUNCTION_HOME=/tmp/jt22 junction web --port 8080 --no-open

# Dev mode (hot-reload, no CLI spawn needed):
pnpm --filter @junction/web dev
```

**Architecture:**
- `junction web` resolves the built server entry via `import.meta.resolve("@junction/web/server")` (artifact dep — not a code import) and spawns it as a subprocess bound to `127.0.0.1`.
- All core data access goes through `createServerFn` in `packages/web/src/server/data.functions.ts`; core is imported only in `*.server.ts`.
- Client bundle must never contain `better-sqlite3`/`@napi-rs/keyring`/core DB code — verified by `grep -rl "better-sqlite3\|napi-rs/keyring\|CREATE TABLE\|drizzle" packages/web/.output/public`.
- Read-only (no mutations); no auth; loopback-only (`HOST=127.0.0.1`); Host header guard in every server function.

**Typecheck + verify:**
```bash
pnpm verify          # includes pnpm --filter @junction/web typecheck (tsr generate + tsc --noEmit)
```

## Large-spec selection + `platform refresh` (increment 19)

OpenAPI specs with more than `maxTools` (default 75) operations can be added as a slice using
`--tag` and/or `--path` (both repeatable). The selection is persisted in the descriptor and
re-applied at serve/debug time so agents see exactly the chosen slice.

```bash
# Attempt to add a large spec (e.g. 120 ops) — fails and shows per-tag counts:
JUNCTION_HOME=/tmp/jt19 junction platform add --id big --kind openapi \
  --display-name Big --spec-url <large-spec-url>
# → error: Spec has N operations, exceeding the cap of 75.
#          Operations by tag:
#            pet: 20  store: 5  user: 10  …
#          Narrow with --tag <name> and/or --path <prefix> to add a slice, or pick a smaller spec.

# Add only the "pet" tag slice (--tag is repeatable; combine tags with multiple --tag flags):
JUNCTION_HOME=/tmp/jt19 junction platform add --id big --kind openapi \
  --display-name Big --spec-url <large-spec-url> --tag pet --json
# → {"ok":true,"platform":{...,"openapi":{"select":{"tags":["pet"]},...}},"toolCount":20}

# Add only ops under /pet path prefix (path-boundary match: /pet, /pet/{petId} but NOT /pets):
JUNCTION_HOME=/tmp/jt19 junction platform add --id big --kind openapi \
  --display-name Big --spec-url <large-spec-url> --path /pet --json

# Combine --tag and --path (union semantics — match ANY criterion):
JUNCTION_HOME=/tmp/jt19 junction platform add --id big --kind openapi \
  --display-name Big --spec-url <large-spec-url> --tag store --path /user --json

# Probe: only the selected tools are served
JUNCTION_HOME=/tmp/jt19 junction debug probe --platform big
# → only "pet" tools appear; store + user tools absent

# Refresh a platform's spec from its stored URL (re-pulls, re-applies stored select + maxTools):
JUNCTION_HOME=/tmp/jt19 junction platform refresh --id big --json
# → {"ok":true,"oldCount":20,"newCount":21,"platform":{...}}
#   (or refuses with an error if the refreshed spec would exceed the cap — never clobbers)
```

**Selection invariants (load-bearing):**
- Selection is persisted in `OpenApiConnection.select` (stored in the `openapi` JSON column) and
  re-applied at runtime so `listTools` (serve/probe) returns exactly the persisted slice.
- `--tag` uses tag membership; `--path` uses path-boundary prefix match; together = union.
- The cap (`maxTools`) applies to the *selected* count, not the full spec count.

**`platform refresh` invariants:**
- Only openapi platforms whose `spec.from === "url"` can be refreshed.
- If the refreshed spec would exceed the cap (after selection), refresh REFUSES and leaves the
  DB descriptor + cached spec file completely unchanged (no-clobber).
- A fetch failure also leaves everything unchanged.
- Base URL is re-resolved from the refreshed spec's `servers`; falls back to the existing stored
  `baseUrl` if the new spec drops or templates its servers (so a working platform stays working).
