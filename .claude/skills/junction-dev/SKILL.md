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
