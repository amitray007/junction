// SPDX-License-Identifier: AGPL-3.0-only
// Server-only audit-log reader — the ONLY file in @junction/web that reaches the
// core audit reader (increment 32.6b). Called exclusively from
// audit.functions.ts's createServerFn handler, never imported by a route.
//
// SECURITY: AuditEntry is metadata-only by the inc-31 contract (no arg values,
// no secret, no credential, no upstream response/cause — see core/src/audit/
// schema.ts's header). This file maps it to an equally metadata-only DTO —
// never returns the raw core AuditEntry type (the web convention: routes never
// see a core type directly).
//
// BOUNDED READ: the log is append-only and can grow unbounded over a long-lived
// `serve` (rotation deferred — see docs/futures/revisit-when.md). readAuditLogTail
// caps the read at AUDIT_TAIL_CAP bytes so this loader never slurps an
// arbitrarily large file into memory.

import {
  type AuditEntry,
  type AuditFilters,
  filterAuditEntries,
  getPaths,
  readAuditLogTail,
} from "@junction/core"

/** Bound the web read — rotation/retention stays deferred (see docs/futures/). */
const AUDIT_TAIL_CAP = 2 * 1024 * 1024

export interface AuditEntryDTO {
  ts: string
  principalKind: "api-key" | "stdio"
  keyId: string | null
  label: string | null
  profile: string
  namespace: string
  tool: string
  argKeys: string[]
  durationMs: number
  outcome: "ok" | "error"
  errorKind: string | null
}

export interface AuditReadResult {
  entries: AuditEntryDTO[]
  skipped: number
  truncated: boolean
  total: number
}

function toDto(e: AuditEntry): AuditEntryDTO {
  return {
    ts: e.ts,
    principalKind: e.principal.kind,
    keyId: e.principal.keyId,
    label: e.principal.label,
    profile: e.target.profile,
    namespace: e.target.namespace,
    tool: e.target.tool,
    argKeys: e.argKeys,
    durationMs: e.durationMs,
    outcome: e.outcome,
    errorKind: e.errorKind,
  }
}

export async function readAudit(filters: AuditFilters): Promise<AuditReadResult> {
  const { entries, skipped, truncated } = await readAuditLogTail(
    getPaths().auditLogFile,
    AUDIT_TAIL_CAP,
  )
  const { filtered } = filterAuditEntries(entries, filters)
  return { entries: filtered.map(toDto), skipped, truncated, total: entries.length }
}
