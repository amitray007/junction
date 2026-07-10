// SPDX-License-Identifier: AGPL-3.0-only
// AuditEntrySchema — parse/reject tests (increment 31 A1; extended to the
// discriminated tool_call/code_exec union at increment 33 Slice A).
//
// REGRESSION PROOF (33 Slice A): a pre-33 well-formed tool_call JSONL line
// (validEntry(), unchanged from before the union) must still validate
// BYTE-IDENTICALLY — a shape drift on the tool_call member breaks every
// previously-written audit line.

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

function validCodeExecEntry() {
  return {
    v: 1 as const,
    ts: "2026-07-07T00:00:00.000Z",
    event: "code_exec" as const,
    correlationId: "01J0000000000000000000001",
    principal: {
      kind: "stdio" as const,
      keyId: null,
      label: null,
      profiles: ["work"],
    },
    profile: "work",
    durationMs: 88,
    outcome: "ok" as const,
    errorKind: null,
    toolCallCount: 3,
  }
}

describe("AuditEntrySchema — tool_call member (pre-33 shape, BYTE-IDENTICAL)", () => {
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

  it("rejects event outside the known union members", () => {
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

describe("AuditEntrySchema — code_exec member (increment 33 Slice A)", () => {
  it("parses a well-formed ok code_exec entry", () => {
    const result = AuditEntrySchema.safeParse(validCodeExecEntry())
    expect(result.success).toBe(true)
  })

  it("parses a well-formed error code_exec entry with a non-null errorKind", () => {
    const entry = {
      ...validCodeExecEntry(),
      outcome: "error" as const,
      errorKind: "guest-error",
    }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(true)
  })

  it("parses toolCallCount: 0 (an execution that made no tool calls)", () => {
    const entry = { ...validCodeExecEntry(), toolCallCount: 0 }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(true)
  })

  it("rejects a code_exec entry carrying a `target`/`tool` field passthrough", () => {
    // Not literally rejected by zod (unknown keys are stripped by default),
    // but confirm the PARSED result never carries a target/tool — the
    // no-code-text/no-tool-field contract is enforced by the shape, not by
    // convention.
    const entry = {
      ...validCodeExecEntry(),
      target: { profile: "work", namespace: "gh", tool: "list_issues" },
    }
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty("target")
    }
  })

  it("rejects a missing required field (toolCallCount)", () => {
    const entry: Record<string, unknown> = validCodeExecEntry()
    delete entry.toolCallCount
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it("rejects a missing required field (profile)", () => {
    const entry: Record<string, unknown> = validCodeExecEntry()
    delete entry.profile
    const result = AuditEntrySchema.safeParse(entry)
    expect(result.success).toBe(false)
  })
})
