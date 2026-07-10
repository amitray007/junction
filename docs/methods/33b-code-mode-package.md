<!-- SPDX-License-Identifier: AGPL-3.0-only -->
---
increment: 33 (Slice B — the @junction/code-mode package)
title: Code Mode Slice B — QuickJS executor + tools facade + audited bridge
depends_on: [33a]
touches: [packages/code-mode (new)]
---

# Inc 33 Slice B — `@junction/code-mode`

The engine: a new leaf package running agent-authored JS in in-process QuickJS-WASM (asyncify), exposing the profile's brokered tools as an async `tools.*` facade over the existing ToolProvider proxy. This slice is self-contained in the NEW package — it touches no existing file. Full increment context: `docs/methods/33-code-mode.md`. Builds on Slice A's `core/src/audit/emit.ts` (already merged into this worktree's base).

**Proof-of-done:**
1. `@junction/code-mode` exports a `CodeExecutor` interface + a `QuickJsExecutor` implementing it: `execute(code, invoker, opts) → Promise<Result<ExecuteResult, CodeModeError>>`.
2. Given an injected `ProfileProxy` (the `{listTools, callTool}` interface from `core/sources/proxy.ts`) + principal + audit sink, agent JS can `await tools.<namespace>.<tool>(args)` and reach the REAL brokered tool; the return value comes back; `console.log`/`emit` captured (bounded).
3. Every facade call emits its own `tool_call` audit line via Slice A's `emitToolCall`; one wrapping `code_exec` line via `emitCodeExec` on completion, sharing a correlationId.
4. Budgets enforced (memory, stack, deadline-interrupt, outer total timeout, arg/result/log byte caps). Guest exception → typed `{ok:false, kind:"guest-error", message}` (no host stack); a host/tool Err → guest promise rejects via `safeUpstreamMessage` (secret-safe).
5. `pnpm verify` green; QuickJS is confined to THIS package (not core).

## Read first
- `docs/methods/33-code-mode.md` (the full plan — Slices, invariants, do-NOTs) + `scratchpad/inc33-research-synthesis.md` (the QuickJS API details, executor.sh binding patterns, Scope/dispose discipline).
- `packages/core/src/sources/proxy.ts` — the `ProfileProxy` interface (`listTools(): ResultAsync<ProviderTool[]>`, `callTool(name, args): ResultAsync<ToolResult>`), `ProviderTool` (`{name, description?, inputSchema}`), `ToolResult`.
- `packages/core/src/audit/emit.ts` — `emitToolCall`/`emitCodeExec` signatures (already exported from `@junction/core`); `AuditSink`, `AuditPrincipal`.
- `packages/mcp/server/src/index.ts` — `safeUpstreamMessage` (import LAZILY).
- An existing leaf package for the package.json/tsconfig/tsdown shape to mirror: `packages/openapi-client/` or `packages/http-client/`.

## Changes (all NEW files in `packages/code-mode/`)
1. **Package scaffold:** package.json (`@junction/core` + `@junction/mcp-server` deps + `quickjs-emscripten-core` + `@jitl/quickjs-singlefile-mjs-release-asyncify`, both PINNED), tsconfig (references core + mcp-server), tsdown config — mirror an existing leaf. Add the package to the workspace + any depcruise allowances (a `code-mode → core, mcp-server` edge is allowed; `core → code-mode` must be BANNED — add the rule if depcruise doesn't already forbid it by default).
2. **`src/types.ts`:** `CodeExecutor`, `ToolInvoker` (a thin `{callTool(name, args): Promise<Result<ToolResult, UpstreamError>>, listTools(): Promise<ProviderTool[]>}` the executor calls — the ProfileProxy adapts to it), `ExecuteResult = {ok:true, value:unknown, logs:string[], emitted:number, toolCallCount:number} | {ok:false, kind:"guest-error"|"timeout"|"memory"|"internal", message:string}`, `CodeModeError`, `ExecuteOpts` (timeoutMs, memoryBytes, maxStackBytes, argByteCap, resultByteCap, logByteCap — with sane defaults).
3. **`src/quickjs-executor.ts`:** the `QuickJsExecutor`. Uses `newQuickJSAsyncWASMModuleFromVariant` (or the module's async factory) once, a fresh `QuickJSAsyncContext` per `execute`. Installs: the `tools` facade (see 4), a bounded `console` (log/error → capped buffer), an `emit(v)` (capped count). Sets memory/stack limits + a deadline interrupt handler. Runs `evalCodeAsync(code)` inside an outer `Promise.race([_, totalTimeout])`. Disposes context+runtime in `finally` (a leaked handle throws — that's the signal). Emits the wrapping `code_exec` line.
4. **`src/facade.ts`:** builds the `tools` global from the injected FILTERED `listTools()`. For each `<namespace>__<tool>` (split via core's `parseWireName`/the `__` contract), install `tools[ns][tool]` (nest one deeper for multi-profile arity) as an asyncified host fn. LAZY + NON-ENUMERABLE proxy: `Object.keys`/`for-in`/spread throw "use tools.search()". `tools.search({query})` + `tools.describe.tool({path})` served from the SANITIZED descriptions the proxy already returns (never re-fetch upstream). Each bridge call: ONE `Scope`/`using` wrapping arg-dump → the audited host callTool (see 5) → result-marshal; null-prototype parse both directions; arg-size + result-size caps.
5. **`src/audited-invoker.ts`:** wraps the injected `ProfileProxy.callTool` so each guest tool call: derives an `AuditTarget` (profile/namespace/tool), times it, calls the real callTool, and `emitToolCall`s (via core, sharing the execution's correlationId) with outcome/errorKind — reusing Slice A's seam so a code-mode call is audited byte-identically to an MCP-served one. On Err, reject the guest promise with `safeUpstreamMessage(err)` (lazy mcp-server import) — no cause/body/secret.
6. **`src/index.ts`:** export `CodeExecutor`, `QuickJsExecutor`, the types, and a `runCode(code, proxy, {principal, sink, opts}) → Promise<ExecuteResult>` convenience the CLI/MCP slices call.

## Hard invariants
- QuickJS deps ONLY in this package. core stays clean (junction-package-boundary gate). `core → code-mode` edge forbidden.
- The credential NEVER reaches the guest (the proxy resolves host-side, unchanged — code-mode is a new caller).
- Guest has ZERO ambient authority: no fetch/process/fs/env/import globals installed. Only `tools`, `console`, `emit`.
- Every facade tool call individually audited (security contract). No un-audited batch.
- No secret / code text in any audit line or guest-facing error (safeUpstreamMessage is the membrane).
- Every WASM handle in a Scope/using — context.dispose() must not throw.
- Null-prototype marshaling both directions (prototype-pollution guard).

## Do NOT
- Do NOT install fetch/XHR/WebSocket/process/require/import in the guest (the whole point).
- Do NOT re-fetch upstream descriptions in describe() (bypasses 32.5 sanitize / 32.11 pin — use what the proxy returns).
- Do NOT put QuickJS in core; do NOT move safeUpstreamMessage to core (lazy-import it from mcp-server).
- Do NOT ship streaming/filesystem-state/skills/warm-pool/approval-pause (deferred).
- No node:vm / isolated-vm (banned). Commit locally; never push.

## Steps
1. Scaffold the package + confirm the QuickJS asyncify module loads in a Node 22 ESM smoke (`pnpm build` + a tiny `node -e` eval of `1+1` in a fresh context) BEFORE building the facade — de-risk the dep first.
2. types + executor + facade + audited-invoker + index, with tests alongside.
3. QA: a Node harness — inject a FAKE ProfileProxy (a couple of canned tools) + a spy sink; run agent code that (a) calls a tool and returns its result, (b) loops N times over a tool, (c) tries `fetch`/`process` (throws), (d) throws (typed guest-error), (e) triggers a provider Err with a planted secret in the cause (guest sees only opaque text) → assert the spy sink got N tool_call lines + 1 code_exec, and the planted secret is ABSENT everywhere. Include the transcript.
4. `pnpm verify` green. Report: package layout, the CodeExecutor/ExecuteResult shapes, the QA transcript, the QuickJS variant + version pinned, deviations, verify summary.
