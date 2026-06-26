// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for resolveSpecBaseUrl — pure (no I/O, no network).
// Covers: override paths, absolute server URLs, relative server URL resolution,
// no-servers / empty-servers / blank-url, server-variable templating, trailing-slash normalization.

import { describe, expect, it } from "vitest"
import { resolveSpecBaseUrl } from "../base-url.js"

const PETSTORE_URL = "https://petstore3.swagger.io/api/v3/openapi.json"

// ---------------------------------------------------------------------------
// Override (--base-url) paths
// ---------------------------------------------------------------------------

describe("resolveSpecBaseUrl — override (--base-url)", () => {
  it("absolute http override → ok, returned as-is", () => {
    const result = resolveSpecBaseUrl({}, PETSTORE_URL, "https://api.example.com/v1")
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://api.example.com/v1")
  })

  it("trailing slash stripped from override", () => {
    const result = resolveSpecBaseUrl({}, PETSTORE_URL, "https://api.example.com/v1/")
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://api.example.com/v1")
  })

  it("relative override → invalid-base-url", () => {
    const result = resolveSpecBaseUrl({}, PETSTORE_URL, "/relative-path")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-base-url")
  })

  it("non-http scheme override (ftp) → invalid-base-url", () => {
    const result = resolveSpecBaseUrl({}, PETSTORE_URL, "ftp://files.example.com")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-base-url")
  })

  it("empty string override treated as absent — falls through to servers", () => {
    const schema = { servers: [{ url: "https://api.example.com" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL, "")
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://api.example.com")
  })

  it("templated override (https://{host}/v1) → invalid-base-url (not silently stored)", () => {
    const schema = { servers: [{ url: "/api/v3" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL, "https://{host}/v1")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-base-url")
  })
})

// ---------------------------------------------------------------------------
// Absolute server URL
// ---------------------------------------------------------------------------

describe("resolveSpecBaseUrl — absolute server URL", () => {
  it("absolute https server URL → ok", () => {
    const schema = { servers: [{ url: "https://api.example.com/v2" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://api.example.com/v2")
  })

  it("trailing slash stripped from absolute server URL", () => {
    const schema = { servers: [{ url: "https://api.example.com/v2/" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://api.example.com/v2")
  })

  it("absolute http server URL → ok", () => {
    const schema = { servers: [{ url: "http://localhost:8080/api" }] }
    const result = resolveSpecBaseUrl(schema, "http://localhost:8080/openapi.json")
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("http://localhost:8080/api")
  })
})

// ---------------------------------------------------------------------------
// Relative server URL — the petstore case
// ---------------------------------------------------------------------------

describe("resolveSpecBaseUrl — relative server URL", () => {
  it("/api/v3 + petstore spec URL → https://petstore3.swagger.io/api/v3", () => {
    const schema = { servers: [{ url: "/api/v3" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://petstore3.swagger.io/api/v3")
  })

  it("/api/v1 resolves against spec origin", () => {
    const schema = { servers: [{ url: "/api/v1" }] }
    const result = resolveSpecBaseUrl(schema, "https://myservice.example.com/spec/openapi.json")
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://myservice.example.com/api/v1")
  })

  it("relative path without leading slash resolves against spec directory", () => {
    const schema = { servers: [{ url: "v2/" }] }
    const result = resolveSpecBaseUrl(schema, "https://api.example.com/specs/openapi.json")
    expect(result.isOk()).toBe(true)
    // new URL("v2/", "https://api.example.com/specs/openapi.json") → "https://api.example.com/specs/v2/"
    // trailing slash stripped → "https://api.example.com/specs/v2"
    expect(result._unsafeUnwrap()).toBe("https://api.example.com/specs/v2")
  })

  it("protocol-relative server URL inherits the spec's scheme", () => {
    const schema = { servers: [{ url: "//cdn.example.com/api" }] }
    const result = resolveSpecBaseUrl(schema, "https://api.example.com/openapi.json")
    expect(result.isOk()).toBe(true)
    expect(result._unsafeUnwrap()).toBe("https://cdn.example.com/api")
  })
})

// ---------------------------------------------------------------------------
// no-base-url cases
// ---------------------------------------------------------------------------

describe("resolveSpecBaseUrl — no-base-url", () => {
  it("no servers key → no-base-url", () => {
    const result = resolveSpecBaseUrl({}, PETSTORE_URL)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("no-base-url")
  })

  it("empty servers array → no-base-url", () => {
    const schema = { servers: [] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("no-base-url")
  })

  it("blank url in servers[0] → no-base-url", () => {
    const schema = { servers: [{ url: "" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("no-base-url")
  })

  it("null servers[0] → no-base-url", () => {
    const schema = { servers: [null] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("no-base-url")
  })
})

// ---------------------------------------------------------------------------
// Server-variable templating
// ---------------------------------------------------------------------------

describe("resolveSpecBaseUrl — server-variable templating", () => {
  it("{host} in server URL → base-url-has-variables", () => {
    const schema = { servers: [{ url: "https://{host}/v1" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("base-url-has-variables")
  })

  it("{basePath} at the end → base-url-has-variables", () => {
    const schema = { servers: [{ url: "https://api.example.com/{basePath}" }] }
    const result = resolveSpecBaseUrl(schema, PETSTORE_URL)
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("base-url-has-variables")
  })
})
