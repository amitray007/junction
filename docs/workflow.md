# Junction — Per-Increment Workflow

How every increment of junction gets built. This is the durable checklist agents follow. It mirrors `CLAUDE.md` (operating model) and the design spec (§7).

## Operating model

- **Orchestrator (Opus) is the brain.** It thinks, researches, plans, prepares jobs, and reviews. It does **not** usually write implementation code itself.
- **Model routing:**
  - **Research** (best practices, prior art, deep investigation) → **Opus** subagent.
  - **Building** (features, fixes, implementation) → **Sonnet** subagent.
  - **Super simple / tiny** change (one-liner, rename, trivial config) → done **directly**, no delegation.
- **Delegate by default.** The orchestrator prepares a complete, self-contained job so the builder doesn't have to guess.

## Method files

Before doing any work on an increment, the orchestrator writes **one method file**: `docs/methods/NN-<increment>.md`, containing the increment's **mini-spec + step-by-step implementation together**. It is the self-contained artifact handed to the Sonnet builder. The design spec stays the source of truth; method files are its executable slices. No parallel doc trail.

## The 8-step loop (per increment)

We lean on **compound-engineering (CE)** for generic heavy lifting and use junction's **custom agents** for the junction-specific layer (package boundaries, credential security, MCP contract). Each step below names the tools to use.

1. **Research** the problem (Opus subagents if deep).
   → CE: `ce-best-practices-researcher`, `ce-framework-docs-researcher`, `ce-repo-research-analyst`, `ce-web-researcher`, `ce-learnings-researcher` (prior learnings in `docs/`).
2. **Plan around the codebase** — best tooling/components, whether a new package is needed, architectural questions.
   → CE: `/ce-plan` to structure or deepen the plan.
3. **Produce the method file** (spec + implementation), then review it before building.
   → CE: `/ce-doc-review` (parallel persona review of the method file), `ce-spec-flow-analyzer` (flow/edge-case gaps), `ce-feasibility-reviewer`.
4. **→ USER APPROVES (gate)** → build (delegate to a **Sonnet** subagent).
   → CE: `/ce-work` as the execution harness for the build.
5. **Agent QA / tests** — the builder runs `pnpm verify` and writes behavior tests. If something breaks, root-cause it.
   → CE: `/ce-debug` (systematic root-cause; never patch symptoms). Then `/ce-simplify-code` on the diff before review.
6. **Background review** — run in parallel:
   → Junction custom agents: `junction-package-boundary`, `junction-clean-code-reviewer`, plus the active stubs (`junction-credential-security` from inc 6, `junction-mcp-contract` from inc 7, `junction-tui` from inc 9).
   → CE: `/ce-code-review` (tiered persona pipeline), and dispatch the relevant CE reviewers directly — `ce-correctness-reviewer` (logic/edge cases/TS idioms), `ce-security-reviewer` (auth/secrets diffs), `ce-performance-reviewer`, `ce-maintainability-reviewer`, `ce-testing-reviewer`, `ce-api-contract-reviewer` (exported types, inc 4+), `ce-data-migration-reviewer` / `ce-data-integrity-guardian` (migrations, inc 5+).
7. **Ask the user to test.**
8. **→ USER APPROVES (gate)** → commit & next increment.
   → CE: `/ce-commit` (value-communicating message) or `/ce-commit-push-pr` when shipping a PR. For PR feedback later: `/ce-resolve-pr-feedback`.

Two approval gates every increment: **step 4** (plan) and **step 8** (after testing).

> **Tool selection is by relevance, not ceremony.** Use the CE reviewers a given diff warrants (a migration → `ce-data-migration-reviewer`; an auth path → `ce-security-reviewer`); don't run all of them on every change. Junction's custom agents always run — they cover what CE doesn't know about junction.

## Guardrails (always)

- All code obeys `docs/rules/` (TypeScript, testing, performance, security).
- `pnpm verify` must pass before any commit; hooks enforce this mechanically.
- Respect the package dependency direction: `core` ← others, never the reverse.
- Skills policy: do **not** use `superpowers:*` skills unless the user explicitly asks (CLAUDE.md). This workflow replaces that flow.
