<!-- SPDX-License-Identifier: AGPL-3.0-only -->
---
increment: 33 (Slice E — adversarial isolation test suite)
title: Code Mode Slice E — adversarial isolation / budget / leak / audit test suite
depends_on: [33b, 33c, 33d]
touches: [packages/code-mode (tests), cli (tests)]
---

# Inc 33 Slice E — adversarial test suite

The proof that code mode is actually safe. These tests ARE the deliverable that lets the sandbox-security review sign off. Full context: `docs/methods/33-code-mode.md`. Builds on B (engine) + C (MCP surface) + D (CLI).

**Proof-of-done:** a test suite (in `@junction/code-mode` + a cli integration test) that adversarially proves each isolation/budget/leak/audit property, each test FAILING if the corresponding guard were removed. `pnpm verify` green.

## The required tests (each must genuinely exercise the guard)
1. **Zero ambient authority:** guest code referencing `fetch`, `XMLHttpRequest`, `WebSocket`, `process`, `require`, `globalThis.process`, `import(...)`, `Deno`, `Bun` — each is undefined/throws inside the guest; assert the guest cannot perform any I/O except through `tools.*`.
2. **No filesystem/env reach:** no `fs`, no `process.env`, no `__dirname` — undefined.
3. **Budget — CPU/wall:** an infinite `while(true){}` is interrupted by the deadline handler → `timeout` outcome, not a hung host.
4. **Budget — memory:** a runaway allocation hits `setMemoryLimit` → a bounded failure, not host OOM.
5. **Budget — output/log/arg caps:** a huge `console.log` / huge return value / huge tool-call arg is truncated+flagged / rejected, not unbounded host allocation.
6. **Secret non-leakage (the executor.sh leak-test analogue):** inject a fake ProfileProxy whose `callTool` returns an Err whose cause embeds `sk_live_PLANTED`, an internal URL with a token, and a file-path stack. Run guest code that calls that tool and tries to surface the error (return it, log it, JSON.stringify it). Assert the PLANTED secret appears NOWHERE — not in the guest return, not in logs, not in the ExecuteResult, not in any audit line — only the opaque `safeUpstreamMessage` text.
7. **Prototype pollution:** guest code that marshals an object with a `__proto__`/`constructor.prototype` payload cannot mutate the HOST `Object.prototype` (assert a host-side sentinel is untouched after execution). Null-prototype marshaling holds.
8. **Handle-leak regression:** run K≥100 facade tool calls in one execution, then assert `context.dispose()` / `runtime.dispose()` do NOT throw (a throw = a leaked handle — the #1 QuickJS trap).
9. **Audit emission:** a run that calls M tools emits exactly M `tool_call` lines + 1 `code_exec` line, all sharing the execution's correlationId; the code_exec line carries no code text / no arg values; a tool that errors records outcome:"error" + errorKind on its tool_call line.
10. **Reserved-namespace:** a source/profile named `junction` is rejected at the schema; a legacy `junction__*` tool triggers the serve-time refuse+warn (Slice C guard).
11. **Filtered-toolset-only:** the facade built from a FILTERED listTools does NOT expose a tool the profile's toolFilter denies (assert calling it fails as if unknown — no new access path around toolFilter).
12. **Guest exception hygiene:** a guest `throw new Error("x")` → `{ok:false, kind:"guest-error", message}` with NO host stack frame / no internal path in the message.

## Hard invariants
- Each test must fail if its guard is removed (not vacuous) — where practical, note in a comment what removal breaks it.
- Use a FAKE ProfileProxy for the leak/budget/audit tests (fast, deterministic, plants the secret) — not a live upstream.
- No secret in test output/fixtures beyond the deliberately-planted sentinel (which must be proven ABSENT from results).

## Do NOT
- Do NOT weaken a guard to make a test pass — if a test can't pass, the guard is wrong; STOP and report.
- No push. Commit locally.

## Steps
1. Write the suite (co-located in code-mode + a cli integration test for `junction run`). 2. For the highest-value guards (secret-leak #6, handle-leak #8, ambient-authority #1), TEMPORARILY remove the guard locally, confirm the test FAILS, restore, confirm green — report which you verified this way (don't commit the removals). 3. `pnpm verify` green.
Report: the test list + what each proves, which guards you verified fail-without, deviations, verify summary. This suite is what the junction-sandbox-security LEAD review consumes.
