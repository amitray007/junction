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

1. **Research** the problem (Opus subagents if deep).
2. **Plan around the codebase** — best tooling/components, whether a new package is needed, architectural questions.
3. **Produce the method file** (spec + implementation) with a final set of reviews.
4. **→ USER APPROVES (gate)** → build (delegate to a Sonnet subagent).
5. **Agent QA / tests** — the builder runs `pnpm verify` and writes behavior tests.
6. **Background review** — compound-engineering reviewers + junction's custom reviewers (`junction-package-boundary`, `junction-clean-code`, and any active stubs).
7. **Ask the user to test.**
8. **→ USER APPROVES (gate)** → next increment.

Two approval gates every increment: **step 4** (plan) and **step 8** (after testing).

## Guardrails (always)

- All code obeys `docs/rules/` (TypeScript, testing, performance, security).
- `pnpm verify` must pass before any commit; hooks enforce this mechanically.
- Respect the package dependency direction: `core` ← others, never the reverse.
- Skills policy: do **not** use `superpowers:*` skills unless the user explicitly asks (CLAUDE.md). This workflow replaces that flow.
