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
> **Reformatted 2026-07-10** to at-a-glance tables per section (detailed prose bullets kept below each table).
>
> **Reconciled 2026-07-10 (post-backlog-burn-down):** the full §1 PENDING list above was burned down in
> one autonomous session — 7 increments, 7 PRs (#128–#134): 30.14 (UI completion), 32.7 (small debts),
> 32.8 (audit rotation), 32.9 (DB unique index), 32.10 (strict import), 32.11 (hash-pinning), 32.12
> (heavy-analyzers CI). **§1 now contains only the two Tier-1 increments (33 Code-mode, 34
> Distribution)** — every other row is checked. See `docs/STATE.md` §7 for the full session narrative.
>
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

## §1 — PENDING (actionable now, no trigger needed)

### At a glance

| ✓ | Item | Group | Type | Size |
|---|------|-------|------|------|
| ☑ | Category facet on the Apps page (30.13 taxonomy is data-only) | UI completion | web | S |
| ☑ | Dashboard "Recent Activity" → link `/audit` (still ComingSoon) | UI completion | web | S |
| ☑ | `removeCredential` warn-on-orphan (pino trigger fired) | small debt | core/sec | S |
| ☑ | File-cred `cred-*` orphan reaper (startup sweep) | small debt | core/sec | S |
| ☑ | `credentialEnvVar` denylist lock-step test (pin 2 lists) | small debt | test/sec | S |
| ☑ | `serve.mjs` static-serve regression tests | small debt | test/sec | S |
| ☑ | Flip **30.5 → `superseded`** in the method map | housekeeping | docs | XS |
| ☑ | Audit-log rotation / retention (`audit.log` grows unbounded) | heavier debt | core/ops | M |
| ☑ | DB `(platform_id, profile_name)` unique index (dedup-then-constrain) | heavier debt | migration | M |
| ☑ | Tool-description hash-pinning (rug-pull detection; 32.5 deferred) | heavier debt | core/sec | M |
| ☑ | 32.4 strict all-or-nothing import (temp-DB swap) | heavier debt | core | M |
| ☑ | 32.2 heavy-analyzers CI (knip / semgrep / CodeQL) | heavier debt | ci | M |
| ☐ | **33 — Code-mode** (QuickJS over the proxy) | big Tier-1 | core/sec | L (fresh session) |
| ☐ | **34 — Distribution** (npm publish; gated + pre-req migration-0003 fix) | big Tier-1 | packaging | L (fresh session) |

**✅ Done since the last reconcile:** app-page CTAs (32.6a) · `/audit` page (32.6b) · surfaces backfill for the curated set (32.6c + 30.13, 54 apps) · 30.5 parts (a) Test-Connection refresh + (c) per-app icons · stale "inc 29" comments.

**✅ Done in the 2026-07-10 backlog burn-down (PRs #128–#134):** Category facet + Dashboard Recent
Activity link (30.14) · `removeCredential` warn-on-orphan + `cred-*` reaper + denylist lock-step test +
`serve.mjs` regression tests + 30.5→`superseded` (32.7) · audit-log rotation (32.8) · DB unique index
(32.9) · strict all-or-nothing import (32.10) · tool-description hash-pinning (32.11) · heavy-analyzers CI
— knip + semgrep + CodeQL (32.12). §1 PENDING now contains only 33/34.

---

### 1a. Dogfooding finds — real UX gaps (found 2026-07-07 by using the web UI)

> **✅ SHIPPED as the 32.6 web-fixes wave (PR #123) + the 30.13 catalog expansion (PR #125).**

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
> Real-server-QA-confirmed gaps.
>
> **✅ SHIPPED as inc 30.14 (PR #128).**

- [x] **Category facet on the Apps page** — 30.13 set `help.category` on every app (Productivity/
      Communication/Developer/CRM/Observability/Search/Social), but `app.index.tsx` had only **Status +
      Method** facets — **no Category filter**, and no grouping/labeling by category. **DONE inc 30.14
      (PR #128):** a Category `FacetSelect` (derived options + an Uncategorized bucket, multi-category
      `includes` matching) via an explicit `AppMeta` DTO w/ category left-joined from `listCatalogEntries`
      — web-only, no core/DB change. **(the completion of 30.13; small web)**
- [x] **Dashboard "Recent Activity" → link to `/audit`** — `index.tsx:65` was a ComingSoon stub
      ("Per-agent usage and audit log coming in a later update") even though `/audit` shipped (32.6b).
      **DONE inc 30.14 (PR #128):** the ComingSoon stub retired for a real `/audit` link-card. **(small web)**

### 1b. Unfinished increment carried forward

> **✅ RESOLVED as part of inc 32.7 (PR #131).** 30.5 flipped to `superseded` in `docs/methods/README.md`.

- [x] **30.5 — App lifecycle + polish** (status `planned` in the map, but 2 of 3 parts ALREADY SHIPPED —
      **reconciled 2026-07-07**; the map row is stale). Actual state:
  - [x] **(a) Test-Connection auto-refresh BUG** — **DONE, merged PR #101** (`5a9e8fe`): `testCredential`
        now `refreshIfExpired`s before verifying.
  - [x] **(c) Per-app icons/logos** — **DONE, merged PR #102**: full-color `@thesvg/icons` via a build-time
        codegen (`gen-brand-icons.mjs` → committed `brand-icons.generated.tsx`) + letter-tile fallback.
  - [x] **(b) Change method** — the ONLY unbuilt part, and **superseded by inc 30.12's "add a surface"**
        (surfaces now accumulate via `{app}-{kind}` instead of swapping). The reconnect-first *swap* flow
        (spec: `30.5-app-lifecycle.md §5`) is deferred unless a real swap-not-add need appears. **DONE
        inc 32.7 (PR #131):** flipped `superseded`/`done` in `docs/methods/README.md`.

### 1c. Remaining Tier-1 increments (the roadmap tail)

- [ ] **33 — Code-mode (QuickJS-WASM over the `ToolProvider` proxy).** The fast execution path: an
      agent runs sandboxed JS against the tools in-process instead of N MCP round-trips. "Base is solid"
      trigger has plausibly fired (29/31/32 done). Needs a QuickJS-WASM sandbox design + the proxy
      binding + a security pass (untrusted code over credentials). **Largest remaining increment.**
- [ ] **34 — Distribution (LAST, local-proof-gated).** Publish `junction` to npm + `junction install`;
      `publint`/`attw` packaging gates; bin/exports; decide `@junction/web` bundled vs separate.
      **Gated (user decision):** do NOT publish until the full connect-once → use → audit flow is
      dogfooded end-to-end against the real running product. Irreversible-ish (npm name) — earned, not scheduled.
  - [ ] **PRE-REQ before publishing — migration journal 0003 non-monotonic `when` fix.** `0003_add_openapi_column`'s
        journal timestamp (`1782600000000`) is > 0004/0005/0006, poisoning drizzle's high-water mark so
        later migrations are silently skipped on a DB created in the inc 15–20 window. Harmless today
        (no distributed users; fresh installs are fine), but **must be fixed before real users exist**:
        lower 0003's `when` to between 0002 and 0004 + add a monotonicity regression test + an
        old-DB-upgrade test. See `revisit-when.md` + `gotchas.md`. *(Distribution blocker, not optional.)*

### 1d. Small correctness/ops debts (low-risk, pick up anytime)

> **✅ ALL SHIPPED in the 2026-07-10 backlog burn-down** (32.7 PR #131, 32.8 PR #132, 32.9 PR #129,
> 32.10 PR #130, 32.11 PR #134, 32.12 PR #133).

- [x] **32.2 heavy-analyzers CI** (deferred from 32): knip (dead code/deps), targeted semgrep
      (sandbox/secrets paths), CodeQL. Deferred as noisy; low-risk hardening when wanted. **DONE inc
      32.12 (PR #133):** knip BLOCKING at zero false positives (tsr generate before scan; 1 dead file
      deleted), semgrep BLOCKING with 8 local committed rules (pipx-isolated, `setuptools<81` force-inject),
      CodeQL informational (weekly + push-to-main, deliberately not required).
- [x] **Audit-log rotation / retention** — `audit.log` grows unbounded (no rotation anywhere). Needed
      before `/audit` web tailing at scale, and generally for a long-lived `serve`. **DONE inc 32.8
      (PR #132):** size-based rotation at serve/mcp startup (8 MiB, keep 5, rename-shift BEFORE the sink
      fd opens), `AuditRotateOutcome` returned (never throws/logs internally), readers stay
      current-file-only (v1 decision).
- [x] **DB unique index on `(platform_id, profile_name)`** — a *dedup-then-constrain* migration to
      enforce the dup-account guard at the data layer (today it's app-level only in `addCredential`).
      **DONE inc 32.9 (PR #129):** migration 0010 — source_refs repoint UPDATE first (doc-review CRITICAL:
      the naive design would have bricked real DBs), dedup DELETE keep-newest-by-MAX(ULID), then the
      index; constraint-violation remaps to `duplicate-account` inside `writeCredential`'s orElse.
- [x] **Tool-description hash-pinning** (32.5 deferred) — detect a previously-seen tool's
      description/schema silently CHANGING between calls (rug-pull detection), beyond sanitizing.
      **DONE inc 32.11 (PR #134):** TOFU + warn-and-serve at the proxy chokepoint, pins
      `(platformId, rawName) → sha256(stableStringify({sanitizedDescription, inputSchema}))` in
      `<home>/tool-pins.json` (v2, 0600, lockfile, atomic).
- [x] **32.4 strict all-or-nothing import** — a transactional (temp-DB-swap) import vs today's
      additive-resumable one. Only if an operator needs full rollback on a mid-import failure. **DONE
      inc 32.10 (PR #130):** `vault import --strict`, COMPENSATION-based (a true one-tx design was proven
      unimplementable in doc review — the keyring backend has no rollback): full prevalidation → the
      existing path under journaling decorators → reverse-order compensation on failure.
- [x] **`removeCredential` warn-on-orphan** — the gotcha (`gotchas.md`, inc 6/13) said "emit a `warn`
      from `removeCredential` on store-delete failure once pino lands, so the reverse-orphan is
      observable in the audit log." **Pino shipped inc 31 → the trigger has FIRED**; the code still
      silently swallows (`repositories/credentials.ts` orphan path). Now actionable, not deferred. (small)
      **DONE inc 32.7 (PR #131):** a core Logger seam + cli stderr JSON logger, warns with the secretRef
      handle + error KIND only (never a value).
- [x] **File-cred `cred-*` orphan reaper** — a hard kill between the per-call `writeFile` and the
      `finally`-rm strands a 0600 `~/.junction/run/cred-XXXX` dir (`gotchas.md`, inc 28.9). A best-effort
      startup sweep of stale `cred-*` dirs was flagged as future hardening and never built. (small)
      **DONE inc 32.7 (PR #131):** `sweepStaleCredDirs` (>1h mtime, dirs-only, symlink-safe,
      fire-and-forget at serve/mcp startup).
- [x] **`credentialEnvVar` denylist lock-step (invariant guard).** The schema `.refine` in
      `cli-connection.ts` and `SECRET_DENYLIST_RE` in `sandbox.ts` (`validatePolicy`) both reject
      `_TOKEN/_SECRET/_KEY` and MUST stay in sync — if one drifts, a name passes `platform add` schema
      validation but is rejected at run time. No test currently pins them together. Cheap: a unit test
      asserting the two lists match. *(security-adjacent)* **DONE inc 32.7 (PR #131):** a behavioral,
      drift-verified parity test.
- [x] **`serve.mjs` static-serve regression tests** — the `resolveStaticFile` path-traversal guard
      (blocks `../` + sibling-prefix `dist/client-evil`) is verified by manual fuzzing but has NO automated
      test; and the CI leak-grep's negative path is unverified. Add before the next `serve.mjs`/leak-grep edit.
      **DONE inc 32.7 (PR #131):** `resolveStaticFile` exported + a `baseDir` param, a realpath-hardened
      main-guard proven spawn-only across all 4 launchers, + a leakcheck `--dir` flag + 4-fixture self-test.

---

## §2 — FUTURE (trigger-gated — parked until the trigger fires)

> Each item wakes only when its **trigger** fires. Do NOT build proactively. **NOT a to-do list.**
> Full detail + exact triggers in `docs/futures/revisit-when.md`. At-a-glance table, then the same items grouped below.

### At a glance

| ✓ | Item | Group | Trigger |
|---|------|-------|---------|
| ☐ | AGPL §13 network-source-offer | 2a serving | broker serves non-loopback users |
| ☐ | better-auth (remote web login) | 2a serving | remote/multi-device login needed |
| ☐ | Origin/SameSite on web mutation POSTs | 2a serving | a web session cookie is introduced |
| ☐ | HTTP `/mcp` session idle-eviction | 2a serving | long-running sessions accumulate |
| ☐ | Live config reload | 2a serving | mid-session source updates wanted |
| ☐ | Sandbox third-party stdio MCP binaries | 2b sandbox | junction spawns an untrusted MCP binary |
| ☐ | microVM (microsandbox/libkrun) | 2b sandbox | hostile code / npm, **or Apple removes `sandbox-exec`** |
| ☐ | Egress sandboxing (OpenAPI/HTTP hosts) | 2b sandbox | calling arbitrary user `baseUrl` |
| ☐ | OS-level egress control (CLI tier) | 2b sandbox | untrusted operators / multi-tenant |
| ☐ | Per-profile HOME isolation for `cli` | 2b sandbox | per-`(profile,credential)` dir needed |
| ☐ | Seatbelt/bwrap ~25ms overhead → warm-pool | 2b sandbox | sandbox latency measurable |
| ☐ | Large-spec catalog connect (>10 MB openapi) | 2c catalog | a user needs such a surface (GitHub REST) |
| ☐ | Inline catalog-seeded oauth2 connect | 2c catalog | junction brokers an OAuth app |
| ☐ | apis.guru top-up + Nango license (30.9.5) | 2c catalog | authoring an app w/ a published spec |
| ☐ | Spec complexity guard (billion-laughs `$ref`) | 2d openapi/gql | a pathological spec bloats deref |
| ☐ | Full AJV arg validation | 2d openapi/gql | agents send systematically bad input |
| ☐ | GraphQL query cost/depth limiting | 2d openapi/gql | uncapped GraphQL source + complex queries |
| ☐ | Per-field typed GraphQL tools | 2d openapi/gql | SDL cached + richer schema helps |
| ☐ | Rich OpenAPI platform selection (TUI) | 2d openapi/gql | many OpenAPI sources managed |
| ☐ | Web platform edit re-fetch / full auth | 2d openapi/gql | partial update op / full auth needed |
| ☐ | Extract GraphQL+OpenAPI HTTP executor to core | 2d openapi/gql | a 3rd consumer appears |
| ☐ | SQLite `audit_events` table | 2e audit | indexed queries outgrow JSONL scan |
| ☐ | `--audit-args` + listTools auditing | 2e audit | forensic arg-value / enumeration need |
| ☐ | Warm-pool / persistent upstream sessions | 2f perf | connect latency >~50ms p50 |
| ☐ | Effect-TS | 2f perf | concurrent fan-out / cancellation pain |
| ☐ | tsgo (TS7 native compiler) | 2f perf | GA + stable |
| ☐ | libsql (from better-sqlite3) | 2f perf | whole-DB at-rest encryption wanted |
| ☐ | Valibot at the web edge | 2f perf | web bundle size a *measured* constraint |
| ☐ | Tailwind CSS | 2g web infra | web UI grows beyond minimal dashboard |
| ☐ | Playwright e2e tests | 2g web infra | mutations/complex flows need coverage |
| ☐ | eslint-plugin-react-hooks | 2g web infra | ESLint replaces Biome |
| ☐ | `ui/index.ts` barrel-import contract | 2g web infra | a web increment makes it cheap |
| ☐ | OpenTUI (Node FFI) | 2g web infra | OpenTUI ships a Node renderer |
| ☐ | publint + attw gates | 2h packaging | a package first publishes (part of inc 34) |
| ☐ | Changesets publishing | 2h packaging | a package is published (part of inc 34) |
| ☐ | `credentialEnvVar` denylist *refinement* | 2h packaging | a new linker/interpreter env-var class appears |
| ☐ | Schema-driven tool-arg form | 2i web UX | raw-JSON args textarea proves error-prone |
| ☐ | Whole-profile / platform-scoped probe | 2i web UX | user wants profile-wide or isolated probe |
| ☐ | Cmd+K command palette | 2i web UX | sidebar destinations > 8 |
| ☐ | Full breadcrumb navigation | 2i web UX | row-detail pages added |
| ☐ | StatusRail live pulse / patch-bay toggle | 2i web UX | a real-time SSE/WS channel lands |
| ☐ | HTTP Basic auth kind + per-account username | 2j cred/oauth | operator needs Basic / multi-account usernames |
| ☐ | In-place OAuth `client_id` editing | 2j cred/oauth | lighter standalone edit wanted |
| ☐ | Profile rename + multi-profile key drift | 2j cred/oauth | a profile-rename feature is added |
| ☐ | Concurrent-boot-during-rotation availability | 2j cred/oauth | rotation gets long (very large vault) |

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
- [ ] **Per-profile HOME/config isolation for the `cli` source** (+ env-vs-file light-isolation split) — trigger: a `cli` source needs its own provisioned per-`(profile,credential)` HOME/config dir, or the ~25ms sandbox cost on env-cred tools is worth a ~5ms light-isolation fast path.
- [ ] **Seatbelt/bwrap per-call overhead (~25ms) → warm-pool or light-isolation mode** — trigger: sandbox spawn latency becomes measurable. Related to §2f warm-pool.

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
> The FUTURE/trigger-gated view of the packaging work that inc 34 (Distribution, §1c) will actually perform.
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

### At a glance

| ✓ | Item | Status / forward path | Trigger |
|---|------|-----------------------|---------|
| ☐ | **macOS Seatbelt (`sandbox-exec`)** | Apple-deprecated, no replacement → **microVM** (ties to §2b; the load-bearing one) | Apple removes `sandbox-exec`, or the escalation tier is built |
| ☐ | isolated-vm | maintenance-mode; NOT used (Deno subprocess instead) — informational | Deno+bubblewrap become impractical |
| — | *Permanently banned* (`node:vm`/`vm2`, keytar, ts-prune, tsup, Jest, oclif, Lucia, `conf`, Effect-TS-as-error-model, Million.js) | reference-only, never adopt | — |

- [ ] **macOS Seatbelt (`sandbox-exec`)** — Apple marks it **DEPRECATED** with **no supported replacement**
      for confining an arbitrary child process (App Sandbox only sandboxes your own signed bundle). In use
      since inc 8; the whole ecosystem (Claude Code, Codex, Chromium) still ships it because nothing better
      exists on macOS without kernel extensions. **Forward path = microVMs** (Apple Containerization /
      libkrun / microsandbox) dropping in behind the `Sandbox` interface — the SAME work as the §2b microVM
      item, but this is its *forced-migration* driver. Trigger: Apple actually removes `sandbox-exec`, or the
      escalation tier is built first. **Load-bearing** — the one deprecation that will genuinely come due.
- [ ] **isolated-vm** — maintenance-mode upstream; junction does NOT use it (JS/TS isolation goes through
      the Deno subprocess boundary). Recorded so the "why not isolated-vm" answer stays durable; revisit
      only if Deno+bubblewrap ever become impractical (pairs with the code-mode / microVM work). Informational.
- [ ] *(Reference — permanently banned, never adopt: `node:vm`/`vm2`, `keytar`, `ts-prune`, `tsup`, Jest,
      oclif, Lucia, `conf`-as-store, Effect-TS-as-error-model, Million.js. Full list in `deprecations.md`.
      Not backlog work — listed so they're never reconsidered.)*

---

## How to use this file

- **Planning a session?** Pick from **§1** (the at-a-glance table is the quick view; the prose below has the detail).
- **A trigger fired?** Move that item from §2 → §1 with a note, and update `revisit-when.md`.
- **Shipped something?** Check its box in BOTH the at-a-glance table AND the prose below, flip its row in
  `docs/methods/README.md`, and log it in `docs/STATE.md` §7 (the `junction-handover` skill). This file is
  an index — the registers are canonical.
