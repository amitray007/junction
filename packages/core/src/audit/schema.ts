// SPDX-License-Identifier: AGPL-3.0-only
// AuditEntry — the structured, append-only tool-call log line (increment 31 §3).
//
// NEVER LOGGED (hard list — enforced by the shape, not just convention):
//   - the credential plaintext / ResolvedSecret (never reaches this seam)
//   - the raw junction API key/token (only `principal.keyId`, a public id)
//   - the upstream RESPONSE body (may echo secrets/PII)
//   - the upstream ERROR cause/message (only the discriminated `errorKind` tag)
//   - the arg VALUES (only sorted `argKeys` + a correlation hash — see redact.ts)
//
// `event` is the literal "tool_call" — listTools/tools-list enumeration auditing
// is out of scope this increment (see docs/futures/revisit-when.md).

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
 */
export const AuditEntrySchema = z.object({
  v: z.literal(1),
  /** ISO string (pino emits UTC). */
  ts: z.string(),
  event: z.literal("tool_call"),
  /** Fresh ulid per call — generated inside callTool, never per-sink/session. */
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
export type AuditEntry = z.infer<typeof AuditEntrySchema>
