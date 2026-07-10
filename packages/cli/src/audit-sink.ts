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
  /**
   * Async flush — safe to call from a normal shutdown path. Returns a
   * Promise that resolves once the pending writes are actually durable on
   * disk (best-effort — a flush failure resolves rather than rejects, see
   * the body's comment), so a SHORT-LIVED process (`junction run`, which
   * exits right after formatting output — unlike serve/mcp serve, which
   * stay alive well past flush()) can await it before its own last output
   * write, rather than racing an unresolved write against process exit.
   * Existing callers (serve.ts/mcp.ts) that don't await it are unaffected —
   * a non-awaited Promise-returning call is still valid.
   */
  flush(): Promise<void>
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
    flush(): Promise<void> {
      return new Promise((resolve) => {
        // IMPORTANT: sonic-boom's flush(cb) is NOT what its name suggests —
        // in the default (unbatched, minLength<=0) mode it invokes `cb`
        // IMMEDIATELY/synchronously without performing (or waiting for) any
        // write at all (see sonic-boom's flush(): `if (this.minLength <= 0)
        // { cb?.(); return }`). Empirically confirmed (8/8 repro): calling
        // it right after emit() reliably produces a 0-byte file. The
        // primitive that actually guarantees durability is flushSync() (a
        // real fs.writeSync + fsyncSync) — but it throws "sonic boom is not
        // ready yet" until the destination's ASYNC file open lands. sonic-
        // boom's public .d.ts doesn't expose the internal `fd` field to
        // check readiness up front, so: try flushSync() directly (the
        // common case — the file has usually opened by the time execute()
        // finishes); on the "not ready" throw, fall back to the one-time
        // 'ready' event, then retry.
        try {
          dest.flushSync()
          resolve()
        } catch {
          dest.once("ready", () => {
            try {
              dest.flushSync()
            } catch {
              // best-effort — swallow (mirrors flushSync()'s own catch below).
            }
            resolve()
          })
        }
      })
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
