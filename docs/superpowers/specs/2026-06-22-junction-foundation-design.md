# Junction — Foundation Design

> **Status:** Approved 2026-06-22. Scope is the **foundation/core only** (web platform + CLI base, the spine, the MCP-serving shell, and the sandbox foundation). No user-facing features until the foundation is complete. Every feature in `docs/idea.md` §3 is preserved as post-foundation scope and re-justified when its increment arrives.

Junction is a self-hosted, single-user **broker**: the one place you connect your platform accounts once, so any AI agent (Claude, ChatGPT, internal tools) can reach that data through MCP / CLI / API — granular, profiled, sandboxed, and secured. See `docs/idea.md` for the full pain log, competitive landscape, and vision.

This document specifies the foundation only. It is the source of truth for the first build cycle.

---

## 1. Guiding decisions (settled)

- **Language/runtime:** TypeScript / Node (Node 22 LTS, floor 20). ESM-only.
- **Build order:** foundation/core first, in small individually-finished increments. **No features** until the core is "ready" (through increment 8). This refines the `docs/idea.md` build order and resolves the gate's "foundation-as-v0" objection by making each foundation increment *actually run and be verified*, not merely scaffolded.
- **Shape:** shared `core` library is the source of truth; CLI and (later) web are thin layers over it. `mcp-server` is extracted up front as a tested shell to avoid the web+MCP-serving repaint that MCPJungle and Executor both hit.
- **The wedge (what makes junction defensible):** one individual, **multiple accounts on the same platform**, switchable per agent — the consumer-personal-multi-account angle the incumbents (enterprise/team gateways) don't serve.

---

## 2. Architecture & package shape

A **pnpm workspace**, 4 packages, with a strict one-directional dependency graph:

```
junction/
├── pnpm-workspace.yaml        # packages: ['packages/*']
├── package.json               # root dev scripts, shared devDeps
├── tsconfig.base.json
├── docs/
└── packages/
    ├── core/        @junction/core      — types, catalog, credential store, profile
    │                                       manager, persistence, sandbox interface.
    │                                       NO HTTP server, NO cli/web deps. Pure + tested.
    ├── mcp-server/  @junction/mcp-server — McpServer wiring; takes a Profile → registers
    │                                       namespaced tools. Depends only on the MCP SDK + core.
    │                                       Starts as an empty tested shell.
    ├── cli/         junction            — thin: argv → core. `serve` (later) calls mcp-server.
    └── web/         @junction/web        — (later) imports core directly.
```

**Dependency rule (load-bearing):** `core` depends on nothing in the repo. `mcp-server`, `cli`, and `web` may depend on `core`. Never the reverse. `core` contains no HTTP server and no I/O daemon, so it stays embeddable and testable.

**Daemon:** deferred. There is no long-running process in the foundation. When MCP-serving demands it, `junction serve` becomes a new entry-point that calls the existing `mcp-server` package — no repaint. The web app (when built) imports `core` directly rather than talking to a daemon.

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
| Testing | **Vitest** | Best TS/ESM DX, v8 coverage. |
| TS config | ESM-only, `module/moduleResolution: nodenext`, `target: es2023`, Node 22 LTS | One ESM build serves both the Node CLI and the web app. |

**Banned / avoid:** keytar (archived), legacy `inquirer`, Jest (new ESM repo), oclif (thin CLI), Nx/Turborepo/lerna day-one, `conf` as primary store.

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
    "noUncheckedIndexedAccess": true
  }
}
```

`core/package.json`: `"type": "module"`, single `exports` map (`types` + `import`), `"engines": { "node": ">=20" }`. Validate every publish with publint + attw.

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

---

## 6. Foundation increments (in order)

Each increment is a complete, tested, runnable thing. The §7 workflow loop runs on each.

**Phase A — Repo & CLI base**
1. **Monorepo skeleton** — pnpm workspace, `tsconfig.base`, Vitest, tsdown, 4 empty packages wired via `workspace:*`. *Proof:* `pnpm test` + `pnpm build` pass.
2. **`core` paths + config layer** — `~/.junction` home (`JUNCTION_HOME` override), env-paths cache, proper-lockfile, Zod-validated JSON config. *Proof:* read/write/lock unit tests; config round-trips.
3. **`cli` boots over core** — citty CLI: `junction init` (creates home, writes default config via @clack/prompts) + `junction status` (reads + prints, `--json` supported). *Proof:* `npx junction init` then `status` works end-to-end. The terminal experience has three layers: **citty** owns `junction <cmd>` + flags + the `npx` entry; **@clack/prompts** handles inline wizard steps; **OpenTUI** (increment 9) becomes the full-screen interactive surface. Scriptable/`--json` paths always remain so agents can drive the CLI.

**Phase B — The spine (typed, persisted, no features)**
4. **Data model in `core`** — `Platform`/`Credential`/`Profile`/`SourceRef` Zod schemas + inferred types; `__` namespace + per-profile-endpoint conventions encoded. *Proof:* schema tests incl. the wedge (two GitHub credentials, one platform).
5. **Persistence** — Drizzle + better-sqlite3, migrated schema, repository layer in `core`. *Proof:* CRUD tests; `junction profile list` reads an empty table.
6. **`CredentialStore` interface + impls** — interface, `KeyringStore` (@napi-rs/keyring), `EncryptedFileStore` (AES-256-GCM), runtime selection by environment. *Proof:* secrets round-trip encrypted; a test asserts plaintext never hits disk.

**Phase C — MCP-serving shell**
7. **`mcp-server` shell** — package wired to the MCP SDK; an `McpServer` that takes a Profile and registers **zero** tools yet; stdio transport. *Proof:* an MCP client connects to a profile endpoint and lists (empty) tools.

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

## 7. Engineering scaffolding (built FIRST — increment 0, before any package code)

All of the following are written before increment 1, so every increment is governed from line one.

1. **`CLAUDE.md` (root)** — the decided stack, the 4-package shape, the hard boundary rules (core has no cli/web/http deps; credentials never leave the process; `__` namespacing; per-profile endpoints), the banned lists, and pointers to the workflow + skills below.
2. **Per-increment workflow checklist** — the 8-step loop (below) as a durable doc the agents follow every increment.
3. **Clean-code / codebase-quality skills** — junction-specific guidance for humans *and* agents: file-size/single-purpose boundaries, naming, error-handling conventions, the "core is pure, edges are thin" rule, Vitest test conventions, and keeping the dependency graph honest (`core` ← others, never reverse).
4. **`junction` project skill** (starts minimal) — how to run/build/test: pnpm commands, launching the CLI, running the web app later. Grows with the project.
5. **Custom review agents:**
   - *Active now:* **package-boundary reviewer** (enforces dependency-direction + no-http-in-core) and **clean-code reviewer** (tuned to the skills in #3). A **TUI reviewer** (OpenTUI patterns) activates at increment 9.
   - *Stubbed until their target code lands:* **credential-security reviewer** (activates at increment 6), **MCP-contract reviewer** (activates at increment 7).
   - Everything else (correctness, security, performance, architecture, testing, …) comes free from the installed compound-engineering plugin — not rebuilt.

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
