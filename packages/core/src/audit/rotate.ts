// SPDX-License-Identifier: AGPL-3.0-only
// Audit-log rotation (increment 32.8) — size-based rotation invoked at
// serve/mcp-serve STARTUP, before the process's own audit sink opens its fd.
//
// (a) ROTATE-BEFORE-OPEN DESIGN. This is the entire safety design, not an
// optimization: this module is called BY THE CALLER before
// `createFileAuditSink(paths)` constructs its pino/SonicBoom destination.
// Renaming `audit.log` while THIS process holds it open would leave the sink
// writing into the renamed (now `.1`) inode forever, silently orphaning the
// process's own audit stream. Never call this after this process's sink has
// opened; there is no "reopen the sink" dance here or anywhere else (the
// call-site rule in serve.ts/mcp.ts is what keeps this true — this module
// cannot enforce it itself, since it never touches the sink).
//
// (b) READERS STAY ON THE CURRENT FILE ONLY. `junction audit` and the web
// `/audit` page (readAuditLog / readAuditLogTail) read `audit.log` alone —
// they do NOT walk `.1..keep`. Immediately after a rotation, `junction audit`
// honestly reports "no entries yet" while the prior history sits in `.1`.
// This is a deliberate simplicity trade-off (see method file 32.8, Do NOT
// list) — the rotated generations are on-disk history for manual inspection,
// not a queryable tail.
//
// (c) A CONCURRENTLY RUNNING SERVER (a second `junction serve` / `mcp serve`
// process, or an OLDER invocation of this same command that hasn't restarted)
// keeps its sink's fd open across a rotation performed by a DIFFERENT
// process. That fd points at the renamed inode (now `.1`, or further along
// the chain after repeated rotations) — its writes are not corrupted, they
// just keep landing in that generation until the process restarts and
// re-opens `audit.log` fresh. Across REPEATED rotations, that open generation
// can eventually be shifted past `keep` and unlinked while still open — the
// fd stays valid (POSIX unlink-while-open semantics) and the OS reclaims the
// space once the process closes it or exits; the lines already written are
// not corrupted, merely unreachable by path. This is accepted for a
// single-user tool: the fix is restarting the stale process, not adding
// rotation-awareness to the sink.
//
// (d) TWO PROCESSES ROTATING SIMULTANEOUSLY interleave harmlessly. Every step
// here is a single atomic `rename` that either wins outright or ENOENTs (the
// source was already moved by the other process) — never a partial/torn
// write. Worst case under a race, the oldest generation is deleted one
// rotation early. That's why there is no lockfile: the cost of the rare
// double-rotation race (one file's history is one generation shorter) is
// lower than the cost/complexity of a cross-process lock for a single-user
// tool's startup-time housekeeping.

import { rename, stat, unlink } from "node:fs/promises"

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_KEEP = 5

export type RotateOutcome =
  | { kind: "rotated" }
  | { kind: "skipped" }
  | { kind: "failed"; code: string }

/**
 * Rotate `auditLogFile` if it is at or above `maxBytes`: shift
 * `audit.log.1 → .2 … .(keep-1) → .keep`, rename `audit.log → audit.log.1`,
 * and unlink anything beyond `.keep`. Returns a discriminated outcome —
 * this function NEVER logs (the caller warns on `"failed"` in its own idiom;
 * see serve.ts / mcp.ts) and NEVER throws (a rotation failure must not block
 * serve startup).
 *
 * Every rename PRESERVES the source file's mode (0o600) — this module never
 * creates a file itself; the fresh `audit.log` after a `"rotated"` outcome is
 * created by the sink's own `pino.destination({ mode: 0o600 })` (see
 * audit-sink.ts), not here.
 *
 * MUST be called before the calling process's own audit sink opens its fd —
 * see design note (a) above. Async `node:fs/promises` only.
 */
export async function rotateAuditLogIfOversized(
  auditLogFile: string,
  opts?: { maxBytes?: number; keep?: number },
): Promise<RotateOutcome> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = opts?.keep ?? DEFAULT_KEEP

  try {
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(auditLogFile)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === "ENOENT") return { kind: "skipped" }
      throw e
    }

    if (st.size < maxBytes) return { kind: "skipped" }

    // Shift existing generations up: .{keep-1} -> .keep, ..., .1 -> .2.
    // Walk from the OLDEST surviving generation down to .1 so no in-progress
    // rename ever clobbers a generation not yet shifted out of the way.
    for (let n = keep - 1; n >= 1; n--) {
      const from = `${auditLogFile}.${n}`
      const to = `${auditLogFile}.${n + 1}`
      try {
        await rename(from, to)
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code !== "ENOENT") throw e // ignore ENOENT — that generation simply doesn't exist yet
      }
    }

    // Anything shifted beyond `.keep` (only possible if a prior run used a
    // larger `keep`) is unlinked rather than left to accumulate unbounded.
    try {
      await unlink(`${auditLogFile}.${keep + 1}`)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== "ENOENT") throw e
    }

    // audit.log -> audit.log.1 — the rotate-before-open moment (design note a).
    await rename(auditLogFile, `${auditLogFile}.1`)

    return { kind: "rotated" }
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    // fs error code only — never a message that could embed path/content details.
    return { kind: "failed", code: err.code ?? "UNKNOWN" }
  }
}
