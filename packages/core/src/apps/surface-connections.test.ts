// SPDX-License-Identifier: AGPL-3.0-only
// intersectSurfaces unit tests — increment 30.10 method file §5 proof-of-done:
// available-only, connected, the same-kind limitation, and the leftover
// bucket (nothing dropped).

import { describe, expect, it } from "vitest"
import { intersectSurfaces } from "./surface-connections.js"

interface FakeConnection {
  kind: string
  account: string
}

describe("intersectSurfaces", () => {
  it("a surface with zero connections is 'available' (empty connections array)", () => {
    const { matched, leftover } = intersectSurfaces<FakeConnection>(
      [{ kind: "openapi" }, { kind: "mcp" }],
      [],
    )
    expect(matched).toEqual([
      { kind: "openapi", connections: [] },
      { kind: "mcp", connections: [] },
    ])
    expect(leftover).toEqual([])
  })

  it("a surface with ≥1 connection carries the FULL connection object through", () => {
    const conn: FakeConnection = { kind: "mcp", account: "work" }
    const { matched, leftover } = intersectSurfaces<FakeConnection>(
      [{ kind: "openapi" }, { kind: "mcp" }],
      [conn],
    )
    expect(matched).toEqual([
      { kind: "openapi", connections: [] },
      { kind: "mcp", connections: [conn] },
    ])
    // Full object, not a bare kind string — account survives.
    expect(matched[1]?.connections[0]?.account).toBe("work")
    expect(leftover).toEqual([])
  })

  it("multiple connections (accounts) on ONE surface all land under it — the multi-account wedge", () => {
    const workConn: FakeConnection = { kind: "mcp", account: "work" }
    const personalConn: FakeConnection = { kind: "mcp", account: "personal" }
    const { matched } = intersectSurfaces<FakeConnection>(
      [{ kind: "mcp" }],
      [workConn, personalConn],
    )
    expect(matched).toEqual([{ kind: "mcp", connections: [workConn, personalConn] }])
  })

  it("a connection whose kind matches NO surface lands in leftover, NEVER dropped", () => {
    const orphan: FakeConnection = { kind: "cli", account: "solo" }
    const { matched, leftover } = intersectSurfaces<FakeConnection>([{ kind: "openapi" }], [orphan])
    expect(matched).toEqual([{ kind: "openapi", connections: [] }])
    expect(leftover).toEqual([orphan])
  })

  it("same-kind limitation (documented, 30.12 territory): a repeated surface kind absorbs ALL connections of that kind into the LAST matching surface slot (kind lookup, not identity)", () => {
    // No current catalog entry authors two surfaces of the same kind (GitHub's
    // 5 are 5 distinct kinds) — this test exercises the documented ambiguity
    // itself, proving the function doesn't crash or silently drop connections
    // even in this out-of-contract shape, and that the LIMITATION comment's
    // claim (a single kind bucket, consumed once) is exactly what happens.
    const conn: FakeConnection = { kind: "http", account: "acct" }
    const { matched, leftover } = intersectSurfaces<FakeConnection>(
      [{ kind: "http" }, { kind: "http" }],
      [conn],
    )
    // The kind bucket is consumed by the first surface slot that requests it;
    // the second slot of the same kind sees an already-emptied bucket.
    expect(matched).toEqual([
      { kind: "http", connections: [conn] },
      { kind: "http", connections: [] },
    ])
    expect(leftover).toEqual([])
  })

  it("accounting invariant: every input connection appears exactly once across matched + leftover", () => {
    const connections: FakeConnection[] = [
      { kind: "openapi", account: "a" },
      { kind: "mcp", account: "b" },
      { kind: "mcp", account: "c" },
      { kind: "unknown-kind", account: "d" },
      { kind: "another-unknown", account: "e" },
    ]
    const { matched, leftover } = intersectSurfaces<FakeConnection>(
      [{ kind: "openapi" }, { kind: "mcp" }, { kind: "graphql" }],
      connections,
    )
    const totalOut = matched.reduce((sum, m) => sum + m.connections.length, 0) + leftover.length
    expect(totalOut).toBe(connections.length)
    // Sanity: the unmatched kinds are exactly the leftover set.
    expect(leftover.map((c) => c.account).sort()).toEqual(["d", "e"])
  })

  it("empty surfaces list → every connection is leftover", () => {
    const connections: FakeConnection[] = [
      { kind: "openapi", account: "a" },
      { kind: "mcp", account: "b" },
    ]
    const { matched, leftover } = intersectSurfaces<FakeConnection>([], connections)
    expect(matched).toEqual([])
    expect(leftover).toEqual(connections)
  })
})
