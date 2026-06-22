# Method File 00 — Scaffolding (Increment 0)

> **Method file** = spec + implementation in one doc, self-contained for the builder. Per CLAUDE.md, this is the hand-off artifact.
>
> **Increment 0 is pure docs/skills/agents/config — no package code.** Per the "super simple" carve-out, the orchestrator (Opus) writes these `.md`/config artifacts **directly** (they are prose/config, not implementation logic that benefits from a Sonnet builder). **Delegation note:** no Sonnet build needed for increment 0. From increment 1 onward, builds delegate to Sonnet via their own method files.

---

## Part 1 — Spec (what & why)

### Goal

Stand up all engineering scaffolding **before any package code**, so every later increment is governed from line one. This realizes §7 of the foundation design spec.

### Deliverables

| # | Artifact | Path | Done by |
|---|---|---|---|
| 1 | Root project conventions | `CLAUDE.md` | ✅ already written |
| 2 | Per-increment workflow checklist | `docs/workflow.md` | direct |
| 3 | Clean-code / codebase-quality skill | `.claude/skills/junction-clean-code/SKILL.md` | direct |
| 4 | Junction project skill (run/build/test) | `.claude/skills/junction-dev/SKILL.md` | direct |
| 5 | Package-boundary review agent (active) | `.claude/agents/junction-package-boundary.md` | direct |
| 6 | Clean-code review agent (active) | `.claude/agents/junction-clean-code-reviewer.md` | direct |
| 7 | Credential-security review agent (stub) | `.claude/agents/junction-credential-security.md` | direct |
| 8 | MCP-contract review agent (stub) | `.claude/agents/junction-mcp-contract.md` | direct |
| 9 | TUI review agent (stub) | `.claude/agents/junction-tui.md` | direct |
| 10 | `docs/methods/README.md` | `docs/methods/README.md` | direct |

> **`docs/rules/` + QA-loop hooks are increment 0.5** — see method file `00.5-rules-and-enforcement.md`. They land before increment 1, after this file. The clean-code skill (#3) and clean-code agent (#6) below reference `docs/rules/`, so 0.5's rule docs should exist before they're considered "done" — write 0.5 immediately after 0.

### Proof of done

- All files exist at the paths above with valid frontmatter (skills: `name` + `description`; agents: `name` + `description` + `model` + `tools`).
- `CLAUDE.md`, the design spec, and `docs/workflow.md` agree on the 8-step loop and operating model (no contradictions).
- The two **active** review agents reference real, checkable rules and cite `docs/rules/`. The three **stub** agents clearly state "activates at increment N" and describe what they will check.
- Committed to git.

### Out of scope for increment 0

Any package code, `package.json`, `pnpm-workspace.yaml`, tsconfig — those are **increment 1**. The `docs/rules/` content + enforcement wiring (Biome/lefthook/.claude hooks) are **increment 0.5** (method file `00.5`).

---

## Part 2 — Implementation (step by step)

### Conventions (apply to every file below)

- **Skill files:** `.claude/skills/<skill-name>/SKILL.md`, frontmatter `name` + `description` (description must say *when* to use it — trigger phrases).
- **Agent files:** `.claude/agents/<agent-name>.md`, frontmatter `name`, `description`, `model: inherit`, `tools:` (comma list), then the system prompt as body.
- Keep each file focused and concise. Prose for humans *and* agents.

### Step 1 — `docs/workflow.md`

The 8-step per-increment loop as a durable checklist agents follow. Mirror CLAUDE.md's workflow + operating model:
- The 8 steps (research → plan/method-file → reviews → **user approves** → build via Sonnet → agent QA → background review → ask user to test → **user approves** → next).
- Model routing table (research→Opus subagent, building→Sonnet subagent, trivial→direct).
- Method-file reminder: every increment starts with `docs/methods/NN-<name>.md`.
- Gates explicitly marked (step 4, step 8).

### Step 2 — `.claude/skills/junction-clean-code/SKILL.md`

Junction-specific clean-code conventions for humans + agents. Body covers:
- **Core is pure; edges are thin** — logic in `core`; `cli`/`web`/`mcp/*` only translate.
- **Typed errors** — neverthrow `Result<T,E>` + discriminated-union domain errors; no bare throws across boundaries (cite `docs/rules/typescript.md`).
- **Single purpose per file/unit**; split when a file grows. Each unit answers what/how-to-use/depends-on.
- **Dependency direction** — `core` ← others, never reverse. No HTTP/daemon in `core`.
- **Validate at trust boundaries** with Zod (config load, MCP/API inputs, OAuth responses).
- **Credentials never leave the process**; plaintext only in memory during a call.
- **Tests with Vitest** alongside code; assert behavior not implementation.
- **Scriptable paths stay scriptable** (`--json`/headless for every interactive command).
- **Naming**: `<namespace>__<tool>` for tools; clear, intention-revealing names.
- `description` frontmatter triggers: "writing junction code", "clean code", "code review junction", "how should I structure this".

### Step 3 — `.claude/skills/junction-dev/SKILL.md`

How to run/build/test junction. Starts minimal (foundation not built yet), grows per increment. Body:
- Package manager: **pnpm**. Common commands: `pnpm install`, `pnpm test` (Vitest), `pnpm build` (tsdown), `pnpm -F @junction/core test`.
- CLI (once built): `pnpm -F junction dev -- <args>`, or after build `node packages/cli/dist/index.js`.
- Config home: `~/.junction` (`JUNCTION_HOME` to override — use a temp dir in tests).
- A "grows here" note: update this skill as each increment adds runnable surface.
- `description` frontmatter triggers: "run junction", "build junction", "test junction", "how do I start the cli".

### Step 4 — Active review agent: `.claude/agents/junction-package-boundary.md`

Frontmatter: `name: junction-package-boundary`, `description` ("Reviews changes for junction's package-boundary rules — dependency direction and no-HTTP-in-core. Use when reviewing diffs that touch package imports or core."), `model: inherit`, `tools: Read, Grep, Glob, Bash`.
Body — a focused reviewer that checks:
- No import from `cli`/`web`/`mcp/*` *into* `core` (grep for reverse deps).
- `core` imports no HTTP server / daemon libs (no express/hono/http server in core).
- `mcp/server` and `mcp/client` depend only on `@modelcontextprotocol/sdk` + `core`.
- Reports violations with file:line and the rule cited from CLAUDE.md §Architecture.

### Step 5 — Active review agent: `.claude/agents/junction-clean-code-reviewer.md`

Frontmatter like above; `tools: Read, Grep, Glob, Bash`. Body — reviews recent changes against `junction-clean-code` skill: single-purpose files, oversized files, edges-stay-thin, validation at boundaries, `--json` paths preserved, Vitest behavior-asserting tests present. Confidence-gated findings; cites the skill.

### Step 6 — Stub agents (activate later)

Three files, each valid frontmatter but body clearly marked **STUB — activates at increment N**, describing what it *will* check so it's ready to flesh out:
- `junction-credential-security.md` — **increment 6.** Will check: secret encrypted at rest, plaintext never logged/persisted/returned over MCP, key derivation correctness, store-selection logic, no secrets in errors.
- `junction-mcp-contract.md` — **increment 7.** Will check: `<namespace>__<tool>` naming, per-profile endpoint isolation, transport correctness (stdio/Streamable HTTP, no SSE), input/output schemas, no credential leakage in tool results.
- `junction-tui.md` — **increment 9.** Will check: OpenTUI patterns (per the OpenTUI skill), keyboard/focus handling, `--json`/headless paths still intact, no business logic in the TUI layer.

### Step 7 — `docs/methods/README.md`

Short doc: what method files are, naming (`NN-<increment>.md`), that they hold spec+implementation together and are the Sonnet hand-off, and a table linking each planned increment (0–9) to its method file (00 done; 01–09 TBD).

### Step 8 — Verify & commit

- Sanity-check every file has valid frontmatter (skim each).
- Confirm no contradictions between CLAUDE.md / spec / workflow.md.
- `git add -A && git commit` with a descriptive message.

---

## Review (background, after build)

Run against increment 0:
- **Self-check:** do CLAUDE.md, the design spec, and `docs/workflow.md` tell one consistent story?
- **compound-engineering:ce-project-standards-reviewer** — audits the new agents/skills against frontmatter rules and conventions.
- Fix any inconsistencies inline.

## User test gate

Ask the user to review the scaffolding (skim CLAUDE.md, the skills, the active agents) and approve before increment 1 (monorepo skeleton).
