// SPDX-License-Identifier: AGPL-3.0-only
// hostIntentToEnforceablePortScope — the host-intent → enforceable-port-scope
// translation (Fable net-policy ruling, inc 41). Seatbelt/bwrap can only scope
// egress by PORT, so a host:port intent must become *:port for the sandbox.
import { describe, expect, it } from "vitest"
import { hostIntentToEnforceablePortScope } from "../cli.js"

describe("hostIntentToEnforceablePortScope", () => {
  it("translates host:port intent to *:port (any host on that port)", () => {
    expect(hostIntentToEnforceablePortScope(["api.github.com:443"])).toEqual(["*:443"])
  })

  it("dedupes multiple hosts sharing a port to a single *:port", () => {
    expect(
      hostIntentToEnforceablePortScope(["api.github.com:443", "uploads.github.com:443"]),
    ).toEqual(["*:443"])
  })

  it("preserves distinct ports", () => {
    const out = hostIntentToEnforceablePortScope(["a.com:443", "b.com:8080"])
    expect(new Set(out)).toEqual(new Set(["*:443", "*:8080"]))
  })

  it("passes through an already port-scoped entry", () => {
    expect(hostIntentToEnforceablePortScope(["*:443"])).toEqual(["*:443"])
  })

  it("accepts a bare numeric port", () => {
    expect(hostIntentToEnforceablePortScope(["443"])).toEqual(["*:443"])
  })

  it("collapses to any-port when a wildcard port is present", () => {
    expect(hostIntentToEnforceablePortScope(["host:*"])).toEqual(["*"])
    expect(hostIntentToEnforceablePortScope(["*"])).toEqual(["*"])
  })

  it("drops a bare (un-enforceable) hostname rather than emit something Seatbelt rejects", () => {
    // "api.github.com" (no port) can't be enforced by port — must NOT survive as a host entry.
    expect(hostIntentToEnforceablePortScope(["api.github.com"])).toEqual([])
  })

  it("ignores empty entries", () => {
    expect(hostIntentToEnforceablePortScope(["", "a.com:443"])).toEqual(["*:443"])
  })
})
