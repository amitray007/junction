// SPDX-License-Identifier: AGPL-3.0-only
// `junction audit` — read/filter the append-only tool-call audit log
// (increment 31, Slice C). The log itself is written by the Slice B pino
// sink hooked into `adaptToMcpHandlers`; this command is a PURE READER.
//
// The audit log contains NO secrets (Slice A's AuditEntry shape guarantees
// that — arg keys + a correlation hash only, never values, never a
// credential, never an upstream response/cause). This command does no
// redaction of its own; it just parses, filters, and prints what's there.

import { readFile } from "node:fs/promises"
import { type AuditEntry, AuditEntrySchema, getPaths } from "@junction/core"
import { defineCommand } from "citty"
import { JSON_ARG } from "../args.js"
import { reportError } from "../format.js"

/** Default tail size when `-n/--limit` is not supplied. */
const DEFAULT_LIMIT = 50

/**
 * Read + parse the JSONL audit log at `auditLogFile`. Never throws for a
 * missing file (honest "no entries yet" case) or a malformed line (skipped,
 * counted, never fatal — the log is an append-only stream other processes
 * may be writing to concurrently; one bad line must not break reads of
 * every other line).
 */
async function readAuditLog(filePath: string): Promise<{ entries: AuditEntry[]; skipped: number }> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") return { entries: [], skipped: 0 }
    throw e
  }

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
 * Parse a `--since` value as ISO-8601, always in UTC. A bare date
 * (`2026-07-07`, no time component) is JS-native UTC-midnight — never local
 * time (the entry `ts` field is emitted in UTC by pino, so the comparison
 * must be apples-to-apples). Returns null if unparseable.
 */
function parseSinceUtc(since: string): number | null {
  const ms = Date.parse(since)
  return Number.isNaN(ms) ? null : ms
}

export type AuditFilters = {
  profile?: string
  key?: string
  tool?: string
  since?: string
  limit: number
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
    if (filters.profile !== undefined) {
      const matchesTarget = e.target.profile === filters.profile
      const matchesPrincipal = e.principal.profiles.includes(filters.profile)
      if (!matchesTarget && !matchesPrincipal) return false
    }
    if (filters.key !== undefined && e.principal.keyId !== filters.key) return false
    if (filters.tool !== undefined && e.target.tool !== filters.tool) return false
    if (sinceMs !== null) {
      const entryMs = Date.parse(e.ts)
      if (Number.isNaN(entryMs) || entryMs < sinceMs) return false
    }
    return true
  })

  const tail = filters.limit > 0 ? filtered.slice(-filters.limit) : filtered
  return { filtered: tail, sinceError: false }
}

function formatHuman(entries: AuditEntry[], skipped: number): string {
  const lines: string[] = []
  if (entries.length === 0) {
    lines.push("No audit entries yet.")
  } else {
    lines.push(
      "  ts                    principal            profile         namespace__tool                  outcome  duration",
    )
    lines.push(
      "  ---------------------  -------------------  --------------  -------------------------------  -------  --------",
    )
    for (const e of entries) {
      const who =
        e.principal.kind === "api-key"
          ? `key:${e.principal.keyId ?? "?"}`
          : `stdio:${e.target.profile}`
      const target = `${e.target.namespace}__${e.target.tool}`
      const outcome = e.outcome === "error" ? `error(${e.errorKind ?? "?"})` : "ok"
      lines.push(
        `  ${e.ts.padEnd(21)}  ${who.padEnd(19)}  ${e.target.profile.padEnd(14)}  ${target.padEnd(33)}  ${outcome.padEnd(7)}  ${e.durationMs}ms`,
      )
    }
  }
  if (skipped > 0) {
    lines.push(`(skipped ${skipped} malformed line${skipped !== 1 ? "s" : ""})`)
  }
  return lines.join("\n")
}

export const auditCommand = defineCommand({
  meta: {
    name: "audit",
    description: "Read junction's tool-call audit log (metadata only — never secrets).",
  },
  args: {
    profile: {
      type: "string",
      description: "Filter to a profile (matches the routed profile or a key's scoped profiles)",
    },
    key: {
      type: "string",
      description: "Filter to a principal keyId",
    },
    tool: {
      type: "string",
      description: "Filter to a tool name",
    },
    since: {
      type: "string",
      description: "Only entries at/after this ISO-8601 timestamp (compared in UTC)",
    },
    limit: {
      type: "string",
      alias: "n",
      description: `Max entries to show, taken from the tail of the filtered set (default ${DEFAULT_LIMIT})`,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false

    let limit = DEFAULT_LIMIT
    if (args.limit !== undefined) {
      const parsedLimit = Number.parseInt(args.limit, 10)
      if (Number.isNaN(parsedLimit) || parsedLimit < 0) {
        reportError(json, `invalid --limit "${args.limit}" — must be a non-negative integer`)
        return
      }
      limit = parsedLimit
    }

    const paths = getPaths()
    const { entries, skipped } = await readAuditLog(paths.auditLogFile)

    const { filtered, sinceError } = filterAuditEntries(entries, {
      profile: args.profile,
      key: args.key,
      tool: args.tool,
      since: args.since,
      limit,
    })

    if (sinceError) {
      reportError(json, `invalid --since "${args.since}" — must be an ISO-8601 timestamp`)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify(filtered)}\n`)
      return
    }

    process.stdout.write(`${formatHuman(filtered, skipped)}\n`)
  },
})
