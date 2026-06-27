# CLAUDE.md — Junction

Junction is a self-hosted, single-user **broker**: the one place you connect your platform accounts once, so any AI agent can reach that data through MCP / CLI / API — granular, profiled, sandboxed, secured.

- **Idea / pain / landscape:** `docs/idea.md`
- **Foundation design (source of truth):** `docs/specs/2026-06-22-junction-foundation-design.md`
- **Coding guardrails (read before writing any code):** `docs/rules/` — per-language rules, enforced by hooks + review agents.
- **Design principles (modularity & DRY):** `docs/principles/` — where code lives, when to factor, when to keep duplicated.
- **Behaviours (how we decide):** `docs/behaviours/` — correctness/security over speed, architecture over expedience, decisions held loosely. Read before recommending any solution.
- **Per-increment method files:** `docs/methods/` (see Operating Model below)
- **Forward-looking register:** `docs/futures/` — deprecations we knowingly depend on (+ forward paths), "revisit-when" deferred decisions (+ triggers), and known gotchas. **Maintain it as you go** (see convention below).

---

## Decision behaviours (non-negotiable — see `docs/behaviours/`)

1. **Correctness/security over speed.** Never move forward on a quick solution unless we are *sure* it carries no critical/high-severity issue — ideally verified, not assumed. If unsure, investigate/test/escalate first; if the proper fix is hard, **stop and surface it** rather than patch the symptom.
2. **Architecture over expedience.** When choosing between a quick fix and a rewrite / logical rework, recommend and prefer the **better architectural decision** — fix the root cause, not the symptom — even when it's slower.
3. **Hold decisions loosely.** Never be dogmatically attached to one option. Present trade-offs + a recommendation (not an ultimatum); surface genuine, outcome-changing decisions to the user with options; stay open to changing course on new evidence, even mid-build.

---

## Operating Model (how work gets done)

**The orchestrator is the brain; subagents do the work.**

The top-level agent (Opus) is a **smart orchestrator**: it thinks, researches, plans, prepares jobs, and reviews. It does **not** usually write implementation code itself.

### Model routing — always delegate to subagents unless trivial

| Work type | Who does it | Model |
|---|---|---|
| **Orchestration** (think, plan, prepare jobs, review) | top-level agent | Opus |
| **Research** (best practices, prior art, deep investigation) | subagent | **Opus** |
| **Building** (features, fixes, implementation) | subagent | **Sonnet** |
| **Super simple / tiny change** | top-level agent directly | — (no delegation needed) |

Rules:
- **Default to delegating.** Implementation work goes to a **Sonnet** subagent. Research goes to an **Opus** subagent.
- Only skip delegation when the change is genuinely **super simple or small** (a one-line edit, a rename, a trivial config tweak).
- The orchestrator's job is to **prepare a complete, self-contained job** so the Sonnet agent can execute well — the orchestrator thinks so the builder doesn't have to guess.

### Skills policy

- **Do not use `superpowers:*` skills for this project unless the user explicitly asks for them.** Junction's own **method-file workflow** (below) replaces the superpowers brainstorming → writing-plans → executing-plans flow. The orchestration + per-increment loop here is the process; don't auto-invoke superpowers skills on top of it.
- Other skills (compound-engineering review agents, the OpenTUI skill, junction's own clean-code/project skills) remain available and encouraged where relevant.

### Method files (the work + hand-off artifact)

Before doing *any* work on an increment, the orchestrator writes **one file** — the **method file** — containing **both the spec and the implementation plan together**:

- **Location:** `docs/methods/NN-<increment-name>.md` (one per increment; `NN` = increment number).
- **Contents:** the increment's mini-spec (what/why, interfaces, proof-of-done) **plus** the step-by-step implementation (files to create/change, exact approach, tests, commands).
- **Purpose:** it is the artifact used to **delegate the task to the Sonnet builder agent.** The Sonnet agent works *from* the method file. It must be self-contained enough that the builder needs no extra context.
- **Relationship to other docs:** the project **design spec** stays the source of truth; each method file is one increment's executable slice of it. `writing-plans` output becomes these method files. No parallel doc trail.

**Flow per increment:** orchestrator researches (Opus subagents if deep) → writes the method file → user approves the plan (gate) → delegates to a **Sonnet** builder subagent → orchestrator QAs/reviews (background review agents) → user tests (gate) → next increment.

---

## Per-increment workflow (8 steps)

Every increment follows this loop (gates at step 4 and step 8):

1. **Research** the problem.
2. **Plan around the codebase** — best tooling/components, new-package questions, architecture.
3. **Produce the method file** (spec + implementation) with a final set of reviews.
4. **User approves** → build (delegate to Sonnet).
5. **Agent QA / tests.**
6. **Background review** (compound-engineering + junction's custom reviewers).
7. **Ask the user to test.**
8. **User approves** → next increment.

`docs/workflow.md` names the exact tool to use at each step.

### End-of-increment report (always)

At the end of **every** increment/method, the orchestrator MUST close with a structured report containing exactly these three parts:

1. **Visually testable by you?** — **Yes** (with copy-paste commands the user can run, e.g. `JUNCTION_HOME=/tmp/jt node packages/cli/dist/index.js …`) **or No** (state plainly there's no user-facing surface yet — e.g. pure schema/internal increments — and name the increment where it *becomes* visible).
2. **QA tested by me** — what the orchestrator independently verified (not just the builder's claim): gates run (`pnpm verify`/`build`/`depcruise`), behavior driven against the real built code, review findings addressed.
3. **Checklist of intricate details** — a markdown checklist (`- [x]`) of the load-bearing/subtle points proven this increment (invariants, edge cases, conventions, gotchas), so the user can scan what's actually guaranteed.

Be honest in part 1: if it isn't user-visible, say so — don't invent a visual test.

### Forward-looking register (`docs/futures/`) — record as you go

Whenever work surfaces a forward-looking caveat, **promote it out of the method file / commit message into `docs/futures/`** so it isn't lost. Record an entry when you:

1. **Adopt a dependency or OS API that is deprecated / EOL-risk but necessary** → `docs/futures/deprecations.md`, with the **forward path** (what replaces it and when). *(e.g. macOS Seatbelt → microVM.)*
2. **Defer a decision** with a "we'll do X when Y" shape → `docs/futures/revisit-when.md`, with the explicit **trigger**. *(e.g. Effect-TS only if concurrent fan-out earns it.)*
3. **Work around a non-obvious fragility** that could bite again → `docs/futures/gotchas.md`, with the **symptom + the fix**. *(e.g. scrypt `maxmem`, Seatbelt env-scrub, depcruise "green but blind".)*

Keep entries terse and scannable (one short paragraph, the increment it was raised, the trigger/forward-path). When a trigger fires or a deprecation is migrated off, update/strike the entry and note the resolving increment. This register is the project's durable forward memory — treat maintaining it as part of finishing the work, like the end-of-increment report.

---

## Tooling — use compound-engineering (CE)

Prefer CE commands/agents for generic work; junction's custom agents cover the junction-specific layer. Map (see `docs/workflow.md` for full detail):

- **Research:** `ce-best-practices-researcher`, `ce-framework-docs-researcher`, `ce-repo-research-analyst`, `ce-web-researcher`, `ce-learnings-researcher`.
- **Plan:** `/ce-plan`; review the method file with `/ce-doc-review` + `ce-spec-flow-analyzer`.
- **Build:** `/ce-work` (the Sonnet builder's harness).
- **QA / debug:** `pnpm verify` + `/ce-debug` (root-cause, not symptom). `/ce-simplify-code` on the diff. (Note: `ce-proof` is markdown publishing, **not** a verifier.)
- **Review:** `/ce-code-review` + `ce-correctness-reviewer`, `ce-security-reviewer`, `ce-performance-reviewer`, `ce-testing-reviewer`, `ce-maintainability-reviewer`, `ce-data-migration-reviewer` (migrations) — **plus** junction's `junction-package-boundary` + `junction-clean-code-reviewer` (always) and the credential/MCP/sandbox/TUI stubs when active.
- **Commit / ship:** `/ce-commit`, `/ce-commit-push-pr`, `/ce-resolve-pr-feedback`.

Selection is by relevance — run the reviewers a diff warrants, not all of them. Junction's custom agents always run.

---

## Architecture (hard rules)

**pnpm/TypeScript monorepo** (`core` + `mcp/{server,client}` + `cli` + `web`):

```
packages/
  core/          @junction/core       — types, catalog, credential store, profile manager,
                                        persistence, sandbox interface. NO HTTP, NO cli/web deps.
  mcp/
    server/      @junction/mcp-server  — serves agents. McpServer over a Profile. MCP SDK + core only.
    client/      @junction/mcp-client  — consumes upstream MCP sources. Reserved; built post-foundation.
  cli/           junction             — thin: argv → core.
  web/           @junction/web         — (later) imports core directly.
```

- **Dependency direction is one-way:** `core` depends on nothing in the repo; `mcp/server`, `mcp/client`, `cli`, `web` may depend on `core`; **never** the reverse.
- **`core` has no HTTP server and no daemon** — it stays embeddable and testable.
- **Credentials never leave the process.** Plaintext exists only in memory during a tool call; the MCP endpoint never returns credential values.
- **`Credential` (not `Platform`) is the unit a `Profile` references** — this encodes the multi-account wedge.
- **Tool namespacing is `<namespace>__<tool>`** (double underscore). **Per-profile MCP endpoints**, not shared-endpoint filters. Both are load-bearing — renaming later breaks agent prompts.
- **Web login ≠ platform-token vault.** The vault lives in `core` (arctic + encrypted Drizzle table + keyring). better-auth, if ever adopted, handles only human web login and **never** owns platform tokens.

---

## Stack

ESM-only · `nodenext` · `target: es2023` · Node 22 LTS (floor 20).

pnpm workspaces · tsdown (+ publint + attw) · citty + @clack/prompts · Vitest · Zod v4 · **neverthrow `Result<T,E>`** (typed errors; no Effect-TS) · env-paths + proper-lockfile (`~/.junction`, `JUNCTION_HOME` override) · Drizzle + better-sqlite3 · `CredentialStore` → @napi-rs/keyring + AES-256-GCM file store · `@modelcontextprotocol/sdk`.

**QA loop (every change):** **`pnpm verify`** = `tsc -b` (→ tsgo at GA) + **Biome** (lint) + **Vitest**. (Formatting is the separate `format` script + the per-edit hook.) Enforcement: **lefthook** runs `pnpm verify` pre-commit/pre-push (the commit gate); **`.claude/settings.json`** hooks add per-edit `biome --write` (PostToolUse) and the PreToolUse boundary guard.

*Deferred CI tooling (wired at the increments that need it, not yet present):* **knip** (dead code/deps, inc 1+), **type-coverage** (≥99%, inc 2+), **publint+attw** (packaging, when a package publishes), **targeted semgrep** (sandbox/secrets paths, inc 6/8). See `docs/rules/` + design spec §5b.

**Future-domain (recorded, installed at their increment):** TanStack Start (web) · arctic (OAuth vault) · pino (audit) · better-auth (remote web login only) · **Ink** (TUI dashboard, increment 9; OpenTUI deferred — Bun-only renderer, see `docs/futures/`) · microsandbox (microVM escalation) · Sandbox = Deno + bubblewrap/Seatbelt · React Compiler + eslint-plugin-react-hooks + react-doctor (web increment only).

**Banned:** keytar · vm2 / `node:vm`-as-sandbox · **Effect-TS** (use neverthrow) · **ESLint+Prettier as the loop** (use Biome) · **ts-prune** (use knip) · **Million.js/Lint** (use React Compiler) · legacy inquirer · Jest · oclif · Lucia · `conf` (as primary store) · Clerk/WorkOS · isolated-vm (maintenance-mode; avoid unless Deno+bubblewrap impractical).

---

## Code quality

**Read `docs/rules/` before writing any code** — it is the enforceable rule set (TypeScript, testing, performance, security). Highlights:

- **Modularity & DRY** (`docs/principles/`): default to a **named `core` module**, not a new package (everything depends on `core`); **never** a `utils`/`common`/`shared` grab-bag; **DRY primitives eagerly** (errors, IDs, paths, logger, branded-ID schema), **keep policies duplicated** until the rule of three (repos, CLI commands, MCP handlers); the wrong abstraction is costlier than duplication.
- **Core is pure; edges are thin.** Logic lives in `core`; `cli`/`web`/`mcp/*` translate to/from it.
- **Typed errors, no bare throws across boundaries.** Fallible operations return neverthrow `Result<T, E>` with discriminated-union domain errors. Use `using`/`Symbol.asyncDispose` for cleanup.
- **Single purpose per file/unit.** If a file grows large, it's doing too much — split it.
- **Validate at trust boundaries** (config load, MCP/API inputs, OAuth responses) with Zod.
- **No `fs.*Sync` in core/server paths**; structured async logging (pino); lazy-import heavy deps.
- **Tests with Vitest** alongside the code; assert behavior, not implementation. Every change ships QA-able: passes `pnpm verify` + a behavior test.
- **Scriptable paths stay scriptable** — every interactive command keeps a `--json`/headless path so agents can drive the CLI.

**Never ship broken code:** `pnpm verify` is the gate. lefthook runs it pre-commit (blocks broken commits); `.claude` hooks add per-edit Biome formatting and the PreToolUse boundary guard. The mechanical rules trace to `docs/rules/`.
