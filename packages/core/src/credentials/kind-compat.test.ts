// SPDX-License-Identifier: AGPL-3.0-only
// kind-compat.test.ts — every platform shape → expected preferred list + accepted set.
// oauth2 joins the matrix honestly for oauth2-scheme platforms (inc 29); bearer
// accepted everywhere (legacy back-compat).

import { describe, expect, it } from "vitest"
import type { CredentialKind } from "../schema/credential.js"
import type { Platform } from "../schema/platform.js"
import { compatibleCredentialKinds, isKindAccepted } from "./kind-compat.js"

const ALL_KINDS: CredentialKind[] = ["api-key", "bearer", "oauth2", "file", "env"]

function platform(overrides: Partial<Platform> & Pick<Platform, "kind">): Platform {
  return {
    id: "plat_test",
    displayName: "Test",
    ...overrides,
  } as Platform
}

describe("compatibleCredentialKinds", () => {
  it("openapi bearer → [bearer]", () => {
    const p = platform({
      kind: "openapi",
      openapi: {
        spec: { from: "url", url: "https://x" },
        auth: { scheme: "bearer", header: "Authorization" },
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["bearer"])
  })

  it("openapi oauth2 → [oauth2] (the honest kind, inc 29)", () => {
    const p = platform({
      kind: "openapi",
      openapi: { spec: { from: "url", url: "https://x" }, auth: { scheme: "oauth2" } },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["oauth2"])
  })

  it("openapi apiKey → [api-key]", () => {
    const p = platform({
      kind: "openapi",
      openapi: {
        spec: { from: "url", url: "https://x" },
        auth: { scheme: "apiKey", in: "header", name: "X-Api-Key" },
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["api-key"])
  })

  it("openapi basic → [bearer] (deferred modeling)", () => {
    const p = platform({
      kind: "openapi",
      openapi: {
        spec: { from: "url", url: "https://x" },
        auth: { scheme: "basic", username: "u" },
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["bearer"])
  })

  it("openapi no auth → [] (public source)", () => {
    const p = platform({ kind: "openapi", openapi: { spec: { from: "url", url: "https://x" } } })
    expect(compatibleCredentialKinds(p)).toEqual([])
  })

  it("openapi with no openapi descriptor at all → []", () => {
    const p = platform({ kind: "openapi" })
    expect(compatibleCredentialKinds(p)).toEqual([])
  })

  it("graphql bearer → [bearer]", () => {
    const p = platform({
      kind: "graphql",
      graphql: {
        endpoint: "https://x/graphql",
        auth: { scheme: "bearer", header: "Authorization" },
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["bearer"])
  })

  it("graphql apiKey → [api-key]", () => {
    const p = platform({
      kind: "graphql",
      graphql: {
        endpoint: "https://x/graphql",
        auth: { scheme: "apiKey", in: "header", name: "X-Key" },
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["api-key"])
  })

  it("graphql no auth → []", () => {
    const p = platform({ kind: "graphql", graphql: { endpoint: "https://x/graphql" } })
    expect(compatibleCredentialKinds(p)).toEqual([])
  })

  it("mcp http bearer → [bearer]", () => {
    const p = platform({
      kind: "mcp",
      connection: {
        transport: "http",
        url: "https://x",
        auth: { scheme: "bearer", header: "Authorization" },
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["bearer"])
  })

  it("mcp http header (NEW variant) → [api-key]", () => {
    const p = platform({
      kind: "mcp",
      connection: {
        transport: "http",
        url: "https://x",
        auth: { scheme: "header", name: "X-Api-Key" },
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["api-key"])
  })

  it("mcp http no auth → []", () => {
    const p = platform({ kind: "mcp", connection: { transport: "http", url: "https://x" } })
    expect(compatibleCredentialKinds(p)).toEqual([])
  })

  it("mcp stdio → [env, bearer] (env is the honest default; bearer legacy)", () => {
    const p = platform({
      kind: "mcp",
      connection: { transport: "stdio", command: "npx", args: [], tokenEnvVar: "TOKEN" },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["env", "bearer"])
  })

  it("mcp with no connection descriptor → []", () => {
    const p = platform({ kind: "mcp" })
    expect(compatibleCredentialKinds(p)).toEqual([])
  })

  it("mcp with an unrecognized transport does NOT silently fall through to stdio's kinds (never-guard, fix 3)", () => {
    // Bypass the type system the way a future third McpConnection transport
    // variant would arrive at runtime (e.g. a malformed/forward-incompatible
    // DB row) — before the fix, `transport === "http"` was the only explicit
    // check and everything else (including a hypothetical third transport)
    // fell through to stdio's ["env", "bearer"]. The explicit `transport ===
    // "stdio"` branch + never-guard means an unrecognized transport can no
    // longer be mistaken for stdio — TypeScript now requires a new branch
    // before it could ever return stdio's kinds for it.
    const p = platform({
      kind: "mcp",
      connection: { transport: "websocket" } as unknown as NonNullable<
        Extract<Platform, { kind: "mcp" }>["connection"]
      >,
    })
    expect(compatibleCredentialKinds(p)).not.toEqual(["env", "bearer"])
  })

  it("cli → [env, file, bearer]", () => {
    const p = platform({
      kind: "cli",
      cli: {
        tools: [
          {
            name: "run",
            argv: [{ kind: "literal", value: "/bin/true" }],
            policy: { cwd: "/tmp", readPaths: [], writePaths: [], allowNet: [], timeoutMs: 1000 },
          },
        ],
      },
    })
    expect(compatibleCredentialKinds(p)).toEqual(["env", "file", "bearer"])
  })

  it("custom → [] (no descriptor shape defined yet)", () => {
    const p = platform({ kind: "custom" })
    expect(compatibleCredentialKinds(p)).toEqual([])
  })
})

describe("isKindAccepted", () => {
  it("an oauth2-scheme openapi/graphql platform → compatibleCredentialKinds includes oauth2, isKindAccepted is true", () => {
    const openapi = platform({
      kind: "openapi",
      openapi: { spec: { from: "url", url: "https://x" }, auth: { scheme: "oauth2" } },
    })
    const graphql = platform({
      kind: "graphql",
      graphql: { endpoint: "https://x/graphql", auth: { scheme: "oauth2" } },
    })
    for (const p of [openapi, graphql]) {
      expect(compatibleCredentialKinds(p)).toContain("oauth2")
      expect(isKindAccepted(p, "oauth2")).toBe(true)
    }
  })

  it("a bearer/apiKey platform → isKindAccepted(platform, oauth2) is false (oauth2 not in its matrix)", () => {
    const bearerPlatform = platform({
      kind: "openapi",
      openapi: {
        spec: { from: "url", url: "https://x" },
        auth: { scheme: "bearer", header: "Authorization" },
      },
    })
    const apiKeyPlatform = platform({
      kind: "openapi",
      openapi: {
        spec: { from: "url", url: "https://x" },
        auth: { scheme: "apiKey", in: "header", name: "X" },
      },
    })
    expect(isKindAccepted(bearerPlatform, "oauth2")).toBe(false)
    expect(isKindAccepted(apiKeyPlatform, "oauth2")).toBe(false)
  })

  it("bearer is accepted for every platform shape (legacy back-compat)", () => {
    const shapes: Platform[] = [
      platform({
        kind: "openapi",
        openapi: {
          spec: { from: "url", url: "https://x" },
          auth: { scheme: "apiKey", in: "header", name: "X" },
        },
      }),
      platform({ kind: "openapi" }),
      platform({ kind: "graphql", graphql: { endpoint: "https://x/graphql" } }),
      platform({
        kind: "mcp",
        connection: { transport: "http", url: "https://x", auth: { scheme: "header", name: "X" } },
      }),
      platform({ kind: "mcp", connection: { transport: "stdio", command: "npx", args: [] } }),
      platform({ kind: "mcp" }),
      platform({
        kind: "cli",
        cli: {
          tools: [
            {
              name: "run",
              argv: [{ kind: "literal", value: "/bin/true" }],
              policy: { cwd: "/tmp", readPaths: [], writePaths: [], allowNet: [], timeoutMs: 1000 },
            },
          ],
        },
      }),
      platform({ kind: "custom" }),
    ]
    for (const p of shapes) {
      expect(isKindAccepted(p, "bearer")).toBe(true)
    }
  })

  it("explicit wrong kind is rejected (e.g. env on an openapi apiKey platform)", () => {
    const p = platform({
      kind: "openapi",
      openapi: {
        spec: { from: "url", url: "https://x" },
        auth: { scheme: "apiKey", in: "header", name: "X" },
      },
    })
    expect(isKindAccepted(p, "env")).toBe(false)
    expect(isKindAccepted(p, "file")).toBe(false)
  })

  it("api-key accepted for openapi apiKey platform", () => {
    const p = platform({
      kind: "openapi",
      openapi: {
        spec: { from: "url", url: "https://x" },
        auth: { scheme: "apiKey", in: "header", name: "X" },
      },
    })
    expect(isKindAccepted(p, "api-key")).toBe(true)
  })

  it("env accepted for cli and mcp-stdio platforms", () => {
    const cli = platform({
      kind: "cli",
      cli: {
        tools: [
          {
            name: "run",
            argv: [{ kind: "literal", value: "/bin/true" }],
            policy: { cwd: "/tmp", readPaths: [], writePaths: [], allowNet: [], timeoutMs: 1000 },
          },
        ],
      },
    })
    const stdio = platform({
      kind: "mcp",
      connection: { transport: "stdio", command: "npx", args: [] },
    })
    expect(isKindAccepted(cli, "env")).toBe(true)
    expect(isKindAccepted(stdio, "env")).toBe(true)
  })

  it("file accepted only for cli platforms", () => {
    const cli = platform({
      kind: "cli",
      cli: {
        tools: [
          {
            name: "run",
            argv: [{ kind: "literal", value: "/bin/true" }],
            policy: { cwd: "/tmp", readPaths: [], writePaths: [], allowNet: [], timeoutMs: 1000 },
          },
        ],
      },
    })
    const stdio = platform({
      kind: "mcp",
      connection: { transport: "stdio", command: "npx", args: [] },
    })
    expect(isKindAccepted(cli, "file")).toBe(true)
    expect(isKindAccepted(stdio, "file")).toBe(false)
  })

  it("derivation default is always the first entry of compatibleCredentialKinds", () => {
    const cases: Array<{ p: Platform; expectedFirst: CredentialKind }> = [
      {
        p: platform({
          kind: "openapi",
          openapi: {
            spec: { from: "url", url: "https://x" },
            auth: { scheme: "apiKey", in: "header", name: "X" },
          },
        }),
        expectedFirst: "api-key",
      },
      {
        p: platform({ kind: "mcp", connection: { transport: "stdio", command: "npx", args: [] } }),
        expectedFirst: "env",
      },
      {
        p: platform({
          kind: "cli",
          cli: {
            tools: [
              {
                name: "run",
                argv: [{ kind: "literal", value: "/bin/true" }],
                policy: {
                  cwd: "/tmp",
                  readPaths: [],
                  writePaths: [],
                  allowNet: [],
                  timeoutMs: 1000,
                },
              },
            ],
          },
        }),
        expectedFirst: "env",
      },
    ]
    for (const { p, expectedFirst } of cases) {
      expect(compatibleCredentialKinds(p)[0]).toBe(expectedFirst)
    }
  })

  it("ALL_KINDS sanity — every kind is classified as accepted or not without throwing", () => {
    const p = platform({
      kind: "mcp",
      connection: {
        transport: "http",
        url: "https://x",
        auth: { scheme: "bearer", header: "Authorization" },
      },
    })
    for (const kind of ALL_KINDS) {
      expect(() => isKindAccepted(p, kind)).not.toThrow()
    }
  })
})
