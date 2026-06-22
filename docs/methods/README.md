# Method Files

A **method file** holds one increment's **spec + step-by-step implementation together**, in a single self-contained doc. It is the artifact the orchestrator (Opus) hands to a Sonnet builder subagent — self-contained enough that the builder needs no extra context.

- **Naming:** `NN-<increment>.md` (e.g. `03-cli-boots.md`). Scaffolding uses `00` and `00.5`.
- **The design spec** (`docs/specs/2026-06-22-junction-foundation-design.md`) stays the source of truth; method files are its executable slices. No parallel doc trail.
- **Workflow:** see `docs/workflow.md` for the 8-step loop and the approval gates.

## Increment map

| # | Increment | Method file | Status |
|---|---|---|---|
| 0 | Scaffolding (docs, skills, agents) | `00-scaffolding.md` | written |
| 0.5 | Rules & enforcement (docs/rules + hooks) | `00.5-rules-and-enforcement.md` | written |
| 1 | Monorepo skeleton (+ core module structure) | `01-monorepo-skeleton.md` | written |
| 1.5 | Duplication & boundary tooling | `01.5-duplication-tooling.md` | written |
| 2 | core paths + config layer | `02-*.md` | TBD |
| 3 | cli boots over core | `03-*.md` | TBD |
| 4 | Data model in core | `04-*.md` | TBD |
| 5 | Persistence (Drizzle + better-sqlite3) | `05-*.md` | TBD |
| 6 | CredentialStore interface + impls | `06-*.md` | TBD |
| 7 | mcp/server shell | `07-*.md` | TBD |
| 8 | Sandbox core | `08-*.md` | TBD |
| 9 | OpenTUI dashboard | `09-*.md` | TBD |

After increment 8 the foundation is "ready"; increment 9 (TUI) completes it. Features come after, each with its own method file.
