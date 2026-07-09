// SPDX-License-Identifier: AGPL-3.0-only
// Audit reader/filter tests (increment 32.6b — extracted from the CLI's
// audit.ts so both `junction audit` and the web /audit page share one
// implementation). Covers the round-trip, ENOENT handling, malformed-line
// skipping, every filter, tail-limit slicing, and readAuditLogTail's
// boundary cases (oversized file, exact-newline cut, whole-file-under-cap).

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type AuditFilters,
  filterAuditEntries,
  parseSinceUtc,
  readAuditLog,
  readAuditLogTail,
} from "./read.js"
import type { AuditEntry } from "./schema.js"

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    v: 1,
    ts: "2026-07-01T00:00:00.000Z",
    event: "tool_call",
    correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    principal: { kind: "stdio", keyId: null, label: null, profiles: ["work"] },
    target: { profile: "work", namespace: "github", tool: "search_repos" },
    argKeys: ["query"],
    argHash: "deadbeef",
    durationMs: 12,
    outcome: "ok",
    errorKind: null,
    ...overrides,
  }
}

function baseFilters(overrides: Partial<AuditFilters> = {}): AuditFilters {
  return { limit: 0, ...overrides }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "junction-audit-read-test-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeLog(lines: Array<AuditEntry | string>): Promise<string> {
  const filePath = path.join(tmpDir, "audit.log")
  const content = `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`
  await writeFile(filePath, content, "utf8")
  return filePath
}

describe("readAuditLog", () => {
  it("round-trips a JSONL fixture", async () => {
    const e1 = makeEntry({ correlationId: "id-1" })
    const e2 = makeEntry({ correlationId: "id-2", ts: "2026-07-02T00:00:00.000Z" })
    const filePath = await writeLog([e1, e2])

    const { entries, skipped } = await readAuditLog(filePath)
    expect(skipped).toBe(0)
    expect(entries).toEqual([e1, e2])
  })

  it("ENOENT (missing file) returns an empty, honest result", async () => {
    const filePath = path.join(tmpDir, "does-not-exist.log")
    const { entries, skipped } = await readAuditLog(filePath)
    expect(entries).toEqual([])
    expect(skipped).toBe(0)
  })

  it("a malformed line is skipped, counted, and doesn't break other lines", async () => {
    const good1 = makeEntry({ correlationId: "good-1" })
    const good2 = makeEntry({ correlationId: "good-2" })
    const filePath = await writeLog([good1, "{not valid json", "{}", good2])

    const { entries, skipped } = await readAuditLog(filePath)
    // "{not valid json" fails JSON.parse; "{}" parses but fails schema — both count.
    expect(skipped).toBe(2)
    expect(entries).toEqual([good1, good2])
  })
})

describe("parseSinceUtc", () => {
  it("parses a full ISO-8601 timestamp", () => {
    expect(parseSinceUtc("2026-07-07T00:00:00.000Z")).toBe(Date.parse("2026-07-07T00:00:00.000Z"))
  })

  it("parses a bare date as UTC midnight", () => {
    expect(parseSinceUtc("2026-07-07")).toBe(Date.parse("2026-07-07"))
  })

  it("returns null for an unparseable value", () => {
    expect(parseSinceUtc("not-a-date")).toBeNull()
  })
})

describe("filterAuditEntries", () => {
  const entries: AuditEntry[] = [
    makeEntry({
      correlationId: "a",
      ts: "2026-07-01T00:00:00.000Z",
      principal: { kind: "api-key", keyId: "key-a", label: "A", profiles: ["work"] },
      target: { profile: "work", namespace: "github", tool: "search_repos" },
    }),
    makeEntry({
      correlationId: "b",
      ts: "2026-07-02T00:00:00.000Z",
      principal: { kind: "api-key", keyId: "key-b", label: "B", profiles: ["personal", "work"] },
      target: { profile: "personal", namespace: "slack", tool: "send_message" },
    }),
    makeEntry({
      correlationId: "c",
      ts: "2026-07-03T00:00:00.000Z",
      principal: { kind: "stdio", keyId: null, label: null, profiles: ["ops"] },
      target: { profile: "ops", namespace: "github", tool: "list_issues" },
    }),
  ]

  it("filters by profile — matches target.profile OR principal.profiles membership", () => {
    // "work" matches entry a (target.profile) AND entry b (principal.profiles includes it).
    const { filtered, sinceError } = filterAuditEntries(entries, baseFilters({ profile: "work" }))
    expect(sinceError).toBe(false)
    expect(filtered.map((e) => e.correlationId)).toEqual(["a", "b"])
  })

  it("filters by key (principal.keyId)", () => {
    const { filtered } = filterAuditEntries(entries, baseFilters({ key: "key-b" }))
    expect(filtered.map((e) => e.correlationId)).toEqual(["b"])
  })

  it("filters by tool (target.tool)", () => {
    const { filtered } = filterAuditEntries(entries, baseFilters({ tool: "list_issues" }))
    expect(filtered.map((e) => e.correlationId)).toEqual(["c"])
  })

  it("filters by since (UTC comparison)", () => {
    const { filtered, sinceError } = filterAuditEntries(
      entries,
      baseFilters({ since: "2026-07-02T00:00:00.000Z" }),
    )
    expect(sinceError).toBe(false)
    expect(filtered.map((e) => e.correlationId)).toEqual(["b", "c"])
  })

  it("sinceError is true for an unparseable --since, and filtered is empty", () => {
    const { filtered, sinceError } = filterAuditEntries(entries, baseFilters({ since: "garbage" }))
    expect(sinceError).toBe(true)
    expect(filtered).toEqual([])
  })

  it("limit takes a tail of the FILTERED set (slice(-limit))", () => {
    const { filtered } = filterAuditEntries(entries, baseFilters({ limit: 2 }))
    expect(filtered.map((e) => e.correlationId)).toEqual(["b", "c"])
  })

  it("limit 0 (or unset) means no tail truncation", () => {
    const { filtered } = filterAuditEntries(entries, baseFilters({ limit: 0 }))
    expect(filtered.map((e) => e.correlationId)).toEqual(["a", "b", "c"])
  })
})

describe("readAuditLogTail", () => {
  it("whole file <= cap: truncated:false, nothing dropped", async () => {
    const e1 = makeEntry({ correlationId: "id-1" })
    const e2 = makeEntry({ correlationId: "id-2" })
    const filePath = await writeLog([e1, e2])

    const { entries, skipped, truncated } = await readAuditLogTail(filePath, 1024 * 1024)
    expect(truncated).toBe(false)
    expect(skipped).toBe(0)
    expect(entries).toEqual([e1, e2])
  })

  it("oversized file: reads only the last maxBytes, drops the partial first line, sets truncated:true", async () => {
    // Build many equal-length lines so we can pick a byte cap that lands mid-line.
    const lines = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ correlationId: `line-${String(i).padStart(2, "0")}` }),
    )
    const filePath = await writeLog(lines)
    const fullContent = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`

    // Pick a cap smaller than the full file, deliberately NOT aligned to a
    // newline boundary — this forces the "drop the partial first line" path.
    const maxBytes = Math.floor(fullContent.length * 0.4)
    expect(maxBytes).toBeLessThan(fullContent.length)

    const { entries, skipped, truncated } = await readAuditLogTail(filePath, maxBytes)
    expect(truncated).toBe(true)
    expect(skipped).toBe(0)
    // The last entry must always survive (it's the tail); the read must not
    // include any entry from before the cut, and no entry is malformed/garbage.
    expect(entries.at(-1)?.correlationId).toBe("line-19")
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThan(lines.length)
  })

  it("cut landing exactly on a newline: no spurious partial-line drop", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => makeEntry({ correlationId: `x-${i}` }))
    const filePath = await writeLog(lines)
    const fullContent = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`

    // Find a newline offset inside the file and cap exactly at the bytes
    // remaining from just after that newline to EOF — i.e. maxBytes chosen so
    // `stats.size - maxBytes` lands exactly on a '\n' boundary.
    const firstNewlineIdx = fullContent.indexOf("\n")
    expect(firstNewlineIdx).toBeGreaterThan(-1)
    const cutStart = firstNewlineIdx + 1 // just after the first '\n'
    const maxBytes = fullContent.length - cutStart

    const { entries, truncated } = await readAuditLogTail(filePath, maxBytes)
    expect(truncated).toBe(true)
    // Every line from index 1 onward should be intact — none dropped beyond
    // what the byte window itself excludes (line 0 is outside the window).
    expect(entries.map((e) => e.correlationId)).toEqual(lines.slice(1).map((l) => l.correlationId))
  })
})
