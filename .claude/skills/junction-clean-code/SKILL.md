---
name: junction-clean-code
description: Junction's clean-code conventions for humans and agents. Use when writing or reviewing junction code, deciding how to structure a module, handling errors, or asking "how should I write this here". Points at the enforceable rules in docs/rules/.
---

# Junction Clean Code

Junction's code must be clean for **both humans and agents**, and **easy to QA on every change** so we never ship broken code. The full enforceable rules live in `docs/rules/`; this skill is the working summary.

## The non-negotiables

- **Modularity & DRY** (`docs/principles/`): shared code is a **named module in `core`**, never a new package and never a `utils`/`common`/`shared` grab-bag. **Factor primitives eagerly** (errors, Result helpers, IDs, paths, logger, branded-ID schema); **keep policies/workflows duplicated** until the rule of three (per-entity repos, CLI commands, MCP handlers look alike but mean different things). The wrong abstraction costs more than duplication.
- **Core is pure; edges are thin.** All logic lives in `@junction/core`. `cli`, `web`, and `mcp/*` only translate between the outside world and `core`. If you're writing logic in an edge package, it probably belongs in `core`.
- **Dependency direction is one-way.** `core` depends on nothing in the repo; `mcp/server`, `mcp/client`, `cli`, `web` may depend on `core`; **never** the reverse. No HTTP server or daemon in `core`.
- **Typed errors, no bare throws across boundaries.** Fallible operations return neverthrow `Result<T, E>`. Domain errors are discriminated unions (e.g. `type CredentialError = DecryptionError | KeyNotFoundError | StorageError`). A returned `Result` must be consumed — no floating results. See `docs/rules/typescript.md`.
- **Validate at trust boundaries** with Zod: config load, MCP/API inputs, OAuth responses. Inside the trust boundary, work with typed values.
- **Credentials never leave the process.** Plaintext exists only in memory during a call; never logged, never persisted in the main DB, never returned over MCP. See `docs/rules/security.md`.
- **Single purpose per file/unit.** If a file does two jobs or grows past easy readability, split it. Each unit answers: what does it do, how do you use it, what does it depend on.
- **No `fs.*Sync`/`execSync` in core/server paths.** Async, structured logging via pino. Lazy-import heavy deps. See `docs/rules/performance.md`.

## QA-ability (the "never broken" rule)

Every change ships ready to QA:

- It passes `pnpm verify` (typecheck + Biome + Vitest).
- It includes at least one **behavior** test (assert outcomes, not internal calls). Isolate filesystem state with `JUNCTION_HOME=<tmpdir>`.
- Scriptable paths stay scriptable: every interactive command keeps a `--json`/headless path so agents can drive it.

## Naming & conventions

- Intention-revealing names; no abbreviations that aren't domain terms.
- Tool names use `<namespace>__<tool>` (double underscore), e.g. `github_work__list_issues`.
- Per-profile MCP endpoints (`/profiles/{name}/mcp`), not shared-endpoint filters.

## When in doubt

Read `docs/rules/`. The hooks enforce the mechanical rules (formatting, banned imports); the review agents (`junction-package-boundary`, `junction-clean-code-reviewer`) audit the rest. If a rule and a deadline conflict, fix the rule violation — `pnpm verify` is the gate.
