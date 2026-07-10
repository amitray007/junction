<!-- SPDX-License-Identifier: AGPL-3.0-only -->
---
increment: 33 (Slice C — MCP surface + reserved namespace)
title: Code Mode Slice C — junction__run_code synthetic MCP tool + reserved-namespace guard
depends_on: [33a, 33b]
touches: [core/schema, mcp/server, cli/serving, source-runtime]
---

# Inc 33 Slice C — MCP surface

Exposes the code-mode engine (Slice B) as a synthetic per-profile MCP tool `junction__run_code`, with the two-point reserved-namespace guard the feasibility review required. Full context: `docs/methods/33-code-mode.md`.

**Proof-of-done:**
1. A profile served over stdio (`junction mcp serve`) or the keyed `/mcp` HTTP endpoint exposes a synthetic tool named `junction__run_code` (arity-correct: `<profile>__junction__run_code` under a multi-profile/global key). Its schema is `{ code: string, timeoutMs?: number }`; its description explains the `tools.*` facade + that only THIS profile's filtered tools are visible + the token-savings model.
2. Calling it runs Slice B's engine over the SAME profile proxy the server already built (filtered listTools → the facade); the result returns as MCP content.
3. **Reserved-namespace guard, TWO points:** (a) `ToolNamespaceSchema` + `ProfileNameSchema` reject `junction` via `.refine`; (b) at serve time, before registering `junction__run_code`, refuse+warn if any existing proxy tool name starts with `junction__` (a legacy DB may hold a `junction`-namespaced source the schema can't retroactively clean).
4. `pnpm verify` green.

## Read first
- `packages/mcp/server/src/server.ts` (createMcpServer ~:129-146 — registers proxy tools; where the synthetic tool is added) + `packages/mcp/server/src/index.ts` (safeUpstreamMessage).
- `packages/cli/src/providers.ts` (adaptToMcpHandlers — how tools are adapted; the synthetic tool must flow through the SAME audited handler path, or emit its own code_exec wrapping + inner tool_call lines via Slice B).
- `packages/cli/src/commands/{serve.ts,mcp.ts}` — where the ProfileProxy + audit sink are built and handed to the server (the same objects Slice B needs).
- `packages/core/src/schema/*` — `ToolNamespaceSchema`, `ProfileNameSchema` (add the reserve refine).
- `packages/core/src/sources/scoped-proxy.ts` — how the HTTP multi-profile arity prefixes names (the synthetic tool inherits this).
- Slice B's `@junction/code-mode` `runCode`/`QuickJsExecutor` (built in the same worktree base).

## Changes
1. **Reserve `junction`:** in `core/src/schema/*`, add `.refine(v => v !== "junction", "…reserved…")` to `ToolNamespaceSchema` AND `ProfileNameSchema`. Update the charset-contract doc comments. Tests: both schemas reject `junction`, accept everything else.
2. **Synthetic tool registration** (mcp/server + the cli composition root): where the server builds its tool list from the proxy, ADD a `junction__run_code` tool (arity-aware naming — reuse the same prefix logic as the real tools). Its handler builds a `ToolInvoker` from the profile proxy + the audit sink + principal, calls Slice B's `runCode`, maps `ExecuteResult` → MCP content (ok → the returned value as text/JSON content; guest-error/timeout/etc → an isError content with the safe message). The wrapping `code_exec` + inner `tool_call` audit lines come from Slice B.
3. **Serve-time read-guard:** before adding the synthetic tool, check the proxy's listTools for any name starting with `junction__`; if found, refuse to register the synthetic tool + warn (stderr on stdio; the HTTP path logs) — never silently shadow. (This is the legacy-DB safety the schema refine can't cover.)
4. Confirm the synthetic tool inherits into the scoped-proxy/HTTP path with correct arity prefixing.

## Hard invariants
- `junction` reserved at BOTH schema (new sources) and serve-time (legacy sources).
- The synthetic tool's engine sees only the profile's FILTERED tools (build the facade from the same filtered listTools the server uses — no new access path).
- Arity naming correct (single `junction__run_code` / multi `<profile>__junction__run_code`).
- Every in-code tool call audited (via Slice B) + the wrapping code_exec.
- stdout purity on stdio serve (the run_code result goes through the MCP protocol response, not a stray write).

## Do NOT
- Do NOT give the synthetic tool a broader toolset than the profile exposes.
- Do NOT bypass safeUpstreamMessage for guest-facing errors.
- Do NOT register the synthetic tool if a legacy `junction__*` collision exists — refuse+warn.
- No push. Commit locally.

## Steps
1. Schema reserve + tests → commit. 2. Synthetic tool registration + handler wiring → commit. 3. Serve-time guard → commit. 4. QA: build; `junction mcp serve --profile <seeded>` and list tools (agent-style) → `junction__run_code` present; call it with a snippet that uses a real seeded tool → result returns + audit log shows N tool_call + 1 code_exec; try a profile/namespace named `junction` → rejected. Report the transcript.
Report: files, the synthetic tool schema/description as shipped, the two-guard proof, QA transcript, verify summary.
