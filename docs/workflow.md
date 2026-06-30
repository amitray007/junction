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

**Plan for parallelism by default.** When the increment is more than a one-file change, the orchestrator's default lens is **"how can this be done in parallel?"** — split it into a small **blocking core/shared slice** (lands first, alone) + **independent leaf slices** (`cli`/`web`/`mcp/*`/tests) that fan out at once. Each method file carries `depends_on` / `soft_after` / `touches` / `parallel_group` frontmatter so parallelizability is **computed from the dependency graph, not guessed**. Full convention + the collision rule + the living wave plan: **`docs/methods/_waves.md`**. Parallelism is the default, not a mandate — a genuine dependency chain stays serial; say so plainly.

## Delegating to the builder — the brief

The orchestrator thinks so the builder doesn't have to guess. A thin brief produces a thin increment. An effective builder brief (the method file + the delegation prompt) contains, in order:

1. **Context & goal** — what/why in a few lines + the explicit **proof-of-done**.
2. **Read first** — the exact files/specs the builder must read before touching anything.
3. **Exact changes** — per file, the specific approach/edits (not "figure it out").
4. **Hard invariants** — the non-negotiables for this diff (e.g. secrets never leave the process / never reach output or the client bundle; `core` has no HTTP; typed `Result` errors; validate at trust boundaries).
5. **Do NOT** — the known traps to avoid this time (e.g. don't add a non-exhaustive `default:`/`as never` to an exhaustive switch; never `tsc -b --force`; don't weaken `validatePolicy`; don't put a secret in argv).
6. **Tests** — what behavior to test + the gate (`pnpm verify`).
7. **Report back** — a structured summary (what changed, how it was verified, any deviations/risks) so the orchestrator can *verify*, not re-derive.

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
   → **Then the orchestrator independently verifies** (see "Verification discipline" below) — never ship on the builder's "done" alone.
6. **Background review** — dispatch the warranted reviewers **in parallel as background agents**; they may finish without surfacing findings, so **ping them for their report**, then consolidate and fix. Treat review as adversarial, not a rubber stamp — **expect, and hunt for, at least one real finding**.
   → Junction custom agents: `junction-package-boundary`, `junction-clean-code-reviewer`, plus the active stubs (`junction-credential-security` from inc 6, `junction-mcp-contract` from inc 7, `junction-sandbox-security` from inc 8, `junction-tui` from inc 9, `junction-web-reviewer` for web changes).
   → CE: `/ce-code-review` (tiered persona pipeline), and dispatch the relevant CE reviewers directly — `ce-correctness-reviewer` (logic/edge cases/TS idioms), `ce-security-reviewer` (auth/secrets diffs), `ce-performance-reviewer`, `ce-maintainability-reviewer`, `ce-testing-reviewer`, `ce-api-contract-reviewer` (exported types, inc 4+), `ce-data-migration-reviewer` / `ce-data-integrity-guardian` (migrations, inc 5+).
7. **Ask the user to test.**
8. **→ USER APPROVES (gate)** → commit & next increment.
   → CE: `/ce-commit` (value-communicating message) or `/ce-commit-push-pr` when shipping a PR. For PR feedback later: `/ce-resolve-pr-feedback`.

Two approval gates every increment: **step 4** (plan) and **step 8** (after testing).

> **Tool selection is by relevance, not ceremony.** Use the CE reviewers a given diff warrants (a migration → `ce-data-migration-reviewer`; an auth path → `ce-security-reviewer`); don't run all of them on every change. Junction's custom agents always run — they cover what CE doesn't know about junction.

## Verification discipline (orchestrator QA — step 5)

After the builder reports "done", the orchestrator **independently verifies** — never trusts the claim:

- **Drive the REAL built artifact.** `pnpm build`, then run the actual bin / `./junction` — not the source, not the builder's transcript.
- **Use the right instrument.** Don't grep ciphertext for plaintext (an encrypted store never matches → a false "no leak"); don't pipe a long-running `mcp serve` (it hangs the shell); `head -1` exiting 0 is not a pass. Assert on real output.
- **End-to-end against a real/local source** (a local OpenAPI/GraphQL/MCP server, a real spec) — not a mock.
- **Security increments → adversarial e2e.** Prove the *negative*: injection inert, path traversal denied, secret not leaked — against the real backend (e.g. real Seatbelt/bwrap), not a unit stub.

This is the step that catches a real issue nearly every increment. Budget for it.

## Parallel waves — fan-out + serial merge

When a wave (≥2 independent slices — see `docs/methods/_waves.md`) is approved, the build/review/merge steps run in parallel **except merge**, which is deliberately serialized:

- **Fan out (build).** One **Sonnet builder per slice**, each in its **own `git` worktree + branch** (Agent tool `isolation: "worktree"`) so they can't collide on files. Each works from its own self-contained method file; they run concurrently in the background while the orchestrator QAs finished ones and plans the next wave.
- **Review in parallel (cheap).** Run the warranted reviewers **per-worktree**, concurrently — no human gate yet.
- **Merge serially (the choke point — this protects correctness-over-speed).** Merge in **DAG order**: the `core`/shared slice **first**, then the leaves. **After each merge, rebase the next worktree on the new `main` and re-run `pnpm verify`** before merging it. This is the only thing that catches **semantic conflicts** — slices that are green in isolation but break `tsc`/Vitest together. Stacked-PR hazards still apply (merge commits not squash; retarget children before merging a parent — see `STATE.md` §3).
- **One user gate per wave**, not per slice: the user approves the wave at plan time and batch-tests at the end. Every PR reaching them is already green + already agent-reviewed, so the gate is judgment, not QA.

A lone increment (the common case) skips all of this — no worktree, no wave, just the normal single-slice loop.

## Guardrails (always)

- All code obeys `docs/rules/` (TypeScript, testing, performance, security).
- `pnpm verify` must pass before any commit; hooks enforce this mechanically.
- Respect the package dependency direction: `core` ← others, never the reverse.
- Skills policy: do **not** use `superpowers:*` skills unless the user explicitly asks (CLAUDE.md). This workflow replaces that flow.
