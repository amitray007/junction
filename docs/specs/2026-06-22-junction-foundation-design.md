# Junction — Foundation Design

> **Status:** Approved 2026-06-22. Scope is the **foundation/core only** (web platform + CLI base, the spine, the MCP-serving shell, and the sandbox foundation). No user-facing features until the foundation is complete. Every feature in `docs/idea.md` §3 is preserved as post-foundation scope and re-justified when its increment arrives.

Junction is a self-hosted, single-user **broker**: the one place you connect your platform accounts once, so any AI agent (Claude, ChatGPT, internal tools) can reach that data through MCP / CLI / API — granular, profiled, sandboxed, and secured. See `docs/idea.md` for the full pain log, competitive landscape, and vision.

This document specifies the foundation only. It is the source of truth for the first build cycle.

---

## 1. Guiding decisions (settled)

- **Language/runtime:** TypeScript / Node (Node 22 LTS, floor 20). ESM-only.
- **Build order:** foundation/core first, in small individually-finished increments. **No features** until the core is "ready" (through increment 8). This refines the `docs/idea.md` build order and resolves the gate's "foundation-as-v0" objection by making each foundation increment *actually run and be verified*, not merely scaffolded.
- **Shape:** shared `core` library is the source of truth; CLI and (later) web are thin layers over it. `mcp/server` is extracted up front as a tested shell to avoid the web+MCP-serving repaint that MCPJungle and Executor both hit; `mcp/client` shares the namespace, reserved for source-connecting.
- **The wedge (what makes junction defensible):** one individual, **multiple accounts on the same platform**, switchable per agent — the consumer-personal-multi-account angle the incumbents (enterprise/team gateways) don't serve.

---

## 2. Architecture & package shape

A **pnpm workspace** with a strict one-directional dependency graph (`core` + `mcp/{server,client}` + `cli` + `web`):

```
junction/
├── pnpm-workspace.yaml        # packages: ['packages/*', 'packages/mcp/*']
├── package.json               # root dev scripts, shared devDeps
├── tsconfig.base.json
├── docs/
└── packages/
    ├── core/         @junction/core       — types, catalog, credential store, profile
    │                                        manager, persistence, sandbox interface.
    │                                        NO HTTP server, NO cli/web deps. Pure + tested.
    ├── mcp/
    │   ├── server/   @junction/mcp-server  — McpServer wiring; takes a Profile → registers
    │   │                                     namespaced tools. MCP SDK + core only.
    │   │                                     Starts as an empty tested shell (increment 7).
    │   └── client/   @junction/mcp-client  — consumes upstream MCP sources. MCP SDK + core only.
    │                                         Reserved/stubbed; built when source-connecting lands.
    ├── cli/          junction             — thin: argv → core. `serve` (later) calls mcp/server.
    └── web/          @junction/web         — (later) imports core directly.
```

Both MCP directions live under one `mcp/` namespace (two-word package dirs avoided): **`mcp/server`** serves agents, **`mcp/client`** consumes upstream sources. `mcp/client` is reserved now and built when real source-connecting arrives (post-foundation).

**Dependency rule (load-bearing):** `core` depends on nothing in the repo. `mcp/server`, `mcp/client`, `cli`, and `web` may depend on `core`. Never the reverse. `core` contains no HTTP server and no I/O daemon, so it stays embeddable and testable.

**Daemon:** deferred. There is no long-running process in the foundation. When MCP-serving demands it, `junction serve` becomes a new entry-point that calls the existing `mcp/server` package — no repaint. The web app (when built) imports `core` directly rather than talking to a daemon.

---

## 3. The stack (validated 2026)

| Area | Pick | Notes / runner-up |
|---|---|---|
| Monorepo | **pnpm workspaces** | Add Turborepo only when builds hurt (~5+ pkgs). |
| Build | **tsdown** (+ `publint` + `attw`) | Rolldown-based successor to tsup (maintenance-only). |
| CLI framework | **citty** (unjs) | Zero-dep, native `parseArgs`, lazy subcommands. Runner-up: commander. The command/argument layer — owns `junction <cmd>`, flags, `npx` entry. |
| Interactive prompts | **@clack/prompts** | Lightweight inline prompts for the `init` wizard. Kept separate from the parser, lazy-imported. Superseded by OpenTUI for the full-screen dashboard surface (see §5 ADR + increment 9). |
| Config home | **`~/.junction`** (explicit, `JUNCTION_HOME` override) + **env-paths** for cache | Predictable for a self-hosted broker. |
| File locking | **proper-lockfile** | Atomic `mkdir` locks; wrap every mutating write. |
| Secrets at rest | **`CredentialStore` interface** → **@napi-rs/keyring** + **AES-256-GCM** file store (node:crypto) | keytar is dead. Keyring for desktop; encrypted file is the server default. |
| Validation | **Zod v4** | Shared types via `z.infer`. Standard Schema → later Valibot swap at the web edge is localized. |
| Error handling | **neverthrow `Result<T,E>`** + typed domain error unions | Typed errors without Effect-TS's cost (see §5a). The `junction-clean-code-reviewer` enforces "no floating Results" (an `eslint-plugin-neverthrow` rule could add this if ESLint is ever introduced for that niche — Biome remains the loop). Drizzle transactions work naturally. |
| Resource cleanup | TS 5.2 **`using` / `Symbol.asyncDispose`** | For the few cases needing guaranteed cleanup; no Effect `Scope` needed. |
| Retries | **p-retry** (or a small helper) | Declarative retry/backoff for the future MCP client; no Effect `Schedule`. |
| Lint + format | **Biome** (one Rust binary) | format + lint + import-organize, sub-second. No ESLint/Prettier sprawl. |
| Type-check | **`tsc -b`** now → **tsgo (TS7)** at GA | tsgo is RC, ~10× faster; our tsconfig is already compatible. Swap the binary when GA. |
| Testing | **Vitest** (+ `related`/`--changed` for the loop) | Best TS/ESM DX, v8 coverage. Related-only keeps the loop fast. |
| Dead code / deps | **knip** | Finds unused files/exports/deps + broken workspace edges — enforces the dependency rule. |
| Type safety gate | **type-coverage** (≥99%) | Fails CI if `any` creeps in — matters for a credential broker. |
| Git hooks | **lefthook** | Go binary, parallel, native staged-file scoping (no lint-staged). |
| Logging | **pino** (machine/audit) + **consola** (human CLI) | pino async + structured; never sync-blocking. |
| TS config | ESM-only, `module/moduleResolution: nodenext`, `target: es2023`, Node 22 LTS | One ESM build serves both the Node CLI and the web app. |

The repo-wide convention: **`pnpm verify` = typecheck + biome + vitest** — the cheap gate every hook and increment keys off (see §7 + `docs/rules/`).

**Banned / avoid:** keytar (archived), legacy `inquirer`, Jest (new ESM repo), oclif (thin CLI), Nx/Turborepo/lerna day-one, `conf` as primary store, **Effect-TS** (§5a), **ESLint+Prettier as the loop** (too slow), **ts-prune** (dead → knip), **Million.js/Million Lint** (superseded by React Compiler).

### `tsconfig.base.json` (core)

```jsonc
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "lib": ["es2023"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "composite": true
  }
}
```

(`composite: true` enables `tsc -b` **project references** — each package has its own tsconfig extending this base, and a root solution `tsconfig.json` lists them. This is how the monorepo typechecks as a graph.)

`core/package.json`: `"type": "module"`, an `exports` map with the main barrel **plus a `./testing` subpath** for test helpers (`types` + `import` each), `"engines": { "node": ">=20" }`. Validate every publish with publint + attw.

---

## 4. Core abstraction model (the data model)

The key insight from prior art (Executor, MCPJungle, Docker MCP Gateway, plus `~/.aws/credentials` and `~/.ssh/config`):

> **`Credential` — not `Platform` — is the unit a `Profile` references.** This single decision encodes the multi-account wedge.

```ts
// A supported external system. Exists once in the catalog.
type Platform = {
  id: string;            // "github", "linear", "openapi:acme"
  kind: "mcp" | "openapi" | "graphql" | "cli" | "custom";
  displayName: string;
  specUrl?: string;      // openapi/graphql/discovery sources
  baseUrl?: string;      // self-hosted instance override
};

// One account's keys for one Platform. MANY per Platform — this is the wedge.
type Credential = {
  id: string;
  platformId: string;    // FK → Platform
  profileName: string;   // "work", "personal", "client-acme"
  kind: "api-key" | "bearer" | "oauth2" | "file" | "env";
  secret: EncryptedBlob; // encrypted at rest; plaintext only in memory during a call
  oauthMeta?: OAuthMeta; // refresh token/expiry/scopes — slot present day one, refresh loop later
};

// What an agent sees. Gets its OWN MCP endpoint (/profiles/{name}/mcp).
type Profile = {
  id: string;
  name: string;
  sources: SourceRef[];
  mcpEndpointPath: string; // "/profiles/work/mcp"
};

// An activated (Platform, Credential) pair inside a Profile.
type SourceRef = {
  platformId: string;
  credentialId: string;
  toolNamespace: string;   // "github_work" — collision-free
  enabled: boolean;
};
```

**Conventions adopted day one (renaming later breaks every agent prompt):**
- **Double-underscore tool namespacing:** `<namespace>__<tool>` (e.g. `github_work__list_issues`).
- **Per-profile endpoints**, not filters on a shared endpoint. An agent points at a profile URL; the account switch happens at *connection* time, not call time (the `~/.aws` + Chrome-profile pattern).

**Credential security invariant:** credential plaintext never leaves the process. The MCP endpoint never returns credential values; secrets are injected at tool-call time and exist in plaintext only in memory.

### 4a. Data architecture & rollout (how it grows without rewrites)

The data model is designed so future entities slot in additively. Principles:

- **Drizzle as the single schema authority.** All persisted entities are defined in `core` as Drizzle tables; types are *derived* from the schema (`$inferSelect`/`$inferInsert`), and the Zod schemas validate at boundaries. One source of truth, no drift.
- **Versioned migrations from day one.** `drizzle-kit` migrations are committed and forward-only. Increment 5 establishes the migration workflow even with a tiny schema, so every later table is an additive migration — never a hand-edit.
- **Stable IDs + soft references.** Entities use opaque string IDs (e.g. ULID/uuid). `secret` values are **not** stored inline in the main tables — the row holds a *reference/handle*, and the actual ciphertext lives via the `CredentialStore` (keyring or encrypted file). This keeps the DB free of plaintext and lets the secret backend change independently.
- **The growth path (additive, each its own migration):**
  - *Foundation:* `platforms`, `credentials`, `profiles`, `source_refs`.
  - *OAuth (later):* `oauthMeta` already reserved on `Credential`; a `token_refreshes` table can be added without touching existing rows.
  - *Auditing (later, idea §3.8):* an append-only `audit_events` table (its own write path via pino → DB), referencing token/profile IDs. Append-only means no schema churn on existing entities.
  - *Knowledge base (later, idea §3.7):* a `kb_entries` table keyed by `platformId`/`sourceRef`, additive.
  - *Scoped external tokens (later, idea §3.2):* a `minted_tokens` table referencing a profile/platform/source scope. The scope granularity (`profile | platform | source | finer`) is expressible as columns, not a redesign.
- **Repository layer in `core`** wraps Drizzle so callers depend on intent-revealing methods (`profiles.create`, `credentials.forPlatform`) — not raw queries. Swapping better-sqlite3 → libsql later is a driver change behind the repository, not a caller change.
- **No premature multi-tenancy.** Single-user means no `user_id` columns; if junction ever goes multi-user, that's a deliberate additive migration, not a constraint we carry now.

---

## 5. Future-domain decisions (ADRs — recorded now, installed later)

Committed choices so we never improvise a dependency mid-increment. **Nothing here is installed until its increment arrives.**

| Domain | Decision | Rationale |
|---|---|---|
| Web auth | **Local passphrase + signed session cookie** now; **better-auth** only when remote/multi-device arrives | A localhost single-user broker needs no IdP. |
| Web framework | **TanStack Start** (React + Vite) | Vite-fast local dev, imports core directly, deploys to own server. |
| MCP | **`@modelcontextprotocol/sdk`** — `Client` to consume sources, `McpServer` to serve agents | stdio for local child-process sources, Streamable HTTP for remote. **SSE deprecated.** |
| OAuth / token vault | **arctic** for the broker's per-provider token store | Per-provider `refreshAccessToken()`. junction owns its own encrypted token table. |
| Persistence | **Drizzle ORM + better-sqlite3** | Code-first TS schema, single file, zero infra. Cheap swap to libsql later. |
| Audit logging | **pino** (machine audit trail) + **consola** (human CLI output) | Don't conflate the two streams. |
| Terminal UI | **OpenTUI** (React/Solid reconciler) | Full-screen interactive TUI dashboard (profiles/platforms/status). Layers *on top of* citty — bare `junction` launches the TUI; commands stay scriptable. Replaces @clack/prompts for rich interaction. Deferred to increment 9 to keep the CLI base lean. |
| Sandbox | see §6b | — |

**Load-bearing structural call:** *web login* and *the broker's platform-token vault* are two different problems. The vault (arctic + encrypted Drizzle table + keyring) lives in **`core`** and exists regardless of whether a web UI ships. better-auth, if adopted, only handles human login on the web app — it **never owns platform tokens.** This is why `Credential` is a core concept, not a web concept.

**Banned:** Lucia (dead), Clerk/WorkOS (hosted), better-auth's generic-OAuth refresh as the vault (buggy — arctic owns refresh).

### 5a. Evaluated and rejected (decision records)

- **Effect-TS — rejected for now.** Powerful (typed errors, Layers/DI, structured concurrency), but the costs don't fit junction today: better-sqlite3 is synchronous and Drizzle transactions force constant `Effect.runPromise` unwrapping; citty's command model fights Effect's lazy evaluation; and the steep learning curve + bespoke DSL is a contributor/OSS barrier for a solo project. **Instead:** neverthrow `Result<T,E>` + typed domain-error unions get ~75–80% of the daily value at ~5% of the cost, with `using` for cleanup and p-retry for retries. **Revisit when:** multiple concurrent MCP clients, sandbox process-isolation, or complex fan-out workflows make structured concurrency earn its keep (`@effect/workflow` could fit the sandbox then).
- **react-doctor — deferred to the web increment, never in the loop.** Useful React audit, but ~90% of junction is non-React Node code. At the web increment (post-9): `eslint-plugin-react-hooks` (core rules in loop, heavy rules CI-only) + **React Compiler** (auto-memoization — the real perf answer; obsoletes Million) + **React Scan** (on-demand devtool). react-doctor itself = optional one-shot `npx` audit, not wired into the per-edit loop.

### 5b. QA loop & enforcement (the "never ship broken code" machinery)

A tiered, cost-aware loop so verification is cheap and broken code is mechanically unshippable:

- **Per-edit (`.claude/settings.json` PostToolUse hook): fast only.** `biome check --write` on the edited file. Sub-second. **No typecheck/tests here** (avoids the per-edit slowness trap).
- **Pre-commit (lefthook): the real gate.** `pnpm verify` (typecheck + biome + vitest); blocks on failure. Committing broken code becomes impossible. (This is the commit gate — it lives in lefthook, not `.claude/settings.json`.)
- **Boundary guard (`.claude/settings.json` PreToolUse hook): blocks banned patterns** in the edit — cli/web/mcp→core imports, HTTP/daemon libs in `core`, `node:vm`/`vm2` anywhere, `fs.*Sync` in `core`/server paths. Turns the package-boundary rules into a wall, not just a review.
- **Pre-push (lefthook) / session-end: heavy CI pass.** Full `tsc -b`, vitest+coverage, knip, publint/attw, type-coverage threshold, and a **targeted semgrep** on sandbox/secrets paths only.

Hook config is split: the **commit/push gate is lefthook** (`lefthook.yml`); the **per-edit format + boundary guard are Claude Code hooks** (`.claude/settings.json`). Both are project-committed so they govern every agent/increment. The mechanical rules trace back to `docs/rules/` (see §7).

---

## 6. Foundation increments (in order)

Each increment is a complete, tested, runnable thing. The §7 workflow loop runs on each.

**Phase 0 — Scaffolding & guardrails (no package code)**
- **0. Scaffolding** — CLAUDE.md, workflow doc, clean-code + dev skills, review agents (see §7 + method file `00`).
- **0.5. Rules & enforcement** — `docs/rules/` (per-language guardrails: `typescript.md`, `testing.md`, `performance.md`, `security.md`) + the QA-loop wiring: root `pnpm verify` script, Biome + lefthook + `.claude/settings.json` hooks (per-edit format, pre-commit verify, boundary guard). *Proof:* hooks fire on a throwaway edit/commit; a deliberately-broken edit is blocked. **This lands before increment 1 so all package code is governed from line one.**

**Phase A — Repo & CLI base**
1. **Monorepo skeleton** — pnpm workspace (`packages/*` + `packages/mcp/*`), `tsconfig.base`, Vitest, tsdown, Biome config, the packages wired via `workspace:*`. *Proof:* `pnpm verify` passes on empty packages.
2. **`core` paths + config layer** — `~/.junction` home (`JUNCTION_HOME` override), env-paths cache, proper-lockfile, Zod-validated JSON config. *Proof:* read/write/lock unit tests; config round-trips.
3. **`cli` boots over core** — citty CLI: `junction init` (creates home, writes default config via @clack/prompts) + `junction status` (reads + prints, `--json` supported). *Proof:* `npx junction init` then `status` works end-to-end. The terminal experience has three layers: **citty** owns `junction <cmd>` + flags + the `npx` entry; **@clack/prompts** handles inline wizard steps; **OpenTUI** (increment 9) becomes the full-screen interactive surface. Scriptable/`--json` paths always remain so agents can drive the CLI.

**Phase B — The spine (typed, persisted, no features)**
4. **Data model in `core`** — `Platform`/`Credential`/`Profile`/`SourceRef` Zod schemas + inferred types; `__` namespace + per-profile-endpoint conventions encoded. *Proof:* schema tests incl. the wedge (two GitHub credentials, one platform).
5. **Persistence** — Drizzle + better-sqlite3, migrated schema, repository layer in `core`. *Proof:* CRUD tests; `junction profile list` reads an empty table.
6. **`CredentialStore` interface + impls** — interface, `KeyringStore` (@napi-rs/keyring), `EncryptedFileStore` (AES-256-GCM), runtime selection by environment. *Proof:* secrets round-trip encrypted; a test asserts plaintext never hits disk.

**Phase C — MCP-serving shell**
7. **`mcp/server` shell** — package wired to the MCP SDK; an `McpServer` that takes a Profile and registers **zero** tools yet; stdio transport. (`mcp/client` reserved, built post-foundation.) *Proof:* an MCP client connects to a profile endpoint and lists (empty) tools.

**Phase D — Sandbox foundation**
8. **Sandbox core** — the `Sandbox` interface + the Deno/bubblewrap impl (§6b), exercised by a trivial "run this, return output" test. *Proof:* a scoped Deno eval and a bubblewrapped command run and return output under restriction.

**Phase E — Terminal UI**
9. **OpenTUI dashboard** — bare `junction` launches a full-screen TUI (profiles, platforms, status), rendered over `core`. citty commands and `--json` paths remain for scripting/agents. *Proof:* the TUI lists profiles/platforms from the DB and reflects live state; `junction status --json` still works headless.

**After increment 8 the foundation is "ready"** (the spine + MCP shell + sandbox). Increment 9 (TUI) is a foundation-completing polish layer, not a feature. Only after that do we discuss the first real feature (connecting an actual platform — likely work-GitHub, the wedge), each re-justified as it comes up.

### 6b. Sandbox decision (increment 8)

Dual-execution needs different tools for different jobs, all behind one `Sandbox` interface in `core`:

| Need | Pick | Why |
|---|---|---|
| Run agent-authored JS/TS | **Deno subprocess** (`--no-prompt --allow-*` scoped) | Real, enforced, capability-based boundary; self-hosted, no KVM. |
| Run platform CLIs safely | **bubblewrap (Linux) / Seatbelt (macOS)** | Syscall-level FS+network restriction, zero containers. What Claude Code & Codex ship (`@anthropic-ai/sandbox-runtime` is the reference). |
| Escalation (hostile code, arbitrary npm) | **microsandbox** (libkrun microVM, <100ms) | Hardware-isolated VM per execution; self-hosted; both JS + CLI. Added when needed. |
| Optional semantic layer | **just-bash** (vercel-labs) | TS bash simulator on a virtual FS — convenience only, **never** the isolation boundary. |

**Banned in junction:** `node:vm`, `vm2` (CVSS-10 RCEs in 2026), just-bash-as-security-boundary. `isolated-vm` is maintenance-mode — avoid unless bubblewrap+Deno is impractical.

---

## 7. Engineering scaffolding & guardrails (built FIRST — increments 0 + 0.5, before any package code)

All of the following are written before increment 1, so every increment is governed from line one. Increment **0** is the docs/skills/agents; increment **0.5** is `docs/rules/` + the enforcement wiring.

1. **`CLAUDE.md` (root)** — the **operating model** (orchestrator-Opus thinks/plans/reviews; **research → Opus subagents, building → Sonnet subagents**; delegate by default, only trivial changes done directly; **method files** as the per-increment spec+implementation hand-off in `docs/methods/`), the decided stack, the package shape, the hard boundary rules, the banned lists, and pointers to the rules/workflow/skills below. **Written.**
2. **Per-increment workflow checklist** (`docs/workflow.md`) — the 8-step loop (below) as a durable doc the agents follow every increment.
3. **`docs/rules/` — per-language guardrails (write FIRST, before any code).** The enforceable "we never write bad code" layer:
   - `README.md` — how rules are enforced (skills cite them, hooks check mechanical ones, review agents audit them).
   - `typescript.md` — the TS rule set: neverthrow `Result` for fallible ops (no bare throws across boundaries), discriminated-union domain errors, `using` for cleanup, no `any`/no non-null-assertions, validation at boundaries with Zod, file-size/single-purpose, intention-revealing names, ESM import hygiene.
   - `testing.md` — Vitest conventions; what "QA-able per change" means (every change ships with a behavior test + passes `pnpm verify`); no implementation-coupled assertions.
   - `performance.md` — performance-by-default: no `fs.*Sync` in core/server, async/structured logging (pino), avoid event-loop blocking, lazy-import heavy deps, `vitest bench` only for hot paths (credential crypto, MCP dispatch, sandbox spawn).
   - `security.md` — credential plaintext never logged/persisted/returned; banned (`vm2`/`node:vm`, etc.); secrets-in-errors forbidden.
4. **QA-loop enforcement wiring** (increment 0.5) — root `pnpm verify` (typecheck + Biome + Vitest), Biome config, lefthook hooks (pre-commit verify), and `.claude/settings.json` Claude Code hooks (per-edit `biome --write`, pre-commit verify gate, PreToolUse boundary guard for banned imports). Realizes §5b.
5. **Clean-code / dev skills** — `junction-clean-code` (guidance pointing at `docs/rules/`) and `junction-dev` (how to run/build/test; grows per increment).
6. **Custom review agents:**
   - *Active now:* **package-boundary reviewer** (dependency-direction + no-http-in-core) and **clean-code reviewer** (audits against `docs/rules/`).
   - *Stubbed until their target code lands:* **credential-security** (increment 6), **MCP-contract** (increment 7), **sandbox-security** (increment 8), **TUI** (increment 9).
   - Everything else (correctness, security, performance, architecture, testing, …) comes free from the installed compound-engineering plugin — not rebuilt.

### Operating model & method files

- **Orchestrator (Opus) is the brain:** thinks, researches, plans, prepares jobs, reviews. Does not usually write implementation itself.
- **Model routing:** research → **Opus** subagents; building features/fixes → **Sonnet** subagents. **Delegate by default**; only do super-simple/small changes directly.
- **Method file:** before any increment, the orchestrator writes one file — `docs/methods/NN-<increment>.md` — containing the increment's **mini-spec + step-by-step implementation together**. It is the self-contained artifact used to delegate the build to a Sonnet subagent. The project design spec stays the source of truth; `writing-plans` output becomes these method files (no parallel doc trail).

### The per-increment workflow (8 steps)

For each increment:
1. **Research** the problem.
2. **Plan around the codebase** — best tooling/components, whether a new package is needed, architectural questions.
3. **Produce a plan** with a final set of reviews.
4. **User approves** → build.
5. **Agent QA / tests** it.
6. **Background review** (compound-engineering + custom reviewers).
7. **Ask the user to test.**
8. **User approves** → next increment.

Approval gates at step 4 (plan) and step 8 (after testing), every increment.

---

## 8. Out of scope (foundation)

Deferred to post-foundation, each re-justified when built: connecting real platforms, OAuth refresh loops, the web UI itself, the knowledge base (idea §3.2/3.7), scoped external API token minting (§3.2), auditing UI (§3.8), secret-manager reuse UX (§3.6), code-style execution features (§3.3 — the sandbox *foundation* is in scope; the feature is not), and the long-running daemon.
