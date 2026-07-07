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
  // mode 0o600 (owner-only) matches the credential-file convention
  // (encrypted-file-store.ts, master-key.ts) — audit.log is metadata-only, but
  // it still records profiles/namespaces/tools/keyIds/argKeys/hashes that must
  // not be world-readable on a multi-user host. The 0700 home is NOT a reliable
  // backstop: the serve paths never call ensureHome(), so a serve-first home's
  // dir can be 0755 (getDatabase mkdir has no mode). Set the file mode explicitly
  // (credential-security review, inc 31) — sonic-boom passes `mode` to the open().
  const dest = pino.destination({ dest: paths.auditLogFile, sync: false, mkdir: true, mode: 0o600 })
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
      try {
        dest.flush()
      } catch {
        // best-effort shutdown flush — swallow (e.g. sonic-boom not-ready).
      }
    },
    flushSync(): void {
      try {
        dest.flushSync()
      } catch {
        // flushSync throws "sonic boom is not ready yet" if the async open()
        // hasn't landed (emit → immediate exit). It's a best-effort backstop in
        // an exit/signal handler — a throw here must NOT crash the shutdown path.
      }
    },
  }
}
