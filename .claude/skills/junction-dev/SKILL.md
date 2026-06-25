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

## MCP client — upstream connector (increment 11)

`junction debug mcp-probe` connects to a platform's upstream MCP source, lists tools, and
prints the **namespaced** names (`<namespace>__<tool>`). Token never appears in output.

```bash
# List credentials to find the credential ID:
JUNCTION_HOME=/tmp/jt10 junction credential list --platform github --json

# Probe the upstream MCP source (replace <id> with the credential id):
JUNCTION_HOME=/tmp/jt10 junction debug mcp-probe \
  --platform github --credential <id>
# → prints github_work__list_issues, github_work__get_pull_request, ... + count

# Machine-readable output:
JUNCTION_HOME=/tmp/jt10 junction debug mcp-probe \
  --platform github --credential <id> --json
# → {"ok":true,"namespace":"github_work","count":N,"tools":["github_work__..."]}
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
