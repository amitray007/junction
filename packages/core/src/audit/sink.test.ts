// SPDX-License-Identifier: AGPL-3.0-only
// AuditSink contract tests — NoopAuditSink (increment 31 A3).

import { describe, expect, it } from "vitest"
import type { AuditEntry } from "./schema.js"
import { NoopAuditSink } from "./sink.js"

function makeEntry(): AuditEntry {
  return {
    v: 1,
    ts: "2026-07-07T00:00:00.000Z",
    event: "tool_call",
    correlationId: "01J0000000000000000000000",
    principal: { kind: "stdio", keyId: null, label: null, profiles: ["work"] },
    target: { profile: "work", namespace: "github", tool: "list_issues" },
    argKeys: [],
    argHash: "deadbeef",
    durationMs: 10,
    outcome: "ok",
    errorKind: null,
  }
}

describe("NoopAuditSink", () => {
  it("emit does not throw", () => {
    expect(() => NoopAuditSink.emit(makeEntry())).not.toThrow()
  })

  it("emit returns undefined (never a Promise the caller might await)", () => {
    const result = NoopAuditSink.emit(makeEntry())
    expect(result).toBeUndefined()
  })
})
