// SPDX-License-Identifier: AGPL-3.0-only
// emitToolCall / emitCodeExec — unit tests (increment 33 Slice A).
// Regression proof: emitToolCall must build the SAME shape adaptToMcpHandlers
// used to build inline (pre-33) — a shape drift breaks old-line validation.

import { describe, expect, it } from "vitest"
import { emitCodeExec, emitToolCall } from "./emit.js"
import type { AuditEntry, AuditPrincipal, AuditSink } from "./schema.js"

function makeSink() {
  const entries: AuditEntry[] = []
  const sink: AuditSink = { emit: (e) => entries.push(e) }
  return { sink, entries }
}

const stdioPrincipal: AuditPrincipal = {
  kind: "stdio",
  keyId: null,
  label: null,
  profiles: ["work"],
}

describe("emitToolCall", () => {
  it("builds + emits a well-formed tool_call entry", () => {
    const { sink, entries } = makeSink()
    emitToolCall({
      sink,
      principal: stdioPrincipal,
      target: { profile: "work", namespace: "gh", tool: "list_issues" },
      args: { owner: "acme", repo: "widgets" },
      outcome: "ok",
      durationMs: 12,
      errorKind: null,
      correlationId: "cid-1",
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toMatchObject({
      v: 1,
      event: "tool_call",
      correlationId: "cid-1",
      principal: stdioPrincipal,
      target: { profile: "work", namespace: "gh", tool: "list_issues" },
      argKeys: ["owner", "repo"],
      durationMs: 12,
      outcome: "ok",
      errorKind: null,
    })
    expect(typeof entry?.ts).toBe("string")
    if (entry?.event === "tool_call") {
      expect(typeof entry.argHash).toBe("string")
    }
  })

  it("never includes an arg VALUE — only sorted key names + a hash", () => {
    const { sink, entries } = makeSink()
    emitToolCall({
      sink,
      principal: stdioPrincipal,
      target: { profile: "work", namespace: "gh", tool: "auth" },
      args: { token: "sk-super-secret-value", password: "hunter2" },
      outcome: "ok",
      durationMs: 1,
      errorKind: null,
      correlationId: "cid-2",
    })
    const serialized = JSON.stringify(entries[0])
    expect(serialized).not.toContain("sk-super-secret-value")
    expect(serialized).not.toContain("hunter2")
    expect(serialized).toContain("token") // key NAME is fine (metadata)
  })

  it("records an error outcome with the discriminated errorKind tag", () => {
    const { sink, entries } = makeSink()
    emitToolCall({
      sink,
      principal: stdioPrincipal,
      target: { profile: "work", namespace: "gh", tool: "list_issues" },
      args: {},
      outcome: "error",
      durationMs: 5,
      errorKind: "tool-denied",
      correlationId: "cid-3",
    })
    expect(entries[0]).toMatchObject({ outcome: "error", errorKind: "tool-denied" })
  })

  it("never throws into the caller, even when sink.emit throws", () => {
    const sink: AuditSink = {
      emit: () => {
        throw new Error("disk full")
      },
    }
    expect(() =>
      emitToolCall({
        sink,
        principal: stdioPrincipal,
        target: { profile: "work", namespace: "gh", tool: "x" },
        args: {},
        outcome: "ok",
        durationMs: 1,
        errorKind: null,
        correlationId: "cid-4",
      }),
    ).not.toThrow()
  })
})

describe("emitCodeExec", () => {
  it("builds + emits a well-formed code_exec entry with no target/tool field", () => {
    const { sink, entries } = makeSink()
    emitCodeExec({
      sink,
      correlationId: "cid-shared",
      principal: stdioPrincipal,
      profile: "work",
      durationMs: 100,
      outcome: "ok",
      errorKind: null,
      toolCallCount: 3,
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toMatchObject({
      v: 1,
      event: "code_exec",
      correlationId: "cid-shared",
      principal: stdioPrincipal,
      profile: "work",
      durationMs: 100,
      outcome: "ok",
      errorKind: null,
      toolCallCount: 3,
    })
    expect(entry).not.toHaveProperty("target")
    expect(entry).not.toHaveProperty("tool")
  })

  it("never includes code text or any arg value (only counts + ids)", () => {
    const { sink, entries } = makeSink()
    emitCodeExec({
      sink,
      correlationId: "cid-shared-2",
      principal: stdioPrincipal,
      profile: "work",
      durationMs: 50,
      outcome: "error",
      errorKind: "guest-error",
      toolCallCount: 0,
    })
    const serialized = JSON.stringify(entries[0])
    expect(serialized).not.toMatch(/console\.log|fetch\(|require\(/)
  })

  it("never throws into the caller, even when sink.emit throws", () => {
    const sink: AuditSink = {
      emit: () => {
        throw new Error("disk full")
      },
    }
    expect(() =>
      emitCodeExec({
        sink,
        correlationId: "cid-5",
        principal: stdioPrincipal,
        profile: "work",
        durationMs: 1,
        outcome: "ok",
        errorKind: null,
        toolCallCount: 0,
      }),
    ).not.toThrow()
  })
})

describe("emitToolCall + emitCodeExec — correlationId parenting", () => {
  it("sharing the same correlationId joins an inner tool_call to its wrapping code_exec", () => {
    const { sink, entries } = makeSink()
    const sharedId = "shared-correlation-id"

    emitToolCall({
      sink,
      principal: stdioPrincipal,
      target: { profile: "work", namespace: "gh", tool: "list_issues" },
      args: {},
      outcome: "ok",
      durationMs: 3,
      errorKind: null,
      correlationId: sharedId,
    })
    emitCodeExec({
      sink,
      correlationId: sharedId,
      principal: stdioPrincipal,
      profile: "work",
      durationMs: 20,
      outcome: "ok",
      errorKind: null,
      toolCallCount: 1,
    })

    expect(entries).toHaveLength(2)
    expect(entries[0]?.correlationId).toBe(sharedId)
    expect(entries[1]?.correlationId).toBe(sharedId)
  })
})
