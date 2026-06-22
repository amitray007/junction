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

## Enforcement

- Git hooks (lefthook) run `pnpm verify` pre-commit — a failing verify blocks the commit.
- Claude Code hooks (`.claude/settings.json`) format on edit and guard package boundaries.
- See `docs/rules/` for the coding rules and `docs/workflow.md` for the per-increment loop.

## Grows here

> Update this skill at each increment: add the persistence commands (inc 5), the MCP serve command (inc 7), the sandbox usage (inc 8), the TUI launch (inc 9), and the web dev server (web increment).
