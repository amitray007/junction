// SPDX-License-Identifier: AGPL-3.0-only
// fn-guards.server.ts tests — 32.13 Slice E2: assertLocalHost's Origin
// allowlist is the actual CSRF control (the Host check alone only stops
// DNS-rebinding — see the doc comment on assertLocalHost).

import { afterEach, describe, expect, it, vi } from "vitest"

const headersMap = new Map<string, string>()

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => ({
    headers: {
      get: (key: string) => headersMap.get(key.toLowerCase()) ?? null,
    },
  }),
}))

const { assertLocalHost, requireSecretString, requireString } = await import(
  "./fn-guards.server.js"
)

function setHeaders(headers: Record<string, string | undefined>) {
  headersMap.clear()
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) headersMap.set(k.toLowerCase(), v)
  }
}

describe("assertLocalHost — Origin allowlist (32.13 Slice E2)", () => {
  afterEach(() => {
    headersMap.clear()
  })

  it("REJECTS a foreign Origin even with a legitimately-loopback Host (the CSRF case)", () => {
    setHeaders({ host: "127.0.0.1:4321", origin: "https://evil.example.com" })
    expect(() => assertLocalHost()).toThrow()
    try {
      assertLocalHost()
      throw new Error("expected assertLocalHost to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(Response)
      if (e instanceof Response) expect(e.status).toBe(403)
    }
  })

  it("ALLOWS a same-origin request (Origin = http://127.0.0.1:<port>)", () => {
    setHeaders({ host: "127.0.0.1:4321", origin: "http://127.0.0.1:4321" })
    expect(() => assertLocalHost()).not.toThrow()
  })

  it("ALLOWS a same-origin request (Origin = http://localhost:<port>)", () => {
    setHeaders({ host: "localhost:4321", origin: "http://localhost:4321" })
    expect(() => assertLocalHost()).not.toThrow()
  })

  it("ALLOWS a request with NO Origin header (same-origin simple nav / no ambient auth to ride)", () => {
    setHeaders({ host: "127.0.0.1:4321" })
    expect(() => assertLocalHost()).not.toThrow()
  })

  it("REJECTS a malformed/unparseable Origin (fail-closed)", () => {
    setHeaders({ host: "127.0.0.1:4321", origin: "not-a-valid-origin" })
    expect(() => assertLocalHost()).toThrow()
  })

  it("still REJECTS a non-loopback Host regardless of Origin (DNS-rebinding case unaffected)", () => {
    setHeaders({ host: "evil.example.com", origin: "http://127.0.0.1:4321" })
    expect(() => assertLocalHost()).toThrow()
  })
})

// ---------------------------------------------------------------------------
// requireSecretString vs requireString (32.13 Slice E4) — the secret-trim
// judgment call: a secret's whitespace must be preserved verbatim.
// ---------------------------------------------------------------------------

describe("requireSecretString — preserves whitespace (32.13 Slice E4)", () => {
  it("requireString TRIMS a value with leading/trailing whitespace (unchanged baseline behavior)", () => {
    expect(requireString("  work  ", "account")).toBe("work")
  })

  it("requireSecretString does NOT trim — a secret's whitespace is preserved verbatim", () => {
    expect(requireSecretString("  s3cr3t-with-spaces  ", "secret")).toBe("  s3cr3t-with-spaces  ")
  })

  it("requireSecretString still rejects an EMPTY/all-whitespace secret", () => {
    expect(() => requireSecretString("   ", "secret")).toThrow()
    expect(() => requireSecretString("", "secret")).toThrow()
  })

  it("requireSecretString rejects a non-string value", () => {
    expect(() => requireSecretString(undefined, "secret")).toThrow()
    expect(() => requireSecretString(42, "secret")).toThrow()
  })

  it("requireSecretString accepts a normal secret with no whitespace unchanged", () => {
    expect(requireSecretString("ghp_abc123", "secret")).toBe("ghp_abc123")
  })
})
