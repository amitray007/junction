// SPDX-License-Identifier: AGPL-3.0-only
// Server-only audit-log reader — the ONLY file in @junction/web that reaches the
// core audit reader (increment 32.6b). Called exclusively from
// audit.functions.ts's createServerFn handler, never imported by a route.
//
// SECURITY: AuditEntry is metadata-only by the inc-31 contract (no arg values,
// no secret, no credential, no upstream response/cause, no code text — see
// core/src/audit/schema.ts's header). This file maps it to an equally
// metadata-only DTO — never returns the raw core AuditEntry type (the web
// convention: routes never see a core type directly).
//
// EVENT-AWARE MAPPING (increment 33 Slice A): AuditEntry is a discriminated
// union (`tool_call` | `code_exec`). A `code_exec` entry has no
// `namespace`/`tool`/`argKeys` — the DTO carries an `event` discriminator so
// the route can render each variant correctly instead of reading `.target.*`
// unconditionally (which would break-or-garbage on a tool-less code_exec).
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

interface AuditEntryDTOBase {
  ts: string
  principalKind: "api-key" | "stdio"
  keyId: string | null
  label: string | null
  profile: string
  durationMs: number
  outcome: "ok" | "error"
  errorKind: string | null
}

export interface ToolCallEntryDTO extends AuditEntryDTOBase {
  event: "tool_call"
  namespace: string
  tool: string
  argKeys: string[]
}

export interface CodeExecEntryDTO extends AuditEntryDTOBase {
  event: "code_exec"
  toolCallCount: number
}

export type AuditEntryDTO = ToolCallEntryDTO | CodeExecEntryDTO

export interface AuditReadResult {
  entries: AuditEntryDTO[]
  skipped: number
  truncated: boolean
  total: number
}

function toDto(e: AuditEntry): AuditEntryDTO {
  const base: AuditEntryDTOBase = {
    ts: e.ts,
    principalKind: e.principal.kind,
    keyId: e.principal.keyId,
    label: e.principal.label,
    profile: e.event === "tool_call" ? e.target.profile : e.profile,
    durationMs: e.durationMs,
    outcome: e.outcome,
    errorKind: e.errorKind,
  }
  if (e.event === "tool_call") {
    return {
      ...base,
      event: "tool_call",
      namespace: e.target.namespace,
      tool: e.target.tool,
      argKeys: e.argKeys,
    }
  }
  return {
    ...base,
    event: "code_exec",
    toolCallCount: e.toolCallCount,
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
