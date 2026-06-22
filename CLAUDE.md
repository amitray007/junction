# CLAUDE.md — Junction

Junction is a self-hosted, single-user **broker**: the one place you connect your platform accounts once, so any AI agent can reach that data through MCP / CLI / API — granular, profiled, sandboxed, secured.

- **Idea / pain / landscape:** `docs/idea.md`
- **Foundation design (source of truth):** `docs/superpowers/specs/2026-06-22-junction-foundation-design.md`
- **Per-increment method files:** `docs/methods/` (see Operating Model below)

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

---

## Architecture (hard rules)

**4-package pnpm/TypeScript monorepo:**

```
packages/
  core/         @junction/core      — types, catalog, credential store, profile manager,
                                       persistence, sandbox interface. NO HTTP, NO cli/web deps.
  mcp-server/   @junction/mcp-server — McpServer wiring over a Profile. MCP SDK + core only.
  cli/          junction            — thin: argv → core.
  web/          @junction/web        — (later) imports core directly.
```

- **Dependency direction is one-way:** `core` depends on nothing in the repo; `mcp-server`/`cli`/`web` may depend on `core`; **never** the reverse.
- **`core` has no HTTP server and no daemon** — it stays embeddable and testable.
- **Credentials never leave the process.** Plaintext exists only in memory during a tool call; the MCP endpoint never returns credential values.
- **`Credential` (not `Platform`) is the unit a `Profile` references** — this encodes the multi-account wedge.
- **Tool namespacing is `<namespace>__<tool>`** (double underscore). **Per-profile MCP endpoints**, not shared-endpoint filters. Both are load-bearing — renaming later breaks agent prompts.
- **Web login ≠ platform-token vault.** The vault lives in `core` (arctic + encrypted Drizzle table + keyring). better-auth, if ever adopted, handles only human web login and **never** owns platform tokens.

---

## Stack

ESM-only · `nodenext` · `target: es2023` · Node 22 LTS (floor 20).

pnpm workspaces · tsdown (+ publint + attw) · citty + @clack/prompts · Vitest · Zod v4 · env-paths + proper-lockfile (`~/.junction`, `JUNCTION_HOME` override) · Drizzle + better-sqlite3 · `CredentialStore` → @napi-rs/keyring + AES-256-GCM file store · `@modelcontextprotocol/sdk`.

**Future-domain (recorded, installed at their increment):** TanStack Start (web) · arctic (OAuth vault) · pino (audit) · better-auth (remote web login only) · OpenTUI (TUI dashboard, increment 9) · microsandbox (microVM escalation) · Sandbox = Deno + bubblewrap/Seatbelt.

**Banned:** keytar · vm2 / `node:vm`-as-sandbox · legacy inquirer · Jest · oclif · Lucia · `conf` (as primary store) · Clerk/WorkOS · isolated-vm (maintenance-mode; avoid unless Deno+bubblewrap impractical).

---

## Code quality

- **Core is pure; edges are thin.** Logic lives in `core`; `cli`/`web`/`mcp-server` translate to/from it.
- **Single purpose per file/unit.** If a file grows large, it's doing too much — split it. Each unit: clear what-it-does, how-to-use-it, what-it-depends-on.
- **Validate at trust boundaries** (config load, MCP/API inputs, OAuth responses) with Zod.
- **Tests with Vitest** alongside the code; assert behavior, not implementation details.
- **Scriptable paths stay scriptable** — every interactive command keeps a `--json`/headless path so agents can drive the CLI.
- See `docs/skills/` (junction clean-code skills) for the full conventions.
