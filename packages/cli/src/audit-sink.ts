// SPDX-License-Identifier: AGPL-3.0-only
// createFileAuditSink — the pino-backed AuditSink impl (increment 31 Slice B).
//
// Lives in cli (the composition root), not core: core owns the AuditSink
// SHAPE (packages/core/src/audit/sink.ts) and stays pino-free; the concrete
// pino-backed writer is injected here, mirroring how resolveProvider is
// built in cli and injected into the proxy.
//
// pino.destination({ sync:false }) — NOT pino.transport — is deliberate: a
// worker-thread transport can be torn down before its buffered log flushes
// on a short-lived process (mcp serve stdio, a CLI that exits right after a
// call), silently dropping the LAST audit line (often the most interesting).
// `sync:false` buffers in the MAIN thread (SonicBoom) instead, flushed on the
// event loop; `flush()`/`flushSync()` below give callers an explicit hook for
// the clean-shutdown paths (serve.ts / mcp.ts wire these — see docs/methods/
// 31-audit.md §0 decision 4). `flushSync` must ONLY be called from an
// exit/signal handler, never on the hot call path (no fs.*Sync in server
// paths).

import type { AuditEntry, AuditSink, JunctionPaths } from "@junction/core"
import pino from "pino"

/** A file-backed AuditSink plus the explicit flush hooks its callers need at shutdown. */
export interface FileAuditSink extends AuditSink {
  /** Async flush — safe to call from a normal shutdown path. */
  flush(): void
  /** Synchronous flush — ONLY from an exit/signal handler (never the hot path). */
  flushSync(): void
}

/**
 * Open (or create, `mkdir: true`) `paths.auditLogFile` and return an
 * AuditSink whose `emit` appends one JSONL line per entry via pino.
 *
 * `emit` never throws into the caller — a broken sink must never break or
 * delay the tool call it is recording.
 */
export function createFileAuditSink(paths: JunctionPaths): FileAuditSink {
  const dest = pino.destination({ dest: paths.auditLogFile, sync: false, mkdir: true })
  const logger = pino(dest)

  return {
    emit(entry: AuditEntry): void {
      try {
        logger.info(entry)
      } catch {
        // Swallow — an audit failure must never break or slow the tool call.
      }
    },
    flush(): void {
      dest.flush()
    },
    flushSync(): void {
      dest.flushSync()
    },
  }
}
