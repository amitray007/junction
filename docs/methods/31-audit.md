---
increment: 31
title: Audit — structured tool-call / credential-use log (pino)
depends_on: [27]               # HARD: consumes inc-27's ResolvedKey.keyId + AuthedKey for attribution
soft_after: [30.12]            # ships after the App Surface Model track
touches: [core, mcp/server, cli]   # A: core (audit schema + path + sink iface + tool-denied UpstreamError) + mcp/server (safeUpstreamMessage collapse). B: cli (pino sink + hook in providers.ts + serve/mcp injection). C: cli (audit read cmd + index.ts). NO web this increment, NO migration.
parallel_group: A-then-BC      # A (core+mcp/server) blocks; B (emitter/hook, providers.ts+serve.ts+mcp.ts) ∥ C (audit.ts+index.ts) after A — disjoint cli files.
---

# Increment 31 — Audit: structured tool-call / credential-use log (pino)

> **Status:** planned → building. Self-contained; a Sonnet builder works from it.
> Doc-reviewed (ce-feasibility + ce-spec-flow) BEFORE build — findings folded in.

## §0 — Decisions locked (research + user, 2026-07-07)

1. **Arg-logging policy = keys + value hash, NEVER values** (user decision). Record each arg's
   KEY NAME + a SHA-256 hash of the whole args object (for correlation/dedup), never the argument
   VALUES. This keeps `audit.log` a non-secret artifact — its whole point is a trail safe to keep.
   (A future opt-in `--audit-args` could log values, but NEVER the default; out of scope here.)
2. **Read surface = CLI only this increment** (orchestrator decision — keep it tight). `junction audit`
   is the scriptable-first MVP. The web `/audit` ComingSoon stub (`packages/web/src/routes/audit.tsx`)
   STAYS ComingSoon → a clean independent fast-follow leaf (recorded in `revisit-when.md`).
3. **Storage = a single append-only JSONL file** at `getPaths().auditLogFile` (`<home>/audit.log`)
   — no DB table, no migration. The audit WRITE must never block or fail the tool call; a JSONL
   append via a non-blocking pino destination satisfies that. (SQLite `audit_events` table deferred
   to `revisit-when.md` — revisit only if indexed-query volume earns it.)
4. **pino sink = `pino.destination({ dest, sync: false, mkdir: true })` — NOT a worker-thread
   `pino.transport`.** A worker transport can be torn down BEFORE the buffered log flushes on a
   short-lived process (`mcp serve` stdio, a CLI that exits right after a call) → the LAST audit
   line (often the most interesting) is silently dropped. `sync:false` buffers in the MAIN thread
   (SonicBoom), flushed on the event loop. **The flush wiring differs per path (doc-review Finding 2 —
   the two paths have DIFFERENT lifecycles; do NOT assume "existing handlers" on stdio):**
   - **HTTP (`serve.ts`)**: a real `process.once("SIGINT"/"SIGTERM", shutdown)` block EXISTS at
     `serve.ts:194-200` — add `sink.flush()` into that `shutdown` fn (before/alongside `handle.close()`).
   - **stdio (`mcp.ts`)**: `serveStdio` (`mcp/server/src/serve.ts:30`) resolves its Promise on the
     CLEAN shutdown (transport `onclose` OR `process.stdin.once("end")` = EOF when the client
     disconnects). So flush **after `await serveStdio(...)` returns** (`mcp.ts:166`) — the natural
     clean-exit point. `mcp.ts` has **NO SIGINT handler today** → ADD `process.once("SIGINT"/"SIGTERM",
     …)` that flushes then exits (a raw Ctrl-C sends no EOF, so serveStdio's Promise never resolves →
     without this the last line drops on Ctrl-C).
   - **Both**: `process.on("exit", () => dest.flushSync())` as the final belt-and-suspenders.
     `flushSync` runs ONLY in exit/signal handlers — never on the hot call path (satisfies "no
     fs.*Sync in core/server paths"). **Accepted limitation:** a HARD crash (SIGKILL/OOM) may still
     drop the last buffered line — state this honestly; only CLEAN shutdown (SIGINT/SIGTERM/EOF/exit)
     guarantees the flush. The sink impl lives in **cli** (doc-review rec — the composition root,
     alongside `getPaths()`/`resolveProvider` injection; NOT source-runtime).
5. **Hook seam = `adaptToMcpHandlers.callTool` (`packages/cli/src/providers.ts:53`).** This is the
   SINGLE point where WHO + WHAT + OUTCOME converge for BOTH transports. See §2 for the boundary argument.

6. **Distinct `tool-denied` audit signal — WITHOUT revealing existence to the agent** (user decision
   2026-07-07: "tool-not-found and other similar specific errors should exist"; doc-review Critical #2).
   TODAY the core proxy collapses a toolFilter DENIAL into `tool-not-found` (`proxy.ts:220-221`) —
   and the comment at `:219` shows this is **intentional**: "denied → tool-not-found (does not reveal
   existence)" so a filtered tool's existence isn't disclosed to the calling agent. So there's a real
   tension: the AUDIT must distinguish deny-vs-typo, but the agent-facing RESPONSE must NOT. **The
   resolution (load-bearing — the builder must not break existence-hiding):** add a distinct
   `tool-denied` `UpstreamError` kind returned INTERNALLY from the proxy at the filter-block branch
   (`:221`), BUT the AGENT-FACING mapping (`safeUpstreamMessage` in mcp-server) must map `tool-denied`
   → the SAME opaque message as `tool-not-found` (existence-hiding preserved). The audit hook sees the
   RAW `result.error.kind` = `tool-denied` and records it distinctly; the agent sees no difference.
   This satisfies BOTH the user's audit requirement AND the intentional existence-hiding property. It
   enlarges Slice A (a core error-model change threaded through the exhaustive `UpstreamError` switches).

## §0b — Load-bearing facts (verified in-repo)

- **`ResolvedKey = { keyId, label, scope, profileIds }`** (`core/api-keys/verify.ts:20`). `keyId` is
  the ULID PK — the PUBLIC keyid segment of `jct_<keyid>_<secret>`, non-secret, stable, safe to log +
  correlate. `label` is user-facing (non-secret). The plaintext key NEVER reaches the handler
  (`serve-http.ts` `AuthedKey` carries only `keyId`). **Attribution is `keyId`+`label`, never the secret.**
- **Revoked keys' rows are RETAINED** (`db/schema.ts` `revokedAt` comment — "retained for inc-31
  audit"), so a `keyId` in an old audit line still resolves to a label after revocation.
- **Both transports converge at `adaptToMcpHandlers`:** `serve.ts:129,164` (HTTP, inside
  `buildHandlers(authedKey)` — `authedKey.keyId` + the fetched `record.label`/`record.scope` in scope)
  and `mcp.ts:163` (stdio — `profile.name` in scope; NO key).
- **The adapter's `callTool` (`providers.ts:53-69`) has `name`, `callArgs`, AND the `result`
  (`isErr()`/`value`) all in scope** — the outcome is right there.
- **Secret-in-error trap (`gotchas.md:178,209`):** an `UpstreamError.cause` can carry an axios
  `Authorization` header; an upstream RESPONSE can reflect a query-string apiKey. So log ONLY the
  discriminated `error.kind` (never `cause`, never `safeUpstreamMessage`'s interpolated text, never
  the response `content`).
- **pino is NOT yet a dependency** (verified: zero hits in any package.json). Inc 31 installs it.
- **`getPaths()` (`core/paths/index.ts`)** joins every artifact under the 0700 home
  (`configFile`/`dbFile`/`credentialsFile`/`masterKeyFile`) — `auditLogFile` fits the same pattern.

## §1 — What / why + proof-of-done

When an agent reaches junction (keyed `/mcp` HTTP or stdio `mcp serve`) and calls a tool, junction
appends ONE structured JSONL audit entry: WHO (keyId+label / stdio), WHAT (profile/namespace/tool +
arg KEYS + arg-hash), WHEN (ts+duration), OUTCOME (ok | error+kind) — **NEVER** a credential value,
an arg value, a response body, or an error cause. A `junction audit` command reads/filters it.

**Proof-of-done:**
- A real tool call through `mcp serve` (stdio) appends an audit line with `principal.kind:"stdio"`,
  the profile, namespace, tool, argKeys, argHash, `outcome:"ok"`, durationMs.
- A real tool call through the keyed `/mcp` HTTP endpoint appends a line with
  `principal.kind:"api-key"`, the `keyId` + `label`, the scoped profile(s).
- A FAILING call (bad upstream) appends `outcome:"error"` + the `errorKind` (discriminated tag ONLY).
- **Adversarial: no secret in `audit.log`** — grep the file for the real credential value, the arg
  VALUES, and the raw key → all absent. Only ids/metadata/hashes.
- `junction audit --json` emits the entries; `--tool`/`--profile`/`--key`/`--since`/`-n` filter.
- The LAST call before a CLEAN `mcp serve` shutdown (SIGINT/SIGTERM/EOF/exit) is NOT dropped
  (flush works). **Durability contract (stated honestly):** a HARD crash (SIGKILL/OOM) MAY drop the
  last buffered line — accepted, because the alternative (`sync:true` on the hot path) would block the
  tool call + violate "no fs.*Sync in server paths". The audit line is emitted AFTER the call completes
  (§2 B3), so a crash DURING the upstream call means the call didn't complete — no false "ok" is ever
  recorded (a call is only audited once its outcome is known).
- A toolFilter-DENIED call is audited as `errorKind:"tool-denied"` (distinct from a genuine unknown
  tool's `"tool-not-found"`), while the AGENT still receives the same opaque error (existence-hiding).
- A `profiles`/`global`-scope key's call parses `target.{profile,namespace,tool}` correctly from the
  `<profile>__<namespace>__<tool>` prefixed name (not mis-split).
- A revoked key's `keyId` in an old audit line still resolves to its `label` in `junction audit`
  (rows retained); a call attempted on a just-revoked key audits with `profiles:[]` (expected — a
  revoked key's attempt is exactly what an audit should capture, not a bug).
- `pnpm verify` green; depcruise green (core stays pino-free + HTTP-free; pino lives at the edge).

## §2 — Architecture (the seam + boundary argument)

**Why `adaptToMcpHandlers`, not the core proxy or mcp/server:** the core `proxy.callTool`
(`sources/proxy.ts`) sees the call + result but NOT the keyId (attribution lives only in mcp/server's
`AuthedKey`); mcp/server is a thin SDK wrapper that also lacks the keyId at call-time and is one of
TWO transports. `adaptToMcpHandlers` (in **cli**, the composition root) is the ONLY seam that is
(a) traversed by both transports, (b) holds the `Result`, and (c) is lexically where `keyId`/profile
are in scope. Emitting here keeps **core pure (no pino, no HTTP)** and **mcp/server thin** — the audit
sink + principal are INJECTED, exactly like `resolveProvider` already is.

### Slice A — core (BLOCKING; lands + verifies + commits first)
`touches: [core]`. Defines the contract B and C build against. Small (types + one path line + an
interface — NO proxy change, NO pino).

- **A1. `AuditEntry` schema** — `packages/core/src/audit/schema.ts`. A Zod schema + inferred type,
  the §3 shape below, discriminated `outcome`, `v:1` version field. Exported from `core`.
- **A2. `getPaths().auditLogFile`** — add `auditLogFile: path.join(home, "audit.log")` to
  `JunctionPaths` (`core/paths/index.ts`) + a test (mirror the `dbFile` test).
- **A3. `AuditSink` interface** — `packages/core/src/audit/sink.ts`. A pure interface
  `{ emit(entry: AuditEntry): void }` (fire-and-forget — emit must never throw into the caller,
  never return a Promise the call path awaits). Core owns the SHAPE; the pino-backed IMPL is Slice B
  at the edge (keeps core pino-free). Also a `NoopAuditSink` (default when auditing is off / tests).
- **A4. A pure `hashArgs(args)` + `argKeys(args)` helper** (`core/audit/redact.ts`): `argKeys` =
  `Object.keys(args).sort()`; `hashArgs` = SHA-256 hex of a stable JSON serialization of the args
  (node:crypto, sync hash of an in-memory value is fine — not I/O). NEVER returns values. Unit-tested
  (same keys+values → same hash; different values → different hash; empty → stable sentinel).
  **HONEST FRAMING (doc-review — do NOT overclaim):** the hash is for **correlation/dedup, NOT
  confidentiality**. For a LOW-entropy args object (`{enabled:true}`, `{status:"open"}`) the unsalted
  hash IS brute-forceable (enumerate the few possible objects, match) — so it effectively reveals
  low-entropy values. This is acceptable because (a) a real secret arg is high-entropy (safe), and
  (b) the actual protection is that **values are never logged**, not the hash. The schema/comments +
  the security reviewer brief must state this — never claim the hash is "not reversible."
- **A5. Add a `tool-denied` `UpstreamError` kind (§0 decision 6)** — `core/errors/index.ts`
  `UpstreamError` gains `| { kind: "tool-denied"; name: string }`. The proxy's filter-block branch
  (`proxy.ts:221`) returns `tool-denied` instead of `tool-not-found` (the unknown-namespace `:213`
  and over-long-name `:228` branches KEEP `tool-not-found` — only the deliberate FILTER block becomes
  `tool-denied`). **Existence-hiding preserved (load-bearing):** `safeUpstreamMessage` (mcp-server)
  must map `tool-denied` → the SAME opaque agent-facing text as `tool-not-found` (assert this in a
  test — the agent must not be able to tell deny from unknown). Thread the new kind through EVERY
  exhaustive `UpstreamError` switch (grep `kind === "tool-not-found"` + the formatters in
  cli/format.ts, web, mcp-server — NEVER a non-exhaustive `default`; stale-tsbuildinfo → `pnpm build`).
- **A tests:** schema parse/reject; path; `hashArgs`/`argKeys` (no-values guarantee); the proxy
  returns `tool-denied` on a filter block + `tool-not-found` on unknown/over-long; `safeUpstreamMessage`
  collapses `tool-denied` to the opaque message (existence-hiding regression guard).

### Slice B — emitter + hook (leaf; after A)
`depends_on: A`. `touches: [source-runtime, cli]` — but the cli file it touches is
`providers.ts` + a NEW `audit-sink` impl file, **disjoint from Slice C's new `commands/audit.ts`**,
so B ∥ C is collision-safe.

- **B1. `pnpm add pino`** (workspace root or the package that owns the sink impl). Confirm the real
  pino version's `pino.destination` API before wiring (research flagged the worker-thread trap;
  reshape if the version diverges).
- **B2. The pino-backed `AuditSink` impl** — a new module in **`cli`** (doc-review rec — the
  composition root, alongside `getPaths()`/`resolveProvider` injection; `adaptToMcpHandlers` already
  lives in cli to stay out of source-runtime, so the sink belongs there too; core stays pino-free).
  `createFileAuditSink(paths)` → opens `pino.destination({ dest: paths.auditLogFile, sync: false,
  mkdir: true })`, returns an `AuditSink` whose `emit` calls `logger.info(entry)`. Expose
  `flush()`/`flushSync()` for the shutdown wiring (decision #4).
- **B3. Wire the hook into `adaptToMcpHandlers`** (`cli/providers.ts`): add optional params
  `principal: AuditPrincipal`, `sink: AuditSink`, and **`prefixed: boolean`** (the arity — see the
  name-parse note below). In `callTool`, capture `start = performance.now()`, run the existing call,
  then `sink.emit({ ...principal, target, argKeys, argHash, durationMs, outcome, errorKind })`.
  The emit is fire-and-forget — wrap in try/catch so an audit failure NEVER breaks the tool call.
- **B3-name-parse (LOAD-BEARING — verified against `scoped-proxy.ts`):** the adapter sees the FULL
  wire name, whose shape depends on arity (`scoped-proxy.ts` ARITY doc):
  - **unprefixed** (single-profile stdio / `scope:"profile"`): name is `<namespace>__<tool>` →
    `splitNamespacedName(name)` (`core/sources/naming.ts:46`, splits on FIRST `__`) gives the correct
    `{namespace, tool}`; `target.profile` = the principal's single profile.
  - **prefixed** (`scope:"profiles"|"global"`): name is `<profileName>__<namespace>__<tool>`.
    `splitNamespacedName` alone would WRONGLY return `namespace=<profileName>`. So: split ONCE on the
    first `__` to peel `<profileName>` (charset contract: profile names carry no `_`, namespaces no
    `__` — `scoped-proxy.ts` header), THEN `splitNamespacedName` the remainder for `{namespace, tool}`,
    and `target.profile` = the peeled profile. **Pass `prefixed` from the call site** (`serve.ts` knows
    it: `record.scope !== "profile"`; stdio is always unprefixed). Add an `parseWireName(name, prefixed)`
    helper (in `core/audit` or reuse naming.ts) + a test for BOTH arities — a wrong split mis-attributes
    every multi-profile audit line.
- **B4. Inject the principal + arity + sink at the two call sites:**
  - `serve.ts:164` (HTTP, main path): `{ kind:"api-key", keyId: authedKey.keyId, label: record.label,
    profiles: entries.map(e => e.profileName) }` + `prefixed = record.scope !== "profile"`.
    (`record` is at `serve.ts:131`, has `.label`/`.scope`.) The `serve.ts:129` failed-resolve fallback
    keeps the optional audit params off (no attribution possible — don't audit an unresolved key).
  - `mcp.ts:163` (stdio): `{ kind:"stdio", keyId: null, label: null, profiles: [profile.name] }` +
    `prefixed = false` (stdio is always single-profile passthrough).
  - Both build the file sink once per process (`createFileAuditSink(getPaths())`). Flush wiring is
    per decision #4: HTTP → into `serve.ts:194` `shutdown`; stdio → after `await serveStdio()` returns
    (`mcp.ts:166`) + a NEW `process.once("SIGINT"/"SIGTERM")` in `mcp.ts`; both → `process.on("exit",
    flushSync)`.
- **B tests:** an emit produces a well-formed line (assert against the schema); a FAILING call logs
  `outcome:"error"` + the kind; the emit try/catch swallows a sink error without failing the call;
  the namespaced-name split is correct for both single- and multi-profile arities.

### Slice C — CLI read command (leaf; after A, ∥ B)
`depends_on: A`. `touches: [cli]` (NEW file `commands/audit.ts` — disjoint from B's `providers.ts`).

- **C1. `junction audit`** — read `getPaths().auditLogFile` (async, streaming/line-read; no
  `readFileSync`), parse JSONL, apply filters `--profile`/`--key <keyId>`/`--tool`/`--since <ISO>`/
  `-n <count>` (default a sane tail like last 50), print a human table OR `--json` (the scriptable
  path — REQUIRED per the scriptable-first rule). Empty/absent file → honest "no audit entries yet"
  (not an error). A malformed JSONL line is SKIPPED (with a count), never fatal. **`--since` is parsed
  as ISO-8601 and compared in UTC** against the entry `ts` (pino emits UTC) — a bare `2026-07-07` is
  UTC midnight, never local (doc-review — avoid the offset bug). Register the command: NEW file
  `commands/audit.ts` + add it to the citty subCommands in `cli/src/index.ts` (mirror `keys.ts`;
  **`index.ts` is part of Slice C's touch-set** — disjoint from Slice B, so B∥C stays collision-safe).
- **C tests:** filters work; `--json` emits parseable entries; absent file is graceful; a malformed
  line is skipped (not fatal) with a count.

## §3 — The AuditEntry schema (§0 decision 1 folded in)

```
{
  v: 1,
  ts: <ISO string>,               // pino time
  event: "tool_call",
  correlationId: <ulid>,          // one per call
  principal: {
    kind: "api-key" | "stdio",
    keyId: <string> | null,       // ResolvedKey.keyId (HTTP) / null (stdio) — PUBLIC id, never the secret
    label: <string> | null,       // key label (HTTP) / null (stdio) — non-secret
    profiles: [<string>, …]       // scoped profile name(s); stdio → [the served profile]
  },
  target: {
    profile: <string>,            // routed profile
    namespace: <string>,          // source toolNamespace (from the split name)
    tool: <string>                // raw tool name (from the split name)
  },
  argKeys: [<string>, …],         // SORTED arg key names — NEVER values (§0 decision 1)
  argHash: <sha256-hex>,          // stable hash of the args object — for correlation, NOT reversible to values
  durationMs: <number>,
  outcome: "ok" | "error",
  errorKind: <UpstreamError["kind"]> | null   // DISCRIMINATED TAG ONLY — never cause/message/body.
                                              // Now includes "tool-denied" (policy block, distinct
                                              // from "tool-not-found" = genuine unknown) per §0 dec 6.
}
```

**`event` is the literal `"tool_call"`.** `listTools`/`tools/list` enumeration is **OUT OF SCOPE this
increment** (doc-review — decided, not a builder guess): the schema has one `event` value; auditing
enumeration is a coherent fast-follow (recorded in §6). The hook wraps `callTool` only, not `listTools`.

**Per-invocation locals (doc-review — pin so a builder doesn't hoist):** `correlationId` (a fresh
ulid) and `start = performance.now()` are `const`s generated INSIDE `callTool` per invocation — NEVER
per-sink/per-session (else every line shares one id/duration). pino's `logger.info` is concurrency-safe;
the sink is built once per process but each emit is independent.

**`target.profile` = the ROUTED profile** (from the prefixed-name parse, B3), distinct from
`principal.profiles` = the key's FULL resolved scope (for a global key, the whole fleet — the
"authority"). Both are recorded distinctly: authority (what the key COULD reach) vs the one profile
this call DID route to. For unprefixed (single-profile/stdio), they coincide.

**NEVER logged (hard list):** the credential plaintext / `ResolvedSecret` (never reaches this seam —
keep it that way); the raw junction API key/token (log `keyId` only); the upstream RESPONSE body
(`result.value.content` — may echo secrets/PII); the upstream ERROR cause/message (`error.cause` /
`safeUpstreamMessage` text — log `error.kind` only); the arg VALUES (log keys + hash only).

## §4 — Reviewers (parallel, per-slice)

- **junction-credential-security (LEAD)** — the whole increment's risk is "does a secret reach
  `audit.log`?" Adversarial: trace the args map, the error cause, the response body, the key — confirm
  NONE reach the sink. Confirm the arg-hash is not reversible and argKeys carry no values.
- **ce-correctness** — the emit fire-and-forget (never breaks the call), the flush-on-exit (last line
  not dropped), the namespaced-name split arity, the JSONL malformed-line resilience.
- **junction-package-boundary** — core stays pino-free + HTTP-free (pino only at the edge); the sink
  interface is injected, not imported into core; depcruise clean.
- **junction-clean-code** — single-purpose modules, typed errors, no sync I/O on the hot path.
- Skip: web (none this increment), data-migration (no migration), sandbox/mcp-contract/tui.

## §5 — QA (orchestrator, REAL artifact)

Ephemeral home `/tmp/jt31`. Build; seed a real connected source (reuse the 30.12 GitHub graphql
connect harness). Then:
1. **stdio:** `junction mcp serve --profile <p>` wired to a real MCP client (or drive the built
   `adaptToMcpHandlers` via a Node harness) → call a real tool → assert `audit.log` gets a
   `principal.kind:"stdio"` line with the right profile/namespace/tool/argKeys/argHash/ok+duration.
2. **HTTP:** `junction keys create` + `junction serve` (localhost) → hit `/mcp` with the key → call a
   tool → assert the line has `principal.kind:"api-key"`, the keyId + label, the scoped profile.
3. **error path:** force an upstream failure (bad token / unreachable) → `outcome:"error"` + the kind;
   assert NO cause/body in the line.
4. **ADVERSARIAL secret sweep:** `grep -a` the real credential value, the arg VALUES I passed, and the
   raw API key against `audit.log` → ALL absent. Only ids/metadata/hashes present.
5. **flush-on-exit:** the last call before a clean shutdown is present (not dropped).
6. **`junction audit --json`** returns the entries; filters narrow correctly; absent file is graceful.
7. **MULTI-PROFILE ARITY (doc-review — the six-step QA above only covers a single-profile key; this
   is the branch the arity bug would ship through):** `junction keys create --scope profiles` (≥2
   profiles) or `--scope global` → call a tool via `/mcp` → assert `target.profile`/`namespace`/`tool`
   are each parsed CORRECTLY from the `<profile>__<namespace>__<tool>` name (NOT `namespace=<profile>`),
   and `principal.profiles` lists the full scope.
8. **DENIAL distinct from unknown:** a profile with a toolFilter that BLOCKS a tool → call it → audit
   line `errorKind:"tool-denied"`; call a genuinely nonexistent tool → `errorKind:"tool-not-found"`;
   AND assert the agent-facing error TEXT is identical for both (existence-hiding intact).
9. **REVOKED key:** create a key, make a call (audited), revoke it, run `junction audit --key <keyId>`
   → the old line still shows the `label` (row retained); a call attempted AFTER revoke audits with
   `profiles:[]` and an error outcome.

## §6 — Registers (step 9)

- `revisit-when.md`: strike the "pino (audit) — installed at its increment" row (row ~23, resolved
  inc 31). Add: (a) web `/audit` real page (fast-follow leaf); (b) SQLite `audit_events` table
  (trigger: indexed-query volume); (c) `--audit-args` full-value opt-in (trigger: forensic need);
  (d) **audit-log rotation/retention** (trigger: `audit.log` size — v1 is unbounded append; a broker
  auditing every call grows without bound); (e) **listTools/enumeration auditing** (a `tools_list`
  event — deferred this increment).
- `gotchas.md` (inc 13): the `removeCredential` store-delete-swallow forward-fix ("once pino lands,
  emit a warn so the orphan is observable") is now UNBLOCKED — note it as a follow-up (not built here).
- `docs/methods/README.md` map + `docs/STATE.md` marker → 31 + §7 reflection.
