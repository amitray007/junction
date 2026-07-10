// SPDX-License-Identifier: AGPL-3.0-only
// emitToolCall / emitCodeExec — the SHARED audit-emit seam (increment 33
// Slice A). Extracted from cli's providers.ts adaptToMcpHandlers (increment
// 31 Slice B) so a later code-mode package (increment 33 Slice B) can emit
// BYTE-IDENTICAL `tool_call` lines through the same seam, plus the new
// `code_exec` wrapper line, without duplicating the entry-building logic.
//
// Lives in core (not source-runtime, not cli): both helpers touch only core
// symbols (AuditEntry/AuditPrincipal/AuditSink/AuditTarget/argKeys/hashArgs)
// and no HTTP / mcp-server-package / cli edge concern. adaptToMcpHandlers
// itself STAYS in cli (it needs the mcp-server package's safeUpstreamMessage
// helper — see providers.ts's header) — only the emit-entry-building logic
// moved here.
//
// SECURITY: neither helper ever takes or logs an arg VALUE, an upstream
// response body, an upstream error cause, code text, or a credential — see
// schema.ts's header hard list. `emit` MUST NEVER throw into the caller (an
// audit failure must never break or delay the call it's recording) — both
// helpers swallow internally, mirroring the original inline try/catch.

import { argKeys, hashArgs } from "./redact.js"
import type { AuditPrincipal, AuditTarget } from "./schema.js"
import type { AuditSink } from "./sink.js"

/** Inputs to build + emit one `tool_call` audit line. */
export interface EmitToolCallInput {
  sink: AuditSink
  principal: AuditPrincipal
  /** Pre-built by the caller — providers.ts derives it via parseWireName; a
   *  future code-mode caller knows profile/namespace/tool directly and can
   *  build it without parsing a wire name at all. */
  target: AuditTarget
  args: Record<string, unknown>
  outcome: "ok" | "error"
  durationMs: number
  /** DISCRIMINATED TAG ONLY (e.g. UpstreamError["kind"]) — null when outcome is "ok". */
  errorKind: string | null
  /** Fresh crypto.randomUUID() per call — the caller generates it (not this
   *  helper) so it can be captured before the call starts (duration timing)
   *  and, for code-mode, so an inner tool_call can be tagged with the SAME
   *  id as its wrapping code_exec (see emitCodeExec). */
  correlationId: string
}

/**
 * Build + emit a `tool_call` AuditEntry. Pure aside from the `sink.emit`
 * side effect; never throws into the caller.
 */
export function emitToolCall(input: EmitToolCallInput): void {
  try {
    input.sink.emit({
      v: 1,
      ts: new Date().toISOString(),
      event: "tool_call",
      correlationId: input.correlationId,
      principal: input.principal,
      target: input.target,
      argKeys: argKeys(input.args),
      argHash: hashArgs(input.args),
      durationMs: input.durationMs,
      outcome: input.outcome,
      errorKind: input.errorKind,
    })
  } catch {
    // Audit failure must NEVER break or delay the tool call.
  }
}

/** Inputs to build + emit one `code_exec` audit line. */
export interface EmitCodeExecInput {
  sink: AuditSink
  /**
   * The SAME correlationId used for the inner tool_call lines this execution
   * triggered — NOT a fresh one — so a reader can join a code_exec line to
   * the tool_call lines it wraps (proof-of-done #4, increment 33).
   */
  correlationId: string
  principal: AuditPrincipal
  /** The routed profile the code executed against — no namespace/tool (a
   *  code_exec doesn't call one upstream tool; see schema.ts's header). */
  profile: string
  durationMs: number
  outcome: "ok" | "error"
  /** DISCRIMINATED TAG ONLY — null when outcome is "ok". */
  errorKind: string | null
  /** How many inner tool_call lines this execution triggered. */
  toolCallCount: number
}

/**
 * Build + emit a `code_exec` AuditEntry. Pure aside from the `sink.emit`
 * side effect; never throws into the caller. NO code text / arg value ever
 * crosses this boundary — see schema.ts's header hard list.
 */
export function emitCodeExec(input: EmitCodeExecInput): void {
  try {
    input.sink.emit({
      v: 1,
      ts: new Date().toISOString(),
      event: "code_exec",
      correlationId: input.correlationId,
      principal: input.principal,
      profile: input.profile,
      durationMs: input.durationMs,
      outcome: input.outcome,
      errorKind: input.errorKind,
      toolCallCount: input.toolCallCount,
    })
  } catch {
    // Audit failure must NEVER break or delay the execution.
  }
}
