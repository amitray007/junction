// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for pending-auth.server.ts — the in-memory state singleton
// shared by the connect server-fn and the /oauth/callback loader (inc 29,
// slice C). Pure in-process Map — no DB/store mocking needed.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  _clearPendingForTests,
  _pendingSizeForTests,
  type PendingAuth,
  putPending,
  takePending,
} from "./pending-auth.server.js"

function makeEntry(overrides: Partial<PendingAuth> = {}): PendingAuth {
  return {
    codeVerifier: "verifier-1",
    providerId: "github",
    clientId: "client-1",
    clientSecret: "secret-1",
    scopes: ["repo"],
    createdAt: Date.now(),
    intent: { mode: "create", platformId: "github-platform", account: "work" },
    ...overrides,
  }
}

afterEach(() => {
  _clearPendingForTests()
  vi.useRealTimers()
})

describe("pending-auth.server — put/take single-use", () => {
  it("takePending returns the stashed entry on first read", () => {
    putPending("state-1", makeEntry())
    const entry = takePending("state-1")
    expect(entry).toBeDefined()
    expect(entry?.providerId).toBe("github")
  })

  it("increment 38 D2: the create-intent's OPTIONAL surfacePlatform round-trips through put/take", () => {
    const mcpInput = {
      kind: "mcp" as const,
      transport: "http" as const,
      url: "https://example.com/mcp",
      authHeader: undefined,
      command: undefined,
      args: undefined,
      tokenEnvVar: undefined,
      env: undefined,
    }
    putPending(
      "state-surface",
      makeEntry({
        intent: {
          mode: "create",
          platformId: "github-mcp",
          account: "work",
          surfacePlatform: { platformInput: mcpInput, displayName: "GitHub MCP" },
        },
      }),
    )
    const entry = takePending("state-surface")
    expect(entry?.intent).toEqual({
      mode: "create",
      platformId: "github-mcp",
      account: "work",
      surfacePlatform: { platformInput: mcpInput, displayName: "GitHub MCP" },
    })
  })

  it("surfacePlatform ABSENT on the create-intent is still a valid entry (must-stay-working: raw /credentials + CLI)", () => {
    putPending("state-no-surface", makeEntry())
    const entry = takePending("state-no-surface")
    expect(entry?.intent).toEqual({
      mode: "create",
      platformId: "github-platform",
      account: "work",
    })
    expect(entry?.intent && "surfacePlatform" in entry.intent).toBe(false)
  })

  it("a second takePending for the same state returns undefined (single-use)", () => {
    putPending("state-1", makeEntry())
    takePending("state-1")
    const second = takePending("state-1")
    expect(second).toBeUndefined()
  })

  it("an unknown state returns undefined", () => {
    expect(takePending("never-put")).toBeUndefined()
  })

  it("distinct states don't interfere with each other", () => {
    putPending("state-a", makeEntry({ providerId: "google" }))
    putPending("state-b", makeEntry({ providerId: "slack" }))
    expect(takePending("state-a")?.providerId).toBe("google")
    expect(takePending("state-b")?.providerId).toBe("slack")
  })
})

describe("pending-auth.server — TTL eviction", () => {
  it("an entry older than the TTL is not returned by takePending", () => {
    vi.useFakeTimers()
    const start = Date.now()
    vi.setSystemTime(start)
    putPending("state-old", makeEntry({ createdAt: start }))

    // Advance past the 10-minute TTL.
    vi.setSystemTime(start + 11 * 60 * 1000)
    const entry = takePending("state-old")
    expect(entry).toBeUndefined()
  })

  it("putPending sweeps expired entries so the Map doesn't retain them", () => {
    vi.useFakeTimers()
    const start = Date.now()
    vi.setSystemTime(start)
    putPending("state-old", makeEntry({ createdAt: start }))
    expect(_pendingSizeForTests()).toBe(1)

    // A later put (past TTL) sweeps the stale entry before inserting its own.
    vi.setSystemTime(start + 11 * 60 * 1000)
    putPending("state-new", makeEntry({ createdAt: start + 11 * 60 * 1000 }))
    expect(_pendingSizeForTests()).toBe(1)
    expect(takePending("state-old")).toBeUndefined()
    expect(takePending("state-new")).toBeDefined()
  })
})

describe("pending-auth.server — max-size cap", () => {
  it("never grows past the cap — the oldest entry is evicted to make room", () => {
    // Insert 101 entries (cap is 100) at the SAME timestamp so none are TTL-swept —
    // isolates the cap-eviction path from the TTL-sweep path.
    const now = Date.now()
    for (let i = 0; i < 101; i++) {
      putPending(`state-${i}`, makeEntry({ createdAt: now }))
    }
    expect(_pendingSizeForTests()).toBe(100)
    // The very first inserted entry (oldest by insertion order) was evicted.
    expect(takePending("state-0")).toBeUndefined()
    // The most recent entry survives.
    expect(takePending("state-100")).toBeDefined()
  })
})
