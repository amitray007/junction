<!-- SPDX-License-Identifier: AGPL-3.0-only -->
---
increment: 33 (Slice A — blocking core foundation)
title: Code Mode Slice A — shared audit-emit helper (core) + code_exec audit event + event-aware renderers
depends_on: []
touches: [core/audit, cli/providers, cli/commands/audit, web/audit-server, web/routes/audit]
---

# Inc 33 Slice A — audit foundation (BLOCKING, lands first alone)

The blocking core slice for Code Mode. Extracts the audit-emit logic into a shareable core helper (so a later code-mode package emits byte-identical `tool_call` lines through the SAME seam) and adds a `code_exec` audit event with event-aware rendering. **No code-mode package yet — this is pure groundwork.** Full context: `docs/methods/33-code-mode.md` (write it too — see step 1).

**Proof-of-done:**
1. `core/src/audit/emit.ts` exports a helper that builds + emits an `AuditEntry` `tool_call` line given (sink, principal, pre-built `AuditTarget`, args, outcome, durationMs, errorKind). `adaptToMcpHandlers` (cli/providers.ts) is rewired onto it with ZERO behavior change (existing `cli/providers.test.ts` + `cli/audit-sink.test.ts` pass unchanged).
2. `parseWireName` relocated cli→core (it's a pure arity-split helper; its table test moves too). `adaptToMcpHandlers` imports it from core.
3. `AuditEntrySchema` becomes a discriminated union on `event`: the `tool_call` member is BYTE-IDENTICAL (old JSONL lines still validate); a new `code_exec` member is added (event:"code_exec", v:1, ts, correlationId, principal, profile:string, durationMs:number, outcome:"ok"|"error", errorKind:string|null, toolCallCount:number — NO code text, NO arg values, NO tool field).
4. The two RENDERERS are event-aware (not just non-choking): `cli/commands/audit.ts formatHuman` branches on `e.event`; web `audit.server.ts toDto` + `AuditEntryDTO` gains an `event` discriminator + a code_exec variant; `web/routes/audit.tsx` renders it. `junction audit --tool <x>` exempts code_exec (it has no tool); `--profile` still matches it.
5. `pnpm verify` green (incl. verify:web). No secret / code text / arg value in any code_exec line.

## Read first
- `packages/cli/src/providers.ts` (whole file — the emit block ~:121-150, parseWireName ~:56, adaptToMcpHandlers; note its header explains why it lives in cli — do NOT move adaptToMcpHandlers, only the emit + parseWireName pieces)
- `packages/core/src/audit/schema.ts` (AuditEntrySchema — note event:z.literal("tool_call"), v:z.literal(1); the "ulid" comment on correlationId at :55 is STALE — providers.ts:124 uses crypto.randomUUID(); fix the comment)
- `packages/core/src/audit/read.ts` (readAuditLogTail — safeParse→skip; confirm the union keeps tool_call validating)
- `packages/core/src/audit/{sink.ts,redact.ts}` (AuditSink, argKeys/hashArgs)
- `packages/cli/src/commands/audit.ts` (formatHuman ~:36-45 + the --tool/--profile filters)
- `packages/web/src/server/audit.server.ts` (toDto ~:52-65, AuditEntryDTO) + `packages/web/src/routes/audit.tsx`
- `packages/cli/src/providers.test.ts` (the arity-split table test — moves with parseWireName)

## Changes
1. **Write `docs/methods/33-code-mode.md`** = a copy of `/private/tmp/.../scratchpad/33-code-mode.md` (the full increment method file — this Slice A is its first slice). Commit it first (`docs(33): code-mode method file`). Then this Slice A file to `docs/methods/33a-audit-foundation.md`.
2. **core/src/audit/emit.ts (new):** `emitToolCall(sink: AuditSink, entry-inputs) : void` — builds the AuditEntry tool_call (correlationId = crypto.randomUUID(), argKeys+hashArgs via redact, ts ISO), calls `sink.emit`. Pure, no throw (mirror the existing try/catch-swallow at the emit site). Also `emitCodeExec(sink, {correlationId, principal, profile, durationMs, outcome, errorKind, toolCallCount})`. Export both.
3. **Relocate parseWireName cli→core** (e.g. `core/src/audit/wire-name.ts` or into emit.ts): pure function, exported; move its table test to core. providers.ts imports from core.
4. **schema.ts:** refactor to `AuditEntrySchema = z.discriminatedUnion("event", [ToolCallEntrySchema, CodeExecEntrySchema])`. ToolCallEntrySchema = today's exact shape (event:"tool_call"). CodeExecEntrySchema = the new one. Keep `AuditEntry` type = the union. Fix the stale "ulid" comment → "uuid". Update the header hard-list comment to cover code_exec (no code text).
5. **providers.ts:** rewire the emit block to call `emitToolCall(...)` with a locally-derived AuditTarget (from parseWireName). Behavior identical.
6. **Renderers:** formatHuman + toDto + audit.tsx event-aware; filter semantics per proof-of-done #4.

## Hard invariants
- tool_call member BYTE-IDENTICAL (a shape drift breaks old-line validation + the arity attribution).
- No secret / code text / arg value in any audit line (code_exec carries counts + ids + profile only).
- One-way deps: emit + parseWireName live in CORE; cli imports core (not the reverse). No new package.
- correlationId is crypto.randomUUID() everywhere (not ulid) so code_exec ↔ tool_call parenting joins.
- read.ts stays safeParse-tolerant; no DB migration (JSONL file, additive).

## Do NOT
- Do NOT move `adaptToMcpHandlers` out of cli (it needs mcp-server; only emit + parseWireName move).
- Do NOT create the code-mode package here (later slice).
- Do NOT weaken the discriminated union with a passthrough/catch-all member.
- No tsc -b --force; phantom exhaustive errors = stale .tsbuildinfo → pnpm build. Commit locally; never push.

## Steps
1. Method files committed. 2. schema union + parseWireName move + emit.ts (with tests) → commit. 3. providers rewire → commit (existing audit tests green = the regression proof). 4. renderers event-aware → commit. 5. `pnpm verify` green; QA: drive the built `junction audit` reader against a hand-crafted log containing BOTH a tool_call and a code_exec line — both render correctly, --tool filters code_exec out, no secret. Report the transcript.
Report: files, the emit.ts + schema shapes as shipped, the QA transcript, deviations, pnpm verify summary.
