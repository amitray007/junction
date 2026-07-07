// SPDX-License-Identifier: AGPL-3.0-only
// AuditEntrySchema — parse/reject tests (increment 31 A1).

import { describe, expect, it } from "vitest"
import { AuditEntrySchema } from "./schema.js"

function validEntry() {
  return {
    v: 1 as const,
    ts: "2026-07-07T00:00:00.000Z",
    event: "tool_call" as const,
    correlationId: "01J0000000000000000000000",
    principal: {
      kind: "api-key" as const,
      keyId: "key123",
      label: "my key",
      profiles: ["work"],
    },
    target: {
      profile: "work",
      namespace: "github",
      tool: "list_issues",
    },
    argKeys: ["owner", "repo"],
    argHash: "deadbeef",
    durationMs: 42,
    outcome: "ok" as const,
    errorKind: null,
  }
}

describe("AuditEntrySchema", () => {
  it("parses a well-formed ok entry", () => {
    const result = AuditEntrySchema.safeParse(validEntry())
    expect(result.success).toBe(true)
  })

  it("parses a well-formed stdio entry with null keyId/label", () => {
    const entry = validEntry()
    entry.principal = { kind: "stdio", keyId: null, label: null, profiles: ["work"] }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(true)
  })

  it("parses a well-formed error entry with a non-null errorKind", () => {
    const entry = { ...validEntry(), outcome: "error" as const, errorKind: "tool-denied" }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(true)
  })

  it("rejects v !== 1", () => {
    const entry = { ...validEntry(), v: 2 }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it("rejects event !== 'tool_call'", () => {
    const entry = { ...validEntry(), event: "tools_list" }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it("rejects a missing required field (durationMs)", () => {
    const entry: Record<string, unknown> = validEntry()
    delete entry.durationMs
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it("rejects an outcome outside 'ok' | 'error'", () => {
    const entry = { ...validEntry(), outcome: "pending" }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
  })
})
