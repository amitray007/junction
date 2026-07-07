// SPDX-License-Identifier: AGPL-3.0-only
// AuditSink — the pure interface core exposes for emitting an AuditEntry.
//
// Core owns the SHAPE only. The pino-backed IMPL (increment 31 Slice B) lives
// at the edge (cli, the composition root) so core stays pino-free — mirrors
// how ResolveProviderFn is injected rather than imported.

import type { AuditEntry } from "./schema.js"

/**
 * Fire-and-forget audit emitter.
 *
 * `emit` MUST NEVER throw into the caller and MUST NOT return a Promise the
 * call path awaits — an audit failure must never break or slow the tool call
 * it is recording. A concrete sink is responsible for swallowing its own
 * internal errors (e.g. a full disk) inside `emit`.
 */
export interface AuditSink {
  emit(entry: AuditEntry): void
}

/** Default sink when auditing is off / in tests — discards every entry. */
export const NoopAuditSink: AuditSink = {
  emit(): void {
    // Intentionally does nothing.
  },
}
