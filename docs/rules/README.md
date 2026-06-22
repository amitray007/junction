# Junction Coding Rules

The enforceable guardrails for junction code. **Read these before writing any code.** They exist so junction is clean for humans *and* agents, and so we never ship broken code.

## How rules are enforced (three layers)

1. **Cited** — the `junction-clean-code` skill summarizes these and points here.
2. **Checked mechanically** — the greppable/automatable subset is enforced by hooks (`.claude/settings.json` + `.claude/hooks/boundary-guard.mjs`) and by `pnpm verify` (typecheck + Biome + Vitest). A hook block is a **hard stop**.
3. **Audited** — the review agents (`junction-package-boundary`, `junction-clean-code-reviewer`, and the credential/MCP/TUI reviewers when active) check the rest at review time. An agent finding is advisory-but-expected-to-be-resolved.

Precedence: a hook block always wins. `pnpm verify` must pass before any commit.

## The rule files

| File | Covers |
|---|---|
| [`typescript.md`](./typescript.md) | typed errors (neverthrow), no `any`, validation at boundaries, file size, naming, ESM hygiene |
| [`testing.md`](./testing.md) | Vitest conventions, "QA-able per change", behavior-not-implementation |
| [`performance.md`](./performance.md) | no sync I/O in core/server, async logging, lazy imports, benching |
| [`security.md`](./security.md) | credential plaintext handling, banned APIs, secrets-in-errors |
| [`data.md`](./data.md) | additive forward-only migrations, secrets-as-references, repository layer (inc 4+) |

## The prime directives

- **Core is pure; edges are thin.** Logic in `@junction/core`; `cli`/`web`/`mcp/*` only translate.
- **Dependency direction is one-way.** `core` ← others, never the reverse. No HTTP/daemon in `core`.
- **Credentials never leave the process.** Plaintext only in memory during a call.
- **Every change is QA-able.** Ships with a behavior test and passes `pnpm verify`.
