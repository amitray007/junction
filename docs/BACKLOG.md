<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Junction — Backlog

> Snapshot: **2026-07-07**, after the inc-32 vault wave (32.2–32.5) merged (PR #120/#121).
> Reconciled against the canonical registers 2026-07-07 (corrected 30.5 status — Slices 1+2 shipped;
> added the migration-journal distribution pre-req, the denylist/serve.mjs test debts, and the §2i/§2j deferrals).
> **Completeness-audited 2026-07-07** (2nd pass): added the now-actionable `removeCredential` warn +
> `cred-*` reaper debts (§1d), the per-profile-HOME + sandbox-overhead isolation deferrals (§2b), and a
> new **§3 Deprecations / EOL-risk** bucket (Seatbelt→microVM is the load-bearing one).
> **Reconciled 2026-07-10** (post-32.6 + post-30.13): the 32.6 web-fixes wave (PR #123) + the 30.13
> curated catalog expansion (PR #125, 18 apps by category → 54 total) both SHIPPED — surfaces-backfill
> DONE for the curated set (un-curated tail stays thin by design). NEW **§1a-UI** gaps found by
> real-server QA: the Apps page has no **Category facet** (30.13's taxonomy is data-only) + the dashboard
> "Recent Activity" is still ComingSoon despite `/audit` shipping. Re-verified against code:
> `removeCredential` warn / `cred-*` reaper / denylist-lock-step-test / serve.mjs-tests all still UNDONE;
> 30.5 still `planned` in the map (just needs the flip to `superseded`).
> Three lists, kept deliberately separate:
> - **§1 PENDING** — actionable *now*: unfinished work, real bugs/gaps found by dogfooding, and
>   the two remaining Tier-1 increments. No external trigger needed — we could pick any of these up today.
> - **§2 FUTURE (trigger-gated)** — deliberately deferred; each wakes only when its recorded **trigger**
>   fires. Parked forward-memory, NOT a to-do list. Source of truth stays `docs/futures/revisit-when.md`.
> - **§3 DEPRECATIONS / EOL-risk** — dependencies/OS APIs we consciously depend on that are deprecated,
>   each with its forward path. Source of truth: `docs/futures/deprecations.md`.
>
> This file is an **index for planning**. The authoritative per-item detail lives in
> `docs/methods/README.md` (the increment map) and `docs/futures/{revisit-when,gotchas,deprecations}.md`.
> Check a box when done; move an item from §2→§1 when its trigger fires.

---

## §1 — PENDING (actionable now)

### 1a. Dogfooding finds — real UX gaps (found 2026-07-07 by using the web UI)

> **✅ SHIPPED 2026-07-09 as the 32.6 web-fixes wave (PR #123)** — built in 3 isolated worktrees → staging
> → serial-verify integrate → review gate (all clean) → real-server QA. Method files `32.6{a,b,c}-*.md`.
> Boxes below checked accordingly; the surfaces-backfill has a follow-up batch (34 more apps).

- [x] **App-detail pages are near-empty for 44 of 45 apps** (e.g. `/app/gitlab`). — **DONE 32.6a (PR #123).**
  - [x] **Cheap high-leverage fix:** catalog `auth[]` → thin DTO `authModes` → `EmptyAppState` CTAs. Shipped 32.6a.
  - [x] **Full fix (per-app surfaces[]):** 10 apps in 32.6c + **18 more in 30.13 (PR #125 — curated by
        category)**. **DONE for the curated top set** (54 total catalog apps now surfaced-or-thin-with-CTAs).
        The un-curated tail (dropbox/figma/spotify/zoom/aws/adyen/… ~30 apps) stays intentionally thin —
        still connectable via the 32.6a CTAs; not worth surfacing until demand (user call: "better ones only").
- [x] **Web `/audit` page is a ComingSoon stub** — **DONE 32.6b (PR #123).**
  - [x] Extracted the reader/filter into `core/src/audit/read.ts` (+ bounded `readAuditLogTail`); CLI rewired.
  - [x] Server-only `audit.server.ts` + `audit.functions.ts` + filterable table; metadata-only DTO (secret-swept clean); tail-not-slurp.
  - [x] Stale "inc 29" comments fixed (`audit.tsx` + `index.tsx`).

#### 1a-UI. UI completion — the taxonomy/audit surfaces shipped in DATA but not yet in the UI (found 2026-07-10)

> After 30.13 (categories) + 32.6b (`/audit`), the DATA exists but the web UI doesn't fully surface it.
> Real-server-QA-confirmed gaps:

- [ ] **Category facet on the Apps page** — 30.13 set `help.category` on every app (Productivity/
      Communication/Developer/CRM/Observability/Search/Social), but `app.index.tsx` has only **Status +
      Method** facets — **no Category filter**, and no grouping/labeling by category. The whole
      categorization payoff is invisible. Add a Category `FacetSelect` (+ optionally category section
      headers) mirroring the existing facet pattern. **(the completion of 30.13; small web)**
- [ ] **Dashboard "Recent Activity" → link to `/audit`** — `index.tsx:65` is still a ComingSoon stub
      ("Per-agent usage and audit log coming in a later update") even though `/audit` shipped (32.6b).
      Link it to the real page (+ optionally a small recent-activity summary). **(small web)**

### 1b. Unfinished increment carried forward

- [ ] **30.5 — App lifecycle + polish** (status `planned` in the map, but 2 of 3 parts ALREADY SHIPPED —
      **reconciled 2026-07-07**; the map row is stale). Actual state:
  - [x] **(a) Test-Connection auto-refresh BUG** — **DONE, merged PR #101** (`5a9e8fe`): `testCredential`
        now `refreshIfExpired`s before verifying. *(Was listed here as open — it is fixed.)*
  - [x] **(c) Per-app icons/logos** — **DONE, merged PR #102**: full-color `@thesvg/icons` via a build-time
        codegen (`gen-brand-icons.mjs` → committed `brand-icons.generated.tsx`) + letter-tile fallback.
        *(Was listed here as open — it shipped.)*
  - [ ] **(b) Change method** — the ONLY unbuilt part, and **superseded by inc 30.12's "add a surface"**
        (surfaces now accumulate via `{app}-{kind}` instead of swapping). The reconnect-first *swap* flow
        (spec: `30.5-app-lifecycle.md §5`) is deferred unless a real swap-not-add need appears. **Decision
        needed:** mark 30.5 `superseded`/`done` in `docs/methods/README.md` rather than leave it `planned`
        (the two shipped slices + the 30.12 supersession mean nothing here is actionable). Low urgency.

### 1c. Remaining Tier-1 increments (the roadmap tail)

- [ ] **33 — Code-mode (QuickJS-WASM over the `ToolProvider` proxy).** The fast execution path: an
      agent runs sandboxed JS against the tools in-process instead of N MCP round-trips. "Base is solid"
      trigger has plausibly fired (29/31/32 done). Needs a QuickJS-WASM sandbox design + the proxy
      binding + a security pass (untrusted code over credentials). **Largest remaining increment.**
- [ ] **34 — Distribution (LAST, local-proof-gated).** Publish `junction` to npm + `junction install`;
      `publint`/`attw` packaging gates; bin/exports; decide `@junction/web` bundled vs separate.
      **Gated (user decision):** do NOT publish until the full connect-once → use → audit flow is
      dogfooded end-to-end against the real running product. Irreversible-ish (npm name) — earned, not
      scheduled.
  - [ ] **PRE-REQ before publishing — migration journal 0003 non-monotonic `when` fix.** `0003_add_openapi_column`'s
        journal timestamp (`1782600000000`) is > 0004/0005/0006, poisoning drizzle's high-water mark so
        later migrations are silently skipped on a DB created in the inc 15–20 window. Harmless today
        (no distributed users; fresh installs are fine), but **must be fixed before real users exist**:
        lower 0003's `when` to between 0002 and 0004 + add a monotonicity regression test + an
        old-DB-upgrade test (every existing test uses a FRESH DB, which never trips the high-water — the
        gap that hid it). See `revisit-when.md` + `gotchas.md`. *(This is a distribution blocker, not optional.)*

### 1d. Small correctness/ops debts (low-risk, pick up anytime)

- [ ] **32.2 heavy-analyzers CI** (deferred from 32): knip (dead code/deps), targeted semgrep
      (sandbox/secrets paths), CodeQL. Deferred as noisy; low-risk hardening when wanted.
- [ ] **Audit-log rotation / retention** — `audit.log` grows unbounded (no rotation anywhere). Needed
      before `/audit` web tailing at scale, and generally for a long-lived `serve`.
- [ ] **DB unique index on `(platform_id, profile_name)`** — a *dedup-then-constrain* migration to
      enforce the dup-account guard at the data layer (today it's app-level only in `addCredential`).
- [ ] **Tool-description hash-pinning** (32.5 deferred) — detect a previously-seen tool's
      description/schema silently CHANGING between calls (rug-pull detection), beyond sanitizing.
- [ ] **32.4 strict all-or-nothing import** — a transactional (temp-DB-swap) import vs today's
      additive-resumable one. Only if an operator needs full rollback on a mid-import failure.
- [ ] **`removeCredential` warn-on-orphan** — the gotcha (`gotchas.md`, inc 6/13) said "emit a `warn`
      from `removeCredential` on store-delete failure once pino lands, so the reverse-orphan is
      observable in the audit log." **Pino shipped inc 31 → the trigger has FIRED**; the code still
      silently swallows (`repositories/credentials.ts` orphan path). Now actionable, not deferred. (small)
- [ ] **File-cred `cred-*` orphan reaper** — a hard kill between the per-call `writeFile` and the
      `finally`-rm strands a 0600 `~/.junction/run/cred-XXXX` dir (`gotchas.md`, inc 28.9). A best-effort
      startup sweep of stale `cred-*` dirs was flagged as future hardening and never built. Real
      unfinished hardening, no external trigger needed. (small)
- [ ] **Stale "inc 29" ComingSoon comments** — `audit.tsx:3` AND `index.tsx:65` (dashboard Recent
      Activity) both say the audit backend "lands in inc 29"; it shipped inc 31. Trivial comment fix
      (fold into the `/audit` work above). (trivial)
- [ ] **`credentialEnvVar` denylist lock-step (invariant guard).** The schema `.refine` in
      `cli-connection.ts` and `SECRET_DENYLIST_RE` in `sandbox.ts` (`validatePolicy`) both reject
      `_TOKEN/_SECRET/_KEY` and MUST stay in sync — if one drifts, a name passes `platform add` schema
      validation but is rejected at run time (a confusing "schema-valid but runtime-rejected" error).
      No test currently pins them together. Cheap: a unit test asserting the two lists match. *(security-adjacent)*
- [ ] **`serve.mjs` static-serve regression tests** — the `resolveStaticFile` path-traversal guard
      (blocks `../` + sibling-prefix `dist/client-evil`) is verified by manual fuzzing but has NO automated
      test; and the CI leak-grep's negative path is unverified (nothing asserts the build FAILS when a
      server-only identifier is planted in a client chunk). Add before the next `serve.mjs`/leak-grep edit.

---

## §2 — FUTURE (trigger-gated — parked until the trigger fires)

> Each item wakes only when its **trigger** fires. Do NOT build proactively. Full detail +
> exact triggers in `docs/futures/revisit-when.md`.

### 2a. Serving / networked mode
- [ ] **AGPL §13 network-source-offer** — trigger: the broker serves *network* users (non-loopback).
- [ ] **better-auth** (remote/multi-device web login) — trigger: remote web login is needed.
- [ ] **Origin/SameSite enforcement on web mutation POSTs** — trigger: a web *session cookie* is introduced.
- [ ] **HTTP `/mcp` session-map idle-eviction** (beyond the 256 cap) — trigger: long-running sessions accumulate.
- [ ] **Live config reload** (source toggles take effect without reconnect) — trigger: mid-session updates wanted.

### 2b. Sandbox / execution isolation
- [ ] **Sandbox for third-party stdio MCP binaries** — trigger: junction spawns an untrusted MCP binary.
- [ ] **microsandbox / libkrun microVM** (escalation tier — AND the Seatbelt-replacement path, see §3) — trigger: running hostile code / arbitrary npm, OR Apple removes `sandbox-exec`.
- [ ] **Egress sandboxing for untrusted OpenAPI/HTTP hosts** — trigger: calling arbitrary user `baseUrl` targets.
- [ ] **OS-level egress control for the CLI command tier** — trigger: untrusted operators / multi-tenant / compliance.
- [ ] **Per-profile HOME/config isolation for the `cli` source** (+ env-vs-file light-isolation split) — trigger: a `cli` source needs its own provisioned per-`(profile,credential)` HOME/config dir, or the ~25ms sandbox cost on env-cred tools is worth a ~5ms light-isolation fast path. (`revisit-when.md`)
- [ ] **Seatbelt/bwrap per-call overhead (~25ms) → warm-pool or light-isolation mode** — trigger: sandbox spawn latency becomes measurable on a real workload (levers: code-mode fast path / light-isolation mode / warm-pool of sandboxed processes). Related to §2f warm-pool.

### 2c. Catalog / connect
- [ ] **Large-spec catalog connect** (>10 MB openapi; GitHub's is 12.6 MB) — trigger: a user needs such a surface.
- [ ] **Inline catalog-seeded oauth2 connect** (from the App page) — trigger: junction brokers an OAuth app, or the reg form gains a catalog variant.
- [ ] **apis.guru spec-URL top-up + Nango license review** (30.9.5) — trigger: authoring an app whose REST surface has a published spec.

### 2d. OpenAPI / GraphQL depth
- [ ] **Spec complexity guard at add-time** (billion-laughs `$ref`) — trigger: a pathological spec bloats `dereference()`.
- [ ] **Full AJV validation of request args** — trigger: agents send systematically bad input.
- [ ] **GraphQL query cost / depth limiting** — trigger: a GraphQL source with no native cost limiting + complex agent queries.
- [ ] **Per-field typed tools for GraphQL** (one tool per SDL op) — trigger: SDL reliably cached + richer schema helps.
- [ ] **Rich platform selection for OpenAPI** (TUI browser) — trigger: many OpenAPI sources managed.
- [ ] **Web platform edit re-fetches the spec** / **web platform full auth surface** — trigger: partial update op / full auth needed.
- [ ] **Extract GraphQL+OpenAPI HTTP executor utils to core** — trigger: a 3rd consumer of the streaming/byte-cap logic.

### 2e. Audit depth (beyond §1's basic web page)
- [ ] **Audit: SQLite `audit_events` table** — trigger: indexed queries / filtering volume outgrows a JSONL scan.
- [ ] **Audit: `--audit-args` + listTools auditing** — trigger: forensic arg-value need / enumeration-auditing need.

### 2f. Performance / infra swaps
- [ ] **Warm-pool / persistent upstream sessions** — trigger: per-request connect latency measurable (>~50ms p50).
- [ ] **Effect-TS** (structured concurrency) — trigger: concurrent fan-out / process-pool / cancellation pain.
- [ ] **tsgo** (TS7 native compiler) — trigger: GA + stable.
- [ ] **libsql** (from better-sqlite3) — trigger: whole-DB at-rest encryption wanted.
- [ ] **Valibot at the web edge** — trigger: web bundle size becomes a *measured* constraint.

### 2g. Web / UI infra
- [ ] **Tailwind CSS** — trigger: web UI grows beyond the minimal dashboard.
- [ ] **Browser e2e tests (Playwright)** — trigger: mutations / complex flows need regression coverage.
- [ ] **eslint-plugin-react-hooks** — trigger: ESLint replaces Biome, or Biome drops the hooks rules.
- [ ] **`ui/index.ts` barrel-import contract** (enforce/soften) — trigger: a web increment makes the cleanup cheap.
- [ ] **OpenTUI (Node FFI)** — trigger: OpenTUI ships a Node-compatible native renderer.

### 2h. Packaging / publishing
> These are the FUTURE/trigger-gated view of the packaging work that inc 34 (Distribution, §1c) will
> actually perform. Same forward work, listed here for the trigger; §1c-34 is where it gets built.
- [ ] **publint + attw packaging gates** — trigger: a package first publishes (this IS part of inc 34).
- [ ] **Changesets publishing** — trigger: a package is actually published (part of inc 34).
- [ ] **`credentialEnvVar` denylist refinement** — trigger: a new dynamic-linker/interpreter env var class appears. *(distinct from the §1d lock-step test — this is expanding the denylist itself.)*

### 2i. Web UX polish / probe depth (minor, demand-gated)
- [ ] **Schema-driven tool-arg form** (probe/call) — trigger: the raw-JSON args textarea proves error-prone.
- [ ] **Whole-profile probe + platform-scoped probe** — trigger: a user wants to probe a whole profile at once, or a source in isolation like CLI `debug`.
- [ ] **Cmd+K command palette** — trigger: sidebar destinations > 8, or a deep-link/jump-to-entity need.
- [ ] **Full breadcrumb navigation** (section > entity > detail) — trigger: row-detail pages are added.
- [ ] **StatusRail live pulse** / **Patch-bay source-toggle UI** — trigger: a real-time channel (SSE/WS) from the serve process lands.

### 2j. Credential / OAuth depth (demand-gated)
- [ ] **HTTP Basic auth credential kind + per-account username** — trigger: an operator needs Basic auth, or >1 account with different usernames (username must move platform→credential for the multi-account wedge).
- [ ] **In-place OAuth `client_id` editing** — trigger: a lighter standalone client_id edit is wanted (must force `needsReauth`; today "swap OAuth app" = reconnect handles it).
- [ ] **Profile rename + multi-profile key tool-name drift** — trigger: a profile-rename feature is added (would silently change every multi-profile key's tool names → breaks agent prompts; pin name at mint or forbid renaming referenced profiles).
- [ ] **Concurrent-boot-during-rotation availability** — trigger: master-key rotation gets long enough (very large vault) that a concurrent boot failing during rotation is a real UX wrinkle. (Safe fail-closed today.)

---

## §3 — DEPRECATIONS / EOL-risk (consciously accepted; forward path recorded)

> Dependencies / OS APIs junction uses **today** that are deprecated or EOL-risk. Accepted knowingly —
> the entry exists so the acceptance is revisitable, not silent. Canonical: `docs/futures/deprecations.md`.
> These overlap §2 (the forward path is often a §2 item) — cross-referenced below.

- [ ] **macOS Seatbelt (`sandbox-exec`)** — Apple marks it **DEPRECATED** with **no supported replacement**
      for confining an arbitrary child process (App Sandbox only sandboxes your own signed bundle). In use
      since inc 8; the whole ecosystem (Claude Code, Codex, Chromium) still ships it because nothing better
      exists on macOS without kernel extensions. **Forward path = microVMs** (Apple Containerization /
      libkrun / microsandbox) dropping in behind the `Sandbox` interface — the SAME work as the §2b microVM
      item, but this is its *forced-migration* driver (not just the hostile-code escalation tier). Trigger:
      Apple actually removes `sandbox-exec`, or the escalation tier is built first. **Load-bearing** — the
      one deprecation that will genuinely come due. (Linux `bubblewrap` has no equivalent pressure.)
- [ ] **isolated-vm** — maintenance-mode upstream; junction does NOT use it (JS/TS isolation goes through
      the Deno subprocess boundary). Recorded so the "why not isolated-vm" answer stays durable; revisit
      only if Deno+bubblewrap ever become impractical (pairs with the code-mode / microVM work). Informational.
- [ ] *(Reference — permanently banned, never adopt: `node:vm`/`vm2`, `keytar`, `ts-prune`, `tsup`, Jest,
      oclif, Lucia, `conf`-as-store, Effect-TS-as-error-model, Million.js. Full list in `deprecations.md`.
      Not backlog work — listed so they're never reconsidered.)*

---

## How to use this file

- **Planning a session?** Pick from **§1**. Prefer the cheap high-leverage items first (the app-page
  `authModes` fix is the standout — unblocks 44 apps for ~an hour's work).
- **A trigger fired?** Move that item from §2 → §1 with a note, and update `revisit-when.md`.
- **Shipped something?** Check its box here AND flip its row in `docs/methods/README.md`, and log it in
  `docs/STATE.md` §7 (the `junction-handover` skill). This file is an index — the registers are canonical.
