<!-- SPDX-License-Identifier: AGPL-3.0-only -->
---
increment: 33
title: Code Mode — sandboxed JS over the ToolProvider proxy
depends_on: []
soft_after: [32.13]
touches: [core/audit, cli/providers, code-mode(new package), mcp/server, cli, web-optional]
parallel_group: wave   # mode-A: blocking Slice A, then B/C/D/E fan out
---

# Increment 33 — Code Mode

An agent submits JavaScript that runs SANDBOXED with bindings to the profile's brokered tools, replacing N MCP round-trips with one code execution. **v1 = in-process QuickJS-WASM (asyncify) behind a `CodeExecutor` interface**, exposed as a synthetic MCP tool (`junction__run_code`) + a `junction run` CLI. The tool facade is generated from the profile's ALREADY-FILTERED `listTools()`, so code can only reach what the profile exposes. Distribution (34) stays out of scope.

> **Research basis:** `scratchpad/inc33-research-synthesis.md` (two Opus reports — QuickJS deep-dive + executor.sh competitor). Read it. Key stolen ideas: the opaque-error membrane, the lazy non-enumerable `tools` proxy, `tools.search()`/`describe()` discovery, the runtime-agnostic executor interface. Key divergences: neverthrow not Effect; per-tool audit is a security contract not just observability; QuickJS v1 with a Deno-subprocess escalation path recorded.

## The one decision surfaced to the user (hold loosely)
**Runtime default.** The two research passes disagreed. Shipping design: a thin `CodeExecutor` interface, **in-process QuickJS-asyncify as the v1 runtime**, with the Deno-subprocess runtime recorded as the escalation path (revisit-when trigger: running genuinely hostile/third-party code, or a wedged-WASM hard-kill requirement). Rationale: the guest is LLM-authored on the single user's OWN behalf; the credential NEVER enters the sandbox (host-side resolution via the existing proxy); the WASM boundary gives in-process memory isolation with zero ambient authority; sub-ms dispatch beats a 25ms subprocess for the N-round-trip-collapse use case. **If the sandbox-security doc-review deems in-process insufficient, fall back to Deno-subprocess v1 — that's the genuine fork.** Surface this in the plan-approval report. **Honest asymmetry (feasibility-confirmed): reusing junction's existing Deno sandbox is MORE work, not less** — `runWithDeno` isolates capability-scoped I/O-doing code (temp `.ts`, allowlists, outer OS sandbox); code-mode wants the opposite (zero-ambient-authority guest whose only I/O is the host facade), and Deno has NO guest→host callback channel, so it needs a net-new nonce-tagged stdio-IPC protocol (more code than the QuickJS bridge) + 25ms/spawn on the N-round-trip-collapse hot path. Deno's real win (SIGKILL a wedged guest, OS membrane on escape) is the escalation trigger. The reusable Deno part is only the outer `runSandboxed` wrapper the escalation runtime would adopt, not the execution model.

## Proof-of-done (v1)
1. `junction run <file.js> --profile <name> [--json]` executes agent JS; inside, `await tools.<namespace>.<tool>(args)` calls the REAL brokered tool through the existing proxy; the return value comes back; `console.log`/`emit` captured (bounded).
2. A synthetic `junction__run_code` MCP tool (reserved-namespace guarded) exposes the same engine per profile, obeying arity naming (`<ns>__` single / `<profile>__<ns>__` multi) and toolFilter (facade built from the FILTERED listTools).
3. **Isolation proven adversarially:** guest JS has NO `fetch`/`process`/`fs`/`env`/`import`; a guest attempt to reach a credential or a non-exposed tool fails; memory/CPU/output budgets enforced; a guest exception returns a structured error, never a host stack trace; NO secret value crosses into the guest via any facade path or error.
4. **Audit:** every `tools.*` call from inside code mode emits its own `tool_call` audit line through the shared seam, PLUS one wrapping `code_exec` audit entry tying them by correlationId.
5. `pnpm verify` green; the new package respects the one-way dependency direction (QuickJS is NOT in core).

## Wave decomposition (mode A — subagents, serial integration)
### Slice A — BLOCKING (core/shared; lands first, alone)
- **Audit-emit extraction → CORE (not source-runtime, not cli).** The emit block is `cli/providers.ts:129-150` and depends on `parseWireName` defined IN THE SAME cli file (`providers.ts:56`). The shared helper's ONLY boundary-valid home is `core/src/audit/emit.ts` (emit touches only core symbols: AuditEntry/AuditPrincipal/AuditSink/AuditTarget/argKeys/hashArgs). source-runtime is WRONG (adaptToMcpHandlers lives in cli precisely to keep source-runtime free of an mcp-server edge — its own header says so). The helper takes a **pre-built `AuditTarget`** (each caller derives its own — code-mode knows profile/ns/tool directly and needn't parse a wire name). **Sub-step (explicit): relocate `parseWireName` cli→core** so `adaptToMcpHandlers` still derives its target after the emit logic moves (a pure, test-locked API move — the arity-split table test in `cli/providers.test.ts` moves with it). No behavior change; existing `cli/providers.test.ts` + `cli/audit-sink.test.ts` pass unchanged.
- **correlationId is UUID, not ULID.** `providers.ts:124` uses `crypto.randomUUID()` (the schema.ts:55 "ulid" comment is stale pre-existing drift — fix the comment too). code_exec's correlationId MUST use the same UUID format so proof-of-done #4's parenting (inner tool_call lines ↔ wrapping code_exec) actually joins.
- **`code_exec` audit event — schema AND both renderers (the real work).** Extend `AuditEntrySchema` (`core/src/audit/schema.ts`) into a DISCRIMINATED UNION on `event`: keep the `tool_call` member BYTE-IDENTICAL (old lines still validate), add a sibling `CodeExecEntrySchema` (event:"code_exec", v, ts, correlationId, principal, profile, durationMs, outcome, toolCallCount — NO code text / NO arg values / NO tool field). Reader `read.ts:31-35` is already safe (safeParse→skip on failure; no DB, JSONL-additive). **But the reader tolerating it is FREE — the real work is the two RENDERERS, which currently read `e.target.tool`/`e.argKeys`/`e.errorKind` on EVERY entry and would break-or-garbage on a tool-less code_exec, silently defeating proof-of-done #4:** make `cli/commands/audit.ts:36-45 formatHuman` branch on `e.event`; add an `event` discriminator + `code_exec` variant to `web/audit.server.ts:52-65 toDto`'s `AuditEntryDTO` + render it in `web/routes/audit.tsx`. Decide `--tool` filter behavior: code_exec has no tool → match `--profile`, exempt from `--tool`. **This is the ce-data-migration-reviewer + junction-web-reviewer gate.**
- Run `pnpm verify`. Freeze the `core/src/audit/emit.ts` interface + the schema before B starts.

### Slice B — `@junction/code-mode` (new leaf package; the bulk)
- New `packages/code-mode/` (`@junction/code-mode`), depends on `@junction/core` (proxy types, AuditEntry, the Slice-A emit helper, argHash) + `@junction/mcp-server` (for `safeUpstreamMessage`) + the pinned `quickjs-emscripten-core` + a pinned asyncify variant (recommend `@jitl/quickjs-singlefile-mjs-release-asyncify` — ESM, no .wasm asset). **QuickJS must NOT land in core** (core stays pure/embeddable/HTTP-free — the `junction-package-boundary` gate). **Keep `safeUpstreamMessage` in mcp-server — do NOT move it to core** (it's the MCP-agent-facing existence-hiding membrane, its `tool-denied`→`tool-not-found` collapse is an MCP protocol decision = an edge concern; code-mode depends on it via a LAZY import so a CLI-only `junction run` doesn't eagerly load the MCP server).
- The `CodeExecutor` interface: `execute(code: string, invoker: ToolInvoker, opts): Promise<Result<ExecuteResult, CodeModeError>>`. A `QuickJsExecutor` impl.
- The facade: build `tools.<namespace>.<tool>(args)` (nest one deeper for multi-profile arity) from the injected FILTERED `listTools()`; lazy + NON-ENUMERABLE proxy (Object.keys/for-in throw → "use tools.search()"). `tools.search()` + `tools.describe.tool()` served from junction's SANITIZED+PINNED descriptions (never re-fetch upstream — else code mode bypasses 32.5/32.11).
- Guest→host bridge via asyncify `newAsyncifiedFunction`: host reads args (Scope-wrapped `context.dump`), calls the REAL `proxy.callTool` via the shared audited wrapper (Slice A), marshals the ToolResult back as JSON. **Each bridge call wraps its FULL arg-dump → host-call → result-marshal in ONE `Scope`/`using` that cannot outlive the call** — an N-tool facade marshaling nested JSON per call is exactly where leaked handles accumulate, and a leaked handle makes `context.dispose()` throw (the #1 correctness trap). Null-prototype parsing both directions (prototype-pollution guard).
- Budgets: `runtime.setMemoryLimit`, `setMaxStackSize`, deadline interrupt (`shouldInterruptAfterDeadline`), an OUTER `Promise.race` total-execution timeout, guest-arg size cap, result/log byte caps (truncate+flag).
- Errors: guest exception → `{ok:false, kind:"guest-error", message}` (no host stack); a host/tool Err → reject the guest promise via `safeUpstreamMessage` (secret-safe, no cause/body). Emit the wrapping `code_exec` audit entry.

### Slice C — MCP surface (mcp/server + cli serving)
- A synthetic `junction__run_code` tool per profile. **RESERVED-NAMESPACE guard needs TWO enforcement points** (the audit confirmed `junction` is a LEGAL namespace today — `ToolNamespaceSchema` `^[a-z0-9]+(_[a-z0-9]+)*$` matches it, and `proxy.ts:421` routes callTool by first-match so a source named `junction` would shadow the synthetic tool):
  1. **Write-guard:** reserve `junction` via `.refine` in BOTH `ToolNamespaceSchema` AND `ProfileNameSchema` (a profile literally named `junction` also seams the unprefixed arity tier). Charset-contract change → `junction-mcp-contract` review.
  2. **Serve-time read-guard:** the schema refine CANNOT retroactively clean a legacy DB that already holds a `junction`-namespaced source — so before registering `junction__run_code`, assert no proxy tool name starts with `junction__` and refuse+warn on collision.
  Schema `{ code: string, timeoutMs?: number }`; description explains the facade, that only THIS profile's filtered tools are visible, and the token-savings model. Arity-correct naming. Inherits into the HTTP `/mcp` scoped-proxy.

### Slice D — CLI (`junction run`)
- `junction run <file.js> --profile <name>` + `--json` headless. Thin argv→core edge (builds the ProfileProxy exactly as serving does, hands proxy + audit sink to code-mode).

### Slice E — adversarial test suite
- Guest isolation (no fs/net/env/process/import reachable — assert each throws); budget enforcement (infinite loop → deadline interrupt; huge alloc → memory limit; huge output → capped); secret non-leakage (a facade call whose provider errors with a planted secret → guest sees only the opaque message — the executor.sh `tool-invoker.leak.test.ts` is the template); prototype-pollution (guest can't pollute host Object.prototype via a marshaled object); **handle-leak regression (K≥100 facade calls, then assert `context.dispose()`/`runtime.dispose()` don't throw — a throw is the leak signature)**; audit emission (N inner `tool_call` lines + 1 `code_exec`, correct UUID correlationId parenting); reserved-namespace collision refused at BOTH the schema and serve-time read-guard.

## Hard invariants
- The credential NEVER enters the guest (host-side resolution via the proxy is unchanged — code mode is a new CALLER, proxy.ts untouched).
- Code mode is NOT an access-control layer — it can't stop an agent exfiltrating THROUGH a tool it's allowed to call; that's the profile/toolFilter/audit layer's job (state this explicitly so it isn't over-scoped).
- Every in-code tool call is individually audited (a security contract, not observability) — no un-audited batch.
- QuickJS not in core; one-way deps hold; core stays HTTP-free.
- No secret / code text in any audit line or error.
- Scope/dispose discipline on every WASM handle.

## Do NOT
- Do NOT propose node:vm or isolated-vm (banned).
- Do NOT re-fetch upstream descriptions for describe() (bypasses sanitize/pin) — serve junction's pinned/sanitized ones.
- Do NOT ship streaming/partial results, filesystem-as-state, skills persistence, a warm QuickJS pool, or an approval/pause-resume flow (all deferred — record triggers).
- Do NOT hand-fix migration journals; the audit event change is JSONL-additive, not a DB migration.
- Commit locally per slice; never push (orchestrator ships).

## Reviewers (post-build, per-slice in parallel then integrated)
`junction-sandbox-security` (LEAD — this is its activation increment for the WASM isolation model) · `junction-credential-security` (adversarial: prove no secret reaches the guest) · `junction-mcp-contract` (synthetic tool naming/arity/isolation; reserved namespace) · `ce-security-reviewer` + `ce-data-migration-reviewer` (the `code_exec` audit schema change) · `junction-package-boundary` (QuickJS not in core) · `junction-clean-code`.

## Plan gate
This is a large security-critical increment. Before build: run a feasibility + sandbox-security DOC-review on THIS method file (ce-feasibility + a sandbox-security lens) — confirm the QuickJS-asyncify approach, the audit-schema change shape, and the runtime-default decision. Surface the runtime-default fork in the plan-approval report to the user.
