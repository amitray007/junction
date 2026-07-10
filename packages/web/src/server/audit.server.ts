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
// BOUNDED READ: the log is append-only. Size-based rotation now runs at
// serve/mcp-serve startup (increment 32.8, core/src/audit/rotate.ts), but
// this page reads the CURRENT file only — by design, rotated `.1..keep`
// generations are on-disk history, not queried here — so it can still grow
// large between rotations or across a long-lived `serve`. readAuditLogTail
// caps the read at AUDIT_TAIL_CAP bytes so this loader never slurps an
// arbitrarily large file into memory.

import {
  type AuditEntry,
  type AuditFilters,
  filterAuditEntries,
  getPaths,
  readAuditLogTail,
} from "@junction/core"

/** Bound the web read — current-file-only, independent of the startup rotation (32.8). */
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
