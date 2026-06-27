# Junction — Project State & Session Handover

> **New session? Read this file FIRST, then `CLAUDE.md`.** This is the living
> "where we are / how we work / how to resume" memory. It is the single source of
> truth for cross-session continuity. **Keep it current** — updating it is the last
> step of every increment (see the `junction-handover` skill).

_Last updated: 2026-06-27 (after increment 22 + dev tooling)._

<!-- STATE-done-through: 22 -->
<!-- ^ Machine-readable freshness marker. Bump it to the highest increment marked
     `done` in docs/methods/README.md whenever you complete one. The `docs:check`
     gate (in `pnpm verify`) FAILS if this lags the map — so the memory can't go
     stale silently. Bumping it = "I logged this increment" (also add a §7 entry). -->

---

## 1. Snapshot — where we are right now

- **On `main`:** increments 0–22 + dev tooling. junction brokers **MCP · OpenAPI/REST · GraphQL · sandboxed-CLI** sources, with multi-account credentials, profiles (namespacing + toolFilter), a per-profile MCP serve endpoint, an OS sandbox (Seatbelt/bwrap/Deno) with true read-confinement, a TUI dashboard, and a **read-only web dashboard** (`junction web`).
- **Latest merged:** PR #41 (workflow.md builder-brief + verification discipline). `main` is clean; **no open PRs**; no in-flight branches.
- **Immediate next:** **increment 23 — Web foundation: design system + quality** (design-led). Minimalistic, shadcn-like, **Geist** type, design tokens, base components + status badges, Emil-Kowalski-grade motion, WCAG-AA a11y, re-skinned dashboard — distinctive, **not AI-slop** — plus the quality scaffolding (rules/web.md, Biome React domain, happy-dom/Testing-Library harness, `junction-web-reviewer`, CI web gate). **Design brief: `docs/design/web-ui-brief.md`.** Lands *before* the web mutation increments. Not started — **write the method file first** (invoke the design skills; see brief).
- **The plan lives in** `docs/methods/README.md` (the increment map, Tier-1 sequence 23→31) and `docs/futures/revisit-when.md` (Tier-2 trigger-deferred).

## 2. How we work (the operating loop) — don't reinvent it

Full detail in `CLAUDE.md`. The essentials a new agent must internalize:

- **Orchestrator = brain; subagents = hands.** The top-level (Opus) thinks, plans, prepares jobs, reviews. It does **not** hand-write non-trivial implementation. **Building → a Sonnet subagent** (from a self-contained method file). **Research → an Opus subagent** when deep.
- **One method file per increment** (`docs/methods/NN-*.md`): spec + plan + proof-of-done + which reviewers + the user test gate. The builder works *from* it.
- **Per-increment loop:** research → method file (commit on a `docs/method-NN` branch) → Sonnet builds → **orchestrator independently QAs against the real built code** (never trusts the builder's claim) + an **end-to-end run against a real/local source** → **multi-lens review gate** (relevant reviewers in parallel) → fix findings → push → PR → CI → **merge** → **end-of-increment report + update the registers + update THIS file**.
- **Gates:** `pnpm verify` (tsc + Biome + Vitest) is THE gate; CI also runs depcruise + quality + gitleaks on both Node 20 & 22. `main` is branch-protected (PR-only, require-up-to-date).
- **Behaviours** (`docs/behaviours/`): correctness/security over speed · architecture over expedience · hold decisions loosely (recommend, surface real decisions to the user). These are non-negotiable.
- **Dev/test:** `./junction <cmd>` runs the built CLI against the persistent repo-local `.junction` home (gitignored). Orchestrator QA uses **ephemeral `/tmp/jtNN` per increment** (isolated, disposable). Rebuild after source changes: `pnpm build`.
- **Two high-leverage details live in `docs/workflow.md`:** the **builder-brief template** (what a good delegation contains — read-first / exact-changes / hard-invariants / do-NOT / report-back) and the **verification discipline** (drive the real built artifact, right instrument, adversarial e2e for security increments). Don't delegate or QA without them.

## 3. Session-critical traps — these bit us repeatedly; do NOT relearn them

(Full list: `docs/futures/gotchas.md`. These are the ones that recur across agents.)

- **Exhaustiveness regression (bit 3×):** builders keep "fixing" phantom `tsc` errors on error-formatter switches by adding a non-exhaustive `default` or `const _: never = e as never`. **This is wrong.** TS 6.0.3 narrows exhaustive switches fine; the phantom errors are **stale `.tsbuildinfo`** → fix with **`pnpm build`**, never by weakening the `never`-guard. **Never run `tsc -b --force`** — it emits into the tsdown `dist/`, clobbering the runnable bin and breaking the child-process tests.
- **push → PR race:** after `git push`, the pre-push hook delays the ref update; `gh pr create` immediately after often fails ("No commits between…"). **Confirm the remote ref (`git ls-remote`) or just retry the push, then create the PR.**
- **Stacked PRs:** merging a PR and deleting its base branch **closes** (does NOT retarget) the dependent PRs. Either retarget children to `main` *before* merging the parent, or recreate them. Use **merge commits, not squash**, for stacked work (squash rewrites SHAs → the child shows a conflicting diff).
- **Branch protection:** never push to `main` directly (rejected). Each PR must be up-to-date → `gh pr update-branch`, then wait for CI, then merge.
- **Security invariants:** credentials **never leave the process / never appear in output**; the web is **server-only core** (`createServerFn`/`*.server.ts` — native deps must NOT reach the client bundle; verify with the leak grep); the sandbox is **least-privilege, no-shell, argv-array, fail-closed**.

## 4. The plan (Tier-1 sequence — re-sliced)

See `docs/methods/README.md` for the canonical table. Summary of what's NEXT:

| # | Increment | Note |
|---|---|---|
| **23** | **Web foundation: design system + quality** | **Design-led** (brief: `docs/design/web-ui-brief.md` → output `DESIGN.md`): minimalistic/shadcn-like, Geist type, tokens (color/spacing/radius/motion, light+dark), base components + status-badge taxonomy, Emil-Kowalski-grade motion (sonner/vaul/View-Transitions, reduced-motion), WCAG-AA a11y, re-skinned dashboard, **not AI-slop**. Plus quality: `docs/rules/web.md`, Biome React domain, happy-dom/Testing-Library harness, `junction-web-reviewer`, CI gate (`vite build` + leak-grep). Skills: `impeccable:*` + `design-consultation` + emilkowalski/skills. **Before the mutation increments.** May phase. |
| 24 | Web credentials management + **rotation** | first web write-path; `rotateCredential` in core + `credential rotate` CLI (core cred ops already exist → clean) |
| 25 | Web platform management | includes extracting platform add/refresh orchestration **`cli → core`** so web+cli share it |
| 26 | Web profile management | sources / toolFilter editor / copy MCP endpoint |
| 27 | Web probe + call | in-browser debug surface |
| ~ | Distribution | publish `junction` + `junction install` |
| 28 | OAuth vault (arctic) | the big "connect once" expansion + token refresh; uses inc-22's callback-ready server |
| 29 | Audit (pino) | structured tool-call / credential-use log |
| 30 | Security & ops hardening | vault backup/recovery, master-key rotation, tool-poisoning mitigation, deferred CI security tooling |
| 31 | Code-mode (QuickJS over the proxy) | the fast in-process execution path; "base solid" trigger |

**Tier-2 (trigger-deferred, NOT scheduled):** `docs/futures/revisit-when.md` — sandbox refinements (bwrap egress, per-profile HOME, warm-pool, microVM), networked mode (Streamable-HTTP + better-auth + AGPL §13), SSRF egress, GraphQL cost limiting, live config reload, per-field GraphQL tools.

## 5. Per-session-or-new-session decision

Each increment may run in its own session. At each increment **boundary**:
- **Default: continue in the same session** if context is light/moderate.
- **If context is heavy** (a long session, several increments done, or the harness has summarized context): finish the current increment cleanly, **update this file**, and **recommend the user start the next increment in a fresh session** (handing them this file as the entry point). The user decides.

## 6. Resume checklist (for a brand-new session)

1. Read `CLAUDE.md` (rules/architecture/operating-model) + **this file** (current state) + `docs/methods/README.md` (the plan) + skim `docs/behaviours/` + `docs/futures/gotchas.md`.
2. `git checkout main && git pull` (confirm clean, no open PRs you're unaware of: `gh pr list`).
3. Pick the next increment from §4 / the map.
4. Run the per-increment loop (§2). Use `./junction` for manual checks; ephemeral `/tmp/jtNN` for QA.
5. At the end: update the registers (`docs/futures/`) + **this file** (§7 entry + §1 snapshot).

## 7. Session log (newest first — append a terse entry per increment/session)

- **2026-06-27 — increment 22 (web shell) + dev tooling.** Shipped the `@junction/web` TanStack Start read-only dashboard (PR #36): server-only core via `createServerFn`, localhost-only + Host-guard, `junction web` spawns the built server (artifact dep, no cli↔web edge), credentials metadata-only. Review caught + fixed a real reliability bug (per-request DB connection/migration leak → home-keyed memo) + hardening (clean 403, body cap, security headers, stream errors). Added `./junction` launcher (#37) defaulting to a persistent repo-local `.junction` home (#38). Established `docs/STATE.md` + the `junction-handover` skill + a **`docs:check` gate in `pnpm verify`** (the `STATE-done-through` marker must match the map's highest `done` — memory can't go stale silently). Also: bumped vitest timeouts to 20s (flaky child-process gate under load, #40); captured the **builder-brief template + verification discipline** in `docs/workflow.md` (#41). **Decided inc 23 = Web foundation: design system + quality** — design-led (minimalistic/shadcn-like/Geist/anti-AI-slop, captured in `docs/design/web-ui-brief.md`) absorbing the quality scaffolding; ahead of the web mutation increments (which shift to 24+). Skills for the increment: `impeccable:*` + `design-consultation` + emilkowalski/skills (motion; not yet installed). **Next: write the inc-23 method file (invoke the design skills), then build (fresh session recommended).**
- _(Earlier 16–21 history is in the git log + `docs/methods/README.md` status column + `docs/futures/`.)_
