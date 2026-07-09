// SPDX-License-Identifier: AGPL-3.0-only
// `junction audit` — read/filter the append-only tool-call audit log
// (increment 31, Slice C). The log itself is written by the Slice B pino
// sink hooked into `adaptToMcpHandlers`; this command is a PURE READER.
//
// The audit log contains NO secrets (Slice A's AuditEntry shape guarantees
// that — arg keys + a correlation hash only, never values, never a
// credential, never an upstream response/cause). This command does no
// redaction of its own; it just parses, filters, and prints what's there.
//
// The reader/filter logic itself (readAuditLog/filterAuditEntries/
// parseSinceUtc/AuditFilters) was extracted to @junction/core (increment
// 32.6b) so the web /audit page — a sibling app that cannot import cli — can
// share it. This file keeps only the human formatter + arg parsing/citty
// wiring; behavior is byte-identical to before the extract.

import { type AuditEntry, filterAuditEntries, getPaths, readAuditLog } from "@junction/core"
import { defineCommand } from "citty"
import { JSON_ARG } from "../args.js"
import { reportError } from "../format.js"

/** Default tail size when `-n/--limit` is not supplied. */
const DEFAULT_LIMIT = 50

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
