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
| 0.75 | CI + GitHub governance + Changesets | `00.75-ci-governance-versioning.md` | written |
| 0.9 | OSS-ready patterns (AGPL, README, SECURITY…) | `00.9-oss-ready.md` | written |
| 1 | Monorepo skeleton (+ core module structure) | `01-monorepo-skeleton.md` | written |
| 1.5 | Duplication & boundary tooling | `01.5-duplication-tooling.md` | written |
| 2 | core paths + config layer | `02-core-paths-config.md` | written |
| 3 | cli boots over core | `03-cli-boots.md` | written |
| 4 | Data model in core | `04-data-model.md` | written |
| 5 | Persistence (Drizzle + better-sqlite3) | `05-persistence.md` | written |
| 6 | CredentialStore interface + impls | `06-credential-store.md` | written |
| 7 | mcp/server shell | `07-mcp-server-shell.md` | written |
| 8 | Sandbox core | `08-sandbox.md` | written |
| 9 | TUI dashboard (Ink — OpenTUI is Bun-only) | `09-tui-dashboard.md` | written |
| **— Feature: the work-GitHub wedge (any-source broker; GitHub is just the first test) —** | | | |
| 10 | Generic MCP-source create/mutate ops + connection descriptor (Wedge A) | `10-source-create-ops.md` | written |
| 11 | `@junction/mcp-client` — generic upstream connector + debug probe (Wedge B) | `11-mcp-client.md` | written |
| 12 | Profile proxy — agent calls a real tool through a profile (Wedge C) | `12-profile-proxy.md` | written |
| 13 | MCP source management + visibility (remove/enable/disable/show — goal #1) | `13-source-management.md` | written |
| **— Feature: "any source" breadth (OpenAPI/REST → GraphQL) —** | | | |
| 14 | Source-provider abstraction + dispatch-by-kind (OpenAPI prep — refactor) | `14-source-provider-abstraction.md` | written |
| 15 | OpenAPI/REST source provider — call any REST API as namespaced tools | `15-openapi-provider.md` | written |
| 16 | Optional credentials — public/no-auth sources (any source type) | `16-optional-credentials.md` | done |
| 17 | Source-agnostic debug surface — probe + call any source kind | `17-source-agnostic-debug.md` | done |
| 18 | OpenAPI base-URL resolution (relative servers) + early validation | `18-openapi-base-url-resolution.md` | done |
| 19 | Large-spec selection (--tag/--path) + `platform refresh` | `19-large-spec-selection-refresh.md` | done |
| 20 | GraphQL source provider (query/mutation/schema tools) | `20-graphql-provider.md` | done |
| 21 | Sandboxed code-execution source (`cli` kind) + true Seatbelt read confinement | `21-sandboxed-cli-source.md` | done |
| **— Feature: Web UI → connect-once via OAuth → secured via audit (planned route) —** | | | |
| 22 | Web shell + localhost server (read-only dashboard) | `22-web-shell.md` | done |
| 23 | **Web foundation — design system + quality.** Design-led: shadcn-like UI (Radix + Tailwind, owned `ui/` layer), **Geist** type, design tokens (color/spacing/radius/motion, light+dark), base component inventory + status-badge taxonomy, **Emil-Kowalski-grade motion/transitions** (sonner/vaul/View-Transitions, reduced-motion), WCAG-AA a11y, re-skinned dashboard — distinctive, **not AI-slop**. Plus the quality scaffolding: `docs/rules/web.md`, Biome React domain (hooks rules), happy-dom/Testing-Library component harness, `junction-web-reviewer` agent, CI web gate (`vite build` + client-bundle leak-grep). Brief: `docs/design/web-ui-brief.md` → output `docs/design/DESIGN.md` (**decided**). Shipped as Phases A–E + sidebar/stability rework + anti-slop/react-doctor pass (PR #47). | `23-web-foundation-design-system.md` | done |
| 24 | Web: credentials management + **rotation** (core `rotateCredential` + CLI `credential rotate`; first web write-path — assembles on inc-23 form primitives) | `24-web-credentials-mutation.md` | done |
| 24.5 | **Web: UX foundation** — the **setup increment** (decided with user: "inc 25 is the real work"). A **fresh, Geist-grade design system** (rewrites DESIGN.md: dark+light, Geist Sans/Mono, blue accent, single-endpoint model, the route-row signature; retires the inc-23 instrument system) + the 4 surfaces rebuilt on it (Credentials full/wired, Dashboard full, Profiles full read, Platforms lighter) + a **"Coming soon"** affordance for everything deferred (platform/profile mutations, keys/single-endpoint auth, audit). Plan reviewed (1 blocker + token gaps fixed). The ambitious connect-once reframe is a later pre-public-release increment. Shipped PR #55 (Geist-grade system + route-row signature + ComingSoon; Connect-an-Agent kept stdio-honest). | `24.5-web-ux-foundation.md` | done |
| 24.6 | **Web: UX polish** — designer's-eye pass on the 24.5 UI (impeccable:critique, 28→~33/40). Composition fixes: content uses the width (≈1216px, no dead right half); **2-column dashboard** (Connect-an-Agent primary; At-a-Glance + System secondary; real `@media` collapse to 1-col at 48rem); AgentConfig no longer dimmed (full-contrast + dashed preview border, not blanket opacity); dropped the always-empty Platforms "Base URL" column; consolidated repeated ComingSoon chrome to one CLI line per card; minors (route-row arrows, redundant breadcrumb). No new backends. | (folded into `24.5-web-ux-foundation.md` + DESIGN.md decision log) | done |
| 25 | **Web UX v2** — user-driven IA + functionality revision (13 items). Theme→light/dark only; sidebar groups ([Dashboard, Settings]·[Platforms, Profiles, Credentials], no "Manage" label); badge/table/empty-table patterns; dashboard rethink (Connect-an-Agent full-width hero, aligned At-a-Glance stat strip, no card-in-card); **Settings page + real MCP host** (config `mcpHost` + `JUNCTION_MCP_HOST` env, config wins; bracketed IPv6 ok); **Credentials → flat paginated table + group-dividers** (Variant C, search/sort/pagination); **Profiles → master-detail + the first profile write-path** (add/remove/toggle route w/ credential picker + new/delete profile; filter-edit is ComingSoon — no core op); fixed the Credentials ⋯ click bug (opacity-0→always-visible). Pulled inc-26 profile mutations forward. Shipped phased (5 build commits + a review-gate fix commit; 6-reviewer gate caught 2 HIGH correctness bugs + a missing credential picker). | `25-web-ux-v2.md` | done |
| 26 | **Web: platform & route management** — the web write-paths that retire the Platforms + Edit-tool-access "Coming soon" affordances, over one shared `core` extraction. **Blocking core slice:** extract the `platform add`/`refresh` orchestration (`parseSpec`→`extractTools`→`resolveSpecBaseUrl`→assemble, currently inlined in `cli/commands/platform.ts`) into a reusable `core` op, **and** add `{kind:"setFilter", toolFilter}` to the source-ref repo `SourceOp`/`runSourceMutation`. **Leaf slices (fan out):** web **platform add/edit/delete** (all 5 kinds) · web **toolFilter edit-in-place** ("Edit tool access" becomes real) · **cli rewires** onto the extracted core op (no behaviour change). Plans as a **wave** (`docs/methods/_waves.md`). | `26-web-platform-route-management.md` | planned |
| 27 | **junction-keys / single-endpoint MCP auth** ⚠️ revises a core invariant. Mint per-profile / global / multi-profile API keys (scoped, revocable, hashed-at-rest); a **single shared MCP endpoint** authenticates by key and the **key selects the profile(s)** — replacing today's unauthenticated per-profile `/profiles/{name}/mcp`. Keys table + **auth middleware in `mcp/server`** + web mint/scope/revoke UI + per-key identity (the attribution audit (31) will consume). When built: update CLAUDE.md + the design spec (the "per-profile endpoints, not shared-endpoint filters" invariant) + the AgentConfig "Shared endpoint" ComingSoon. (Split out of the old inc 26.) | — | planned |
| 28 | Web: probe + call (in-browser debug surface) | — | planned |
| 29 | Distribution — publish `junction` + the `junction install` story | — | planned |
| 30 | OAuth vault (arctic) — connect OAuth platforms; token refresh | — | planned |
| 31 | Audit (pino) — structured tool-call / credential-use log (consumes inc-27 per-key identity for attribution) | — | planned |
| 32 | Security & ops hardening — vault backup/recovery + master-key rotation + tool-poisoning mitigation + deferred CI security tooling (knip, type-coverage, semgrep, CodeQL, secret-scan, SPDX CI gate) | — | planned |
| 33 | Code-mode — QuickJS-WASM over the `ToolProvider` proxy (the fast execution path; "base solid" trigger) | — | planned |

> **Re-slice note (inc 23+):** a **design-led Web foundation (23)** lands *before* the mutation increments — the design system + the quality scaffolding it's inseparable from — so feature UI (24+) builds on a real, distinctive design system. Then credentials (24) before platforms (25, which needs the `cli → core` spec-parse extraction). **Inc-23 decisions:** design = minimalistic/shadcn-like/Geist/anti-AI-slop (brief: `docs/design/web-ui-brief.md`); component tests = happy-dom + Testing Library; browser dogfooding = gstack `browse` (Vercel agent-browser = optional swappable layer); CI gates = `vite build` + client-bundle leak-grep; skills = `impeccable:*` + `design-consultation` + emilkowalski/skills (motion). Live state + plan: `docs/STATE.md`.

After increment 8 the foundation is "ready"; increment 9 (TUI) completes it. Features come after, each with its own method file.

## Planned route (Tier 1) vs trigger-deferred (Tier 2)

The table above is the **Tier-1 planned sequence** — what we intend to build, in order. It stays lean and goal-directed: Web UI (22–25) → **web platform/route management (26)** → **junction-keys single-endpoint auth (27)** → probe+call (28) → distribution (29) → **connect-once via OAuth (30)** → **secured via audit (31)** → security/ops hardening (32) → **code-mode (33)** once the base is solid.

Everything else we've weighed — bwrap egress, per-profile HOME isolation, Seatbelt warm-pool / light mode, microVM tier, sandboxing untrusted MCP binaries, SSRF egress for OpenAPI, GraphQL cost limiting, warm-pool sessions, live config reload, networked mode (Streamable-HTTP + better-auth + AGPL §13), per-field GraphQL tools — is **Tier 2: trigger-deferred**, parked in `docs/futures/revisit-when.md`. Those are NOT scheduled; each activates only when its recorded trigger fires. This is deliberate forward-memory, not a backlog to burn down.

**Cross-cutting decisions baked into increment 22** (so the rest builds cleanly): localhost-only (no auth — single-user); the web is a **management** surface, not a second agent API (MCP stays the agent API); the HTTP server is **callback-ready** so OAuth (26) adds a redirect route rather than a new server; `cli`/`web` are sibling apps (no cross-import — `junction web` spawns the web server; both import `core` only).

## Carry-forward notes (raised in review, actioned at the noted increment)

- **Increment 2+ — `tsc -b` project references:** when `cli`/`web`/`mcp/*` start importing `@junction/core`, each consumer's `tsconfig.json` must add `"references": [{ "path": "../core" }]` (mcp packages: `"../../core"`). Otherwise `tsc -b` won't rebuild `core` first, and the one-way edge isn't machine-checked. (Flagged in the increment-1 boundary + standards reviews.)
