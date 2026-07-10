// SPDX-License-Identifier: AGPL-3.0-only
// Audit-log READER — parse + filter the append-only JSONL audit log (inc 31 wrote it; inc 32.6b
// reads it). Shared by the CLI (`junction audit`) and the web /audit page (which can't import cli).
// NEVER emits a secret — AuditEntry is metadata-only by the inc-31 contract.
//
// EVENT-AWARE FILTERING (increment 33 Slice A): `AuditEntry` is a discriminated
// union (`tool_call` | `code_exec`). A `code_exec` entry has no `target`/`tool`
// field, so `--tool` cannot match it — it is EXEMPT from a `--tool` filter
// (never matches, never excluded-by-absence-of-tool — it simply isn't a tool
// call). `--profile` still matches it via its own `profile` field.

import { open, readFile } from "node:fs/promises"
import { type AuditEntry, AuditEntrySchema } from "./schema.js"

export interface AuditFilters {
  profile?: string
  key?: string
  tool?: string
  since?: string
  limit: number
}

/** Parse a JSONL blob (already read into memory) into entries, counting malformed lines. */
function parseAuditLines(raw: string): { entries: AuditEntry[]; skipped: number } {
  const entries: AuditEntry[] = []
  let skipped = 0
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(trimmed)
    } catch {
      skipped++
      continue
    }
    const result = AuditEntrySchema.safeParse(parsedJson)
    if (!result.success) {
      skipped++
      continue
    }
    entries.push(result.data)
  }
  return { entries, skipped }
}

/**
 * Read + parse the JSONL audit log at `filePath`. Never throws for a
 * missing file (honest "no entries yet" case) or a malformed line (skipped,
 * counted, never fatal — the log is an append-only stream other processes
 * may be writing to concurrently; one bad line must not break reads of
 * every other line).
 */
export async function readAuditLog(
  filePath: string,
): Promise<{ entries: AuditEntry[]; skipped: number }> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") return { entries: [], skipped: 0 }
    throw e
  }

  return parseAuditLines(raw)
}

/**
 * Parse a `--since` value as ISO-8601, always in UTC. A bare date
 * (`2026-07-07`, no time component) is JS-native UTC-midnight — never local
 * time (the entry `ts` field is emitted in UTC by pino, so the comparison
 * must be apples-to-apples). Returns null if unparseable.
 */
export function parseSinceUtc(since: string): number | null {
  const ms = Date.parse(since)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Apply --profile/--key/--tool/--since filters, then take the LAST `limit`
 * entries (a tail of the filtered set, not the unfiltered log).
 */
export function filterAuditEntries(
  entries: AuditEntry[],
  filters: AuditFilters,
): { filtered: AuditEntry[]; sinceError: boolean } {
  let sinceMs: number | null = null
  if (filters.since !== undefined) {
    sinceMs = parseSinceUtc(filters.since)
    if (sinceMs === null) return { filtered: [], sinceError: true }
  }

  const filtered = entries.filter((e) => {
    const entryProfile = e.event === "tool_call" ? e.target.profile : e.profile
    if (filters.profile !== undefined) {
      const matchesTarget = entryProfile === filters.profile
      const matchesPrincipal = e.principal.profiles.includes(filters.profile)
      if (!matchesTarget && !matchesPrincipal) return false
    }
    if (filters.key !== undefined && e.principal.keyId !== filters.key) return false
    // code_exec has no `target`/`tool` field — exempt from --tool (never matches).
    if (filters.tool !== undefined) {
      if (e.event !== "tool_call") return false
      if (e.target.tool !== filters.tool) return false
    }
    if (sinceMs !== null) {
      const entryMs = Date.parse(e.ts)
      if (Number.isNaN(entryMs) || entryMs < sinceMs) return false
    }
    return true
  })

  const tail = filters.limit > 0 ? filtered.slice(-filters.limit) : filtered
  return { filtered: tail, sinceError: false }
}

/** True iff the single byte immediately before `offset` in `fileHandle` is `\n`. */
async function isPrecedingByteNewline(
  fileHandle: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<boolean> {
  const singleByte = Buffer.alloc(1)
  await fileHandle.read(singleByte, 0, 1, offset - 1)
  return singleByte[0] === 0x0a
}

/**
 * Bounded tail-read for the web loader: read at most the last `maxBytes` of
 * the log, then parse. Keeps the web page's read bounded on a large log —
 * size-based rotation now runs at serve/mcp-serve startup (increment 32.8,
 * see audit/rotate.ts), but readers stay on the CURRENT file only by design
 * (rotated `.1..keep` generations are on-disk history, not queried here), so
 * this cap still matters for a long-lived session between rotations.
 *
 * - Whole file ≤ `maxBytes` → equivalent to `readAuditLog` (nothing dropped,
 *   `truncated: false`).
 * - Oversized file → reads exactly the last `maxBytes` bytes via a positioned
 *   fd read (never slurps the whole file into memory), then drops the
 *   partial first line (everything up to and including the first `\n` in the
 *   read window — that line was cut mid-record by the byte boundary and would
 *   otherwise parse as garbage or a misleadingly-truncated record).
 * - If the byte boundary happens to land exactly on a `\n`, there is no
 *   partial line to drop — the slice-off must not eat a whole valid line in
 *   that case.
 */
export async function readAuditLogTail(
  filePath: string,
  maxBytes: number,
): Promise<{ entries: AuditEntry[]; skipped: number; truncated: boolean }> {
  let fileHandle: Awaited<ReturnType<typeof open>>
  try {
    fileHandle = await open(filePath, "r")
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") return { entries: [], skipped: 0, truncated: false }
    throw e
  }

  try {
    const stats = await fileHandle.stat()
    if (stats.size <= maxBytes) {
      const raw = await fileHandle.readFile("utf8")
      const { entries, skipped } = parseAuditLines(raw)
      return { entries, skipped, truncated: false }
    }

    const start = stats.size - maxBytes
    const buffer = Buffer.alloc(maxBytes)
    await fileHandle.read(buffer, 0, maxBytes, start)
    let raw = buffer.toString("utf8")

    // Was the byte immediately BEFORE the window's start a newline (or is the
    // window the whole file)? If so, the cut landed exactly on a line
    // boundary and the window's first line is already whole — nothing to
    // drop. Otherwise the window's first line was cut mid-record by the byte
    // boundary and must be dropped (up to and including its first `\n`).
    const cleanBoundary = start === 0 || (await isPrecedingByteNewline(fileHandle, start))
    if (!cleanBoundary) {
      const firstNewline = raw.indexOf("\n")
      if (firstNewline !== -1) {
        raw = raw.slice(firstNewline + 1)
      } else {
        // No newline at all in the window (maxBytes smaller than one line) —
        // the whole window is a partial line; nothing usable remains.
        raw = ""
      }
    }

    const { entries, skipped } = parseAuditLines(raw)
    return { entries, skipped, truncated: true }
  } finally {
    await fileHandle.close()
  }
}
