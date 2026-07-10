// SPDX-License-Identifier: AGPL-3.0-only
// AuditEntry — the structured, append-only audit log line (increment 31 §3;
// extended to a discriminated union on `event` at increment 33 Slice A).
//
// NEVER LOGGED (hard list — enforced by the shape, not just convention):
//   - the credential plaintext / ResolvedSecret (never reaches this seam)
//   - the raw junction API key/token (only `principal.keyId`, a public id)
//   - the upstream RESPONSE body (may echo secrets/PII)
//   - the upstream ERROR cause/message (only the discriminated `errorKind` tag)
//   - the arg VALUES (only sorted `argKeys` + a correlation hash — see redact.ts)
//   - for `code_exec` (increment 33): the guest CODE TEXT, any arg value from
//     any inner tool call, and no `tool`/`target` field at all (a code_exec
//     entry is a WRAPPER around N inner tool_call lines, joined only by
//     `correlationId` — see emit.ts)
//
// `event` is a discriminated union: "tool_call" (one brokered tool
// invocation) and "code_exec" (one code-mode execution wrapping zero or more
// tool_call lines). listTools/tools-list enumeration auditing is out of scope
// (see docs/futures/revisit-when.md).

import { z } from "zod"

/** WHO made the call — an api-key (HTTP) or the served profile (stdio). */
export const AuditPrincipalSchema = z.object({
  kind: z.enum(["api-key", "stdio"]),
  /** ResolvedKey.keyId — the PUBLIC id segment, never the secret. null for stdio. */
  keyId: z.string().nullable(),
  /** User-facing key label (non-secret). null for stdio. */
  label: z.string().nullable(),
  /**
   * The key's full resolved scope (authority) — for a global key, the whole
   * fleet. Distinct from `target.profile`, the one profile THIS call routed
   * to. For stdio (single-profile passthrough) they coincide.
   */
  profiles: z.array(z.string()),
})
export type AuditPrincipal = z.infer<typeof AuditPrincipalSchema>

/** WHAT was called — the routed profile + the split namespaced tool name. */
export const AuditTargetSchema = z.object({
  /** The ROUTED profile (from the prefixed-name parse), not the key's full scope. */
  profile: z.string(),
  /** Source toolNamespace (from the split name). */
  namespace: z.string(),
  /** Raw upstream tool name (from the split name). */
  tool: z.string(),
})
export type AuditTarget = z.infer<typeof AuditTargetSchema>

/**
 * One structured JSONL audit line for a single `tool_call`.
 *
 * `v: 1` is a version field so a future shape change can branch on it.
 * `outcome`/`errorKind` are DISCRIMINATED TAGS ONLY — never a cause, message,
 * or response body (see the hard list above).
 *
 * BYTE-IDENTICAL to the pre-33 shape (a shape drift here would break every
 * previously-written JSONL line's validation) — only the containing union
 * changed, not this member.
 */
export const ToolCallEntrySchema = z.object({
  v: z.literal(1),
  /** ISO string (pino emits UTC). */
  ts: z.string(),
  event: z.literal("tool_call"),
  /** Fresh crypto.randomUUID() per call — generated inside callTool, never per-sink/session. */
  correlationId: z.string(),
  principal: AuditPrincipalSchema,
  target: AuditTargetSchema,
  /** Sorted arg key names — NEVER values. */
  argKeys: z.array(z.string()),
  /** SHA-256 hex of a stable serialization of the args — correlation, not confidentiality. */
  argHash: z.string(),
  durationMs: z.number(),
  outcome: z.enum(["ok", "error"]),
  /** DISCRIMINATED TAG ONLY (UpstreamError["kind"]) — null when outcome is "ok". */
  errorKind: z.string().nullable(),
})
export type ToolCallEntry = z.infer<typeof ToolCallEntrySchema>

/**
 * One structured JSONL audit line for a single `code_exec` (increment 33) —
 * a WRAPPER entry emitted once per code-mode execution, tying together the
 * `toolCallCount` inner `tool_call` lines it triggered via the SAME
 * `correlationId` (never a new one — see emit.ts's `emitCodeExec`).
 *
 * Deliberately has NO `target`/`tool` field (a code_exec doesn't call one
 * upstream tool — it may call zero, one, or many) and NO code text / arg
 * value of any kind — see the hard list above.
 */
export const CodeExecEntrySchema = z.object({
  v: z.literal(1),
  /** ISO string (pino emits UTC). */
  ts: z.string(),
  event: z.literal("code_exec"),
  /**
   * Fresh crypto.randomUUID() per execution. Inner tool_call lines emitted
   * DURING this execution reuse this SAME id (not their own) so a reader can
   * join a code_exec line to the tool_call lines it triggered.
   */
  correlationId: z.string(),
  principal: AuditPrincipalSchema,
  /** The routed profile the code executed against (no namespace/tool — see above). */
  profile: z.string(),
  durationMs: z.number(),
  outcome: z.enum(["ok", "error"]),
  /** DISCRIMINATED TAG ONLY — null when outcome is "ok". */
  errorKind: z.string().nullable(),
  /** How many inner tool_call lines this execution triggered (0 = no tool calls made). */
  toolCallCount: z.number(),
})
export type CodeExecEntry = z.infer<typeof CodeExecEntrySchema>

/**
 * The full audit-line union — discriminated on `event`. A reader that only
 * understands `tool_call` (pre-33 code) still validates every `tool_call`
 * line byte-for-byte identically; `code_exec` is strictly additive.
 */
export const AuditEntrySchema = z.discriminatedUnion("event", [
  ToolCallEntrySchema,
  CodeExecEntrySchema,
])
export type AuditEntry = z.infer<typeof AuditEntrySchema>
