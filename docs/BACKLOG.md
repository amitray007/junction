<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Junction — Backlog

> Snapshot: **2026-07-07**, after the inc-32 vault wave (32.2–32.5) merged (PR #120/#121).
> Two lists, kept deliberately separate:
> - **§1 PENDING** — actionable *now*: unfinished work, real bugs/gaps found by dogfooding, and
>   the two remaining Tier-1 increments. No external trigger needed — we could pick any of these up today.
> - **§2 FUTURE (trigger-gated)** — deliberately deferred; each wakes only when its recorded **trigger**
>   fires. Parked forward-memory, NOT a to-do list. Source of truth stays `docs/futures/revisit-when.md`.
>
> This file is an **index for planning**. The authoritative per-item detail lives in
> `docs/methods/README.md` (the increment map) and `docs/futures/{revisit-when,gotchas,deprecations}.md`.
> Check a box when done; move an item from §2→§1 when its trigger fires.

---

## §1 — PENDING (actionable now)

### 1a. Dogfooding finds — real UX gaps (found 2026-07-07 by using the web UI)

- [ ] **App-detail pages are near-empty for 44 of 45 apps** (e.g. `/app/gitlab`). Root cause: only
      GitHub has an authored `surfaces[]`; the other 44 fall into `readAppDetail`'s *thin fallback*,
      which hardcodes `authModes={[]}` (`app.$id.tsx:883`) → strips the Connect / Add-Credential
      buttons even though the catalog entry declares `auth:[{oauth2},{token}]`.
  - [ ] **Cheap high-leverage fix:** thread the catalog entry's top-level `auth[]` into the thin DTO
        (`thinAppDetail`, `data.server.ts:582-588`) + pass real `authModes` to `EmptyAppState` →
        instantly gives **all 44 apps** working Connect CTAs. (small: 1 DTO field + 1 prop)
  - [ ] **Full fix (bigger, per-app data):** author `surfaces[]` for the 44 apps (mirror
        `catalog/github/catalog.json`) + regenerate `catalog.generated.ts`. Lights up the surface-first
        capability view (available/connected cards, tools). Can be incremental (top apps first:
        gitlab, stripe, slack, notion, linear, …).
- [ ] **Web `/audit` page is a ComingSoon stub** (`routes/audit.tsx`) — the audit backend shipped inc 31
      (`junction audit` reads `<home>/audit.log`) but the web page was deferred.
  - [ ] Extract the CLI's reader/filter (`readAuditLog` + `filterAuditEntries` + `AuditFilters`,
        `cli/commands/audit.ts:27-109`) into a new `core/src/audit/read.ts` (web can't import cli);
        re-wire the CLI onto it (dedup).
  - [ ] Add a server-fn + `data.server.ts` reader (metadata-only entries → no redaction obstacle) +
        a filterable table UI (mirror `credentials.tsx`/`useTableView`) with the CLI's filters
        (`--profile`/`--key`/`--tool`/`--since`/`-n`). **Tail the file, don't slurp** (no rotation yet).
  - [ ] Fix the stale header comment in `audit.tsx` (says "inc 29"; backend shipped inc 31).

### 1b. Unfinished increment carried forward

- [ ] **30.5 — App lifecycle + polish** (status `planned`, never shipped). Three parts:
  - [ ] **(a) Test-Connection auto-refresh BUG** — a valid OAuth credential shows a false "Auth Failed"
        because Test verifies the *expired* access token without refreshing first (affects Credentials
        + Apps). Fix = `refreshIfExpired` before verify. **A real bug, small fix.**
  - [ ] **(b) Change method** — swap a connection's vertical (e.g. REST→MCP) as an additive
        reconnect-first flow (connect new + verify + THEN remove old — no stranding) + a client-cred
        reuse helper + a security pass. Slice-3 spec fully written (`30.5-app-lifecycle.md §5`).
  - [ ] **(c) Per-app icons/logos** in the Apps surface (offline SVG source; `iconSlug` already on
        `AppDefinition` — gitlab has `"iconSlug":"gitlab"`; needs the render + letter-tile fallback).
        *(Note: inc 30.5 Slices 1+2 partially shipped earlier — reconcile before starting; the marker
        is still 30 for 30.5. Re-check what actually landed.)*

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
- [ ] **microsandbox / libkrun microVM** (escalation tier) — trigger: running hostile code / arbitrary npm.
- [ ] **Egress sandboxing for untrusted OpenAPI/HTTP hosts** — trigger: calling arbitrary user `baseUrl` targets.
- [ ] **OS-level egress control for the CLI command tier** — trigger: untrusted operators / multi-tenant / compliance.

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
- [ ] **publint + attw packaging gates** — trigger: a package first publishes (pairs with inc 34).
- [ ] **Changesets publishing** — trigger: a package is actually published.
- [ ] **`credentialEnvVar` denylist refinement** — trigger: a new dynamic-linker/interpreter env var class appears.

---

## How to use this file

- **Planning a session?** Pick from **§1**. Prefer the cheap high-leverage items first (the app-page
  `authModes` fix is the standout — unblocks 44 apps for ~an hour's work).
- **A trigger fired?** Move that item from §2 → §1 with a note, and update `revisit-when.md`.
- **Shipped something?** Check its box here AND flip its row in `docs/methods/README.md`, and log it in
  `docs/STATE.md` §7 (the `junction-handover` skill). This file is an index — the registers are canonical.
