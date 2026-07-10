<!-- SPDX-License-Identifier: AGPL-3.0-only -->
---
increment: 33 (Slice F — facade result ergonomics)
title: Code Mode Slice F — unwrap the MCP content envelope into a usable guest value
depends_on: [33b]
touches: [packages/code-mode]
---

# Inc 33 Slice F — facade result unwrapping

Orchestrator QA on the real built `junction run` found: the facade hands the guest the RAW MCP `ToolResult.content` envelope (`[{"type":"text","text":"200 OK\n{...json...}"}]`) instead of a usable value, so agent code must hand-parse it — `tools.qa.greet(...).greeting` is undefined. This undercuts the whole "LLM writes code to compose tool results" value proposition. This slice presents results usably. Security/isolation/audit are UNCHANGED (this only reshapes an already-marshaled value the guest already receives).

**Proof-of-done:**
1. A tool call whose single text-content is JSON returns the PARSED value to the guest (`tools.qa.greet(...).greeting === "hi ..."`), not the raw envelope.
2. A non-JSON single text-content returns the string text. Multi-part / non-text content returns a documented structured shape (don't lose data). An `isError` result surfaces as documented (a thrown guest error or a flagged shape — match the executor's existing error contract).
3. The `describe.tool()` guidance + the run_code tool description document the returned shape so agents know what to expect.
4. No isolation/audit/secret change — the byte-cap + null-proto marshaling still apply to the unwrapped value; re-run the secret-absence + handle-leak tests green.
5. `pnpm verify` green.

## Read first
- `packages/code-mode/src/quickjs-executor.ts` — where `ToolResult` is marshaled back to the guest (the `result.value.content` marshal site).
- `packages/code-mode/src/audited-invoker.ts` — the ToolResult the facade receives.
- `packages/core/src/sources/provider.ts` — `ToolResult` / content shape (text/json/etc).
- `scratchpad/inc33-research-synthesis.md` — executor.sh's `{ok, data, http?}` envelope (the reference for a clean shape).
- The QA finding in the audit-findings-ledger (the exact raw envelope observed).

## Changes
1. In the facade result marshal path, add an `unwrapToolResult(result)` step: if `content` is a single `{type:"text", text}` and `text` parses as JSON → return the parsed value; else the raw string. Multi-part → an array/structured value (documented). If the upstream text is prefixed like `"200 OK\n{json}"` (the OpenAPI provider's shape — CONFIRM by reading how the openapi/http provider builds content), strip the status line before the JSON parse OR (better) parse only a clean JSON body — investigate the provider's actual content format and unwrap correctly (do NOT hardcode "200 OK" if it's provider-specific; handle the real shapes: openapi, graphql, mcp, cli, http).
2. `isError:true` results → surface per the executor's error contract (thrown guest error with the safe message, or a `{ok:false}` shape — pick one, document it, keep it consistent with how tool errors already surface).
3. Document the returned shape in the run_code tool description + describe() output.
4. Tests: a JSON-body tool → parsed value; a plain-text tool → string; an isError tool → the documented error surfacing; confirm the secret-absence + byte-cap tests still hold on the unwrapped value.

## Hard invariants
- No security/isolation/audit regression — unwrapping happens on the already-marshaled, already-capped value; null-proto parsing still applies (a JSON.parse of guest-adjacent text must use the null-proto reviver to avoid prototype pollution).
- Never surface a raw error cause/body/secret while unwrapping an isError result (safeUpstreamMessage stays the membrane).
- Byte caps still enforced on the unwrapped value.

## Do NOT
- Do NOT hardcode a provider-specific prefix without confirming it's the real shape across all 5 provider kinds.
- Do NOT change the audit lines (they already carry keys+hash+counts).
- Commit locally; never push.

## Steps
1. Read the provider content shapes → understand what actually comes back per kind. 2. unwrapToolResult + isError handling + doc + tests → commit. 3. QA: re-run the real `junction run` against the OpenAPI fixture from the ledger — `tools.qa.greet(...).greeting` now usable; secret sweep still clean; audit still tool_call+code_exec. 4. pnpm verify green.
Report: the unwrap shape as shipped (per provider kind), the isError contract, the re-run QA transcript, deviations, verify summary.
