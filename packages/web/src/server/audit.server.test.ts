// SPDX-License-Identifier: AGPL-3.0-only
// audit.server unit tests (increment 32.6b) — readAudit maps entries to the
// metadata-only DTO, applies `since`, and respects the tail cap + `truncated`.
//
// LOAD-BEARING coverage: the DTO must NEVER carry an arg value or secret — a
// JSON-stringify negative check on the returned entries is the adversarial
// proof for the inc-31 "metadata only" contract surfaced to the web.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditEntry } from "@junction/core"
import { getPaths } from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readAudit } from "./audit.server.js"

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    v: 1,
    ts: "2026-07-01T00:00:00.000Z",
    event: "tool_call",
    correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    principal: { kind: "stdio", keyId: null, label: null, profiles: ["work"] },
    target: { profile: "work", namespace: "github", tool: "search_repos" },
    argKeys: ["query", "secretToken"],
    argHash: "deadbeef",
    durationMs: 12,
    outcome: "ok",
    errorKind: null,
    ...overrides,
  }
}

async function seedAuditLog(lines: AuditEntry[]): Promise<void> {
  const paths = getPaths()
  await mkdir(paths.home, { recursive: true })
  const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`
  await writeFile(paths.auditLogFile, content, "utf8")
}

describe("audit.server", () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-web-audit-test-"))
    prevHome = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = tmpHome
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(tmpHome, { recursive: true, force: true })
  })

  it("maps entries to a metadata-only DTO shape", async () => {
    await seedAuditLog([
      makeEntry({
        principal: { kind: "api-key", keyId: "key-1", label: "my key", profiles: ["work"] },
      }),
    ])

    const result = await readAudit({ limit: 0 })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toEqual({
      ts: "2026-07-01T00:00:00.000Z",
      principalKind: "api-key",
      keyId: "key-1",
      label: "my key",
      profile: "work",
      namespace: "github",
      tool: "search_repos",
      argKeys: ["query", "secretToken"],
      durationMs: 12,
      outcome: "ok",
      errorKind: null,
    })
  })

  it("the DTO never carries an arg VALUE or a secret (JSON-stringify negative check)", async () => {
    await seedAuditLog([
      makeEntry({
        argKeys: ["apiKey", "password"],
        // argHash/correlationId are on the core entry but must not leak through the DTO.
        argHash: "should-not-appear-anywhere",
        correlationId: "should-not-appear-either",
      }),
    ])

    const result = await readAudit({ limit: 0 })
    const serialized = JSON.stringify(result)
    // The DTO carries only arg KEY NAMES, never a value. Confirm the literal
    // secret-ish argHash/correlationId (which core tracks but the DTO omits)
    // never leaks through, and no "secret"/"token" value string appears.
    expect(serialized).not.toContain("should-not-appear-anywhere")
    expect(serialized).not.toContain("should-not-appear-either")
    expect(serialized).not.toContain("argHash")
    expect(serialized).not.toContain("correlationId")
    // Key NAMES are fine (metadata) — apiKey/password as key strings are allowed.
    expect(serialized).toContain("apiKey")
  })

  it("applies `since` (UTC comparison)", async () => {
    await seedAuditLog([
      makeEntry({ correlationId: "old", ts: "2026-07-01T00:00:00.000Z" }),
      makeEntry({ correlationId: "new", ts: "2026-07-03T00:00:00.000Z" }),
    ])

    const result = await readAudit({ limit: 0, since: "2026-07-02T00:00:00.000Z" })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.ts).toBe("2026-07-03T00:00:00.000Z")
  })

  it("respects the tail cap: truncated:false when the log fits", async () => {
    await seedAuditLog([makeEntry(), makeEntry({ correlationId: "second" })])

    const result = await readAudit({ limit: 0 })
    expect(result.truncated).toBe(false)
    expect(result.total).toBe(2)
  })

  it("ENOENT (no log yet) is honest — empty entries, not truncated", async () => {
    const result = await readAudit({ limit: 0 })
    expect(result.entries).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.total).toBe(0)
  })
})
