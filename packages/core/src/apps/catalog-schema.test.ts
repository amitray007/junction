// SPDX-License-Identifier: AGPL-3.0-only
// AppCatalogEntrySchema tests — valid/invalid shapes + the starterTools
// identity-reuse proof (§2e: starterTools MUST reuse the shipped
// HttpRequestToolSchema/CliToolSchema, never redefine them).

import { describe, expect, it } from "vitest"
import { CliToolSchema } from "../schema/cli-connection.js"
import { HttpRequestToolSchema } from "../schema/http-connection.js"
import {
  AppCatalogEntrySchema,
  AppSurfaceConnectionSchema,
  AppSurfaceSchema,
  BuildRecipeSchema,
  VerifyHintSchema,
} from "./catalog-schema.js"

describe("AppCatalogEntrySchema — backwards-compatible core", () => {
  it("validates a thin/legacy entry with no surfaces or help (AppDefinition superset)", () => {
    const result = AppCatalogEntrySchema.safeParse({
      id: "google",
      displayName: "Google",
      supportedKinds: ["openapi"],
      auth: [{ mode: "oauth2", providerId: "google" }],
      iconSlug: "google",
    })
    expect(result.success).toBe(true)
  })

  it("validates every field of a full legacy-shaped AppDefinition", () => {
    const result = AppCatalogEntrySchema.safeParse({
      id: "github",
      displayName: "GitHub",
      supportedKinds: ["mcp", "cli", "openapi", "graphql"],
      auth: [
        { mode: "oauth2", providerId: "github" },
        { mode: "oauth2", providerId: "github-app" },
        { mode: "token" },
      ],
      aliases: ["gh"],
      setupHints: ["hint"],
      iconSlug: "github",
    })
    expect(result.success).toBe(true)
  })

  it("rejects a missing required field (id)", () => {
    const result = AppCatalogEntrySchema.safeParse({
      displayName: "GitHub",
      supportedKinds: ["mcp"],
      auth: [{ mode: "token" }],
    })
    expect(result.success).toBe(false)
  })

  it("rejects an unknown auth mode", () => {
    const result = AppCatalogEntrySchema.safeParse({
      id: "x",
      displayName: "X",
      supportedKinds: [],
      auth: [{ mode: "bogus" }],
    })
    expect(result.success).toBe(false)
  })

  it("rejects an unknown supportedKinds member", () => {
    const result = AppCatalogEntrySchema.safeParse({
      id: "x",
      displayName: "X",
      supportedKinds: ["oauth"],
      auth: [{ mode: "token" }],
    })
    expect(result.success).toBe(false)
  })
})

describe("AppSurfaceSchema + AppSurfaceConnectionSchema — per-kind templates", () => {
  it("validates an mcp http-transport surface", () => {
    const result = AppSurfaceSchema.safeParse({
      kind: "mcp",
      displayName: "MCP",
      connection: { kind: "mcp", transport: "http", url: "https://api.githubcopilot.com/mcp/" },
      auth: [{ mode: "token" }],
      build: {
        platformIdTemplate: "{app}",
        via: "flattened",
        credential: { kind: "bearer", from: "auth" },
      },
      verify: { kind: "mcp", listTools: true },
    })
    expect(result.success).toBe(true)
  })

  it("validates an openapi surface", () => {
    const result = AppSurfaceConnectionSchema.safeParse({
      kind: "openapi",
      specUrl: "https://example.com/openapi.json",
      baseUrl: "https://api.example.com",
      verifyOperationId: "users/get-authenticated",
    })
    expect(result.success).toBe(true)
  })

  it("validates a graphql surface", () => {
    const result = AppSurfaceConnectionSchema.safeParse({
      kind: "graphql",
      endpoint: "https://api.example.com/graphql",
    })
    expect(result.success).toBe(true)
  })

  it("validates a PRESENT-BUT-EMPTY http surface (no starterTools) — the GitHub gap-filler shape", () => {
    const result = AppSurfaceSchema.safeParse({
      kind: "http",
      displayName: "HTTP",
      connection: { kind: "http", baseUrl: "https://api.example.com" },
      auth: [{ mode: "token" }],
      build: {
        platformIdTemplate: "{app}-http",
        via: "descriptor",
        credential: { kind: "bearer", from: "auth" },
      },
      verify: { kind: "none" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.starterTools).toBeUndefined()
    }
  })

  it("validates a cli surface with credentialEnvVar", () => {
    const result = AppSurfaceConnectionSchema.safeParse({
      kind: "cli",
      credentialEnvVar: "GH_PAT",
    })
    expect(result.success).toBe(true)
  })

  it("rejects an unknown connection kind", () => {
    const result = AppSurfaceConnectionSchema.safeParse({ kind: "grpc" })
    expect(result.success).toBe(false)
  })

  it("rejects a surface with zero auth entries", () => {
    const result = AppSurfaceSchema.safeParse({
      kind: "http",
      displayName: "HTTP",
      connection: { kind: "http", baseUrl: "https://api.example.com" },
      auth: [],
      build: {
        platformIdTemplate: "{app}-http",
        via: "descriptor",
        credential: { kind: "bearer", from: "auth" },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects an mcp template with transport:"http" and no url (malformed, would fail late in 30.11)', () => {
    const result = AppSurfaceConnectionSchema.safeParse({ kind: "mcp", transport: "http" })
    expect(result.success).toBe(false)
  })

  it('rejects an mcp template with transport:"stdio" and no command (malformed, would fail late in 30.11)', () => {
    const result = AppSurfaceConnectionSchema.safeParse({ kind: "mcp", transport: "stdio" })
    expect(result.success).toBe(false)
  })
})

describe("VerifyHintSchema — declarative-only union", () => {
  it("accepts all four declared kinds", () => {
    expect(VerifyHintSchema.safeParse({ kind: "openapi", operationId: "x" }).success).toBe(true)
    expect(VerifyHintSchema.safeParse({ kind: "mcp", listTools: true }).success).toBe(true)
    expect(VerifyHintSchema.safeParse({ kind: "graphql", typenameProbe: true }).success).toBe(true)
    expect(VerifyHintSchema.safeParse({ kind: "none" }).success).toBe(true)
  })

  it("rejects an invented verify kind", () => {
    expect(VerifyHintSchema.safeParse({ kind: "cli", something: true }).success).toBe(false)
  })

  it("rejects mcp listTools:false (must be literal true)", () => {
    expect(VerifyHintSchema.safeParse({ kind: "mcp", listTools: false }).success).toBe(false)
  })
})

describe("BuildRecipeSchema — declarative data, not executed here", () => {
  it("validates a flattened recipe", () => {
    const result = BuildRecipeSchema.safeParse({
      platformIdTemplate: "{app}",
      via: "flattened",
      credential: { kind: "oauth2", from: "auth" },
    })
    expect(result.success).toBe(true)
  })

  it("validates a descriptor recipe", () => {
    const result = BuildRecipeSchema.safeParse({
      platformIdTemplate: "{app}-{kind}",
      via: "descriptor",
      credential: { kind: "bearer", from: "auth" },
    })
    expect(result.success).toBe(true)
  })

  it("rejects an unknown `via`", () => {
    const result = BuildRecipeSchema.safeParse({
      platformIdTemplate: "{app}",
      via: "magic",
      credential: { kind: "bearer", from: "auth" },
    })
    expect(result.success).toBe(false)
  })
})

describe("starterTools — identity reuse of the shipped tool schemas (§2e, proof-of-done)", () => {
  it("AppSurfaceSchema.starterTools union options are the SAME schema objects as the imports (not a redefinition)", () => {
    // Assert object identity, not just structural compatibility: the union
    // member the surface schema validates against must literally BE the
    // imported HttpRequestToolSchema/CliToolSchema — a re-derived lookalike
    // schema would pass every structural test above but fail this one.
    const arraySchema = AppSurfaceSchema.shape.starterTools.unwrap() // ZodOptional -> ZodArray
    const unionOptions = arraySchema.element.options
    expect(unionOptions).toContain(HttpRequestToolSchema)
    expect(unionOptions).toContain(CliToolSchema)
  })

  it("AppSurfaceSchema.starterTools validates a valid HttpRequestTool", () => {
    const httpTool = {
      name: "get_thing",
      description: "Get a thing.",
      method: "GET" as const,
      path: "/things/{id}",
      params: [{ name: "id", in: "path" as const, type: "string" as const, required: true }],
    }
    expect(HttpRequestToolSchema.safeParse(httpTool).success).toBe(true)
    const surfaceResult = AppSurfaceSchema.safeParse({
      kind: "http",
      displayName: "HTTP",
      connection: { kind: "http", baseUrl: "https://api.example.com" },
      auth: [{ mode: "token" }],
      build: {
        platformIdTemplate: "{app}-http",
        via: "descriptor",
        credential: { kind: "bearer", from: "auth" },
      },
      starterTools: [httpTool],
    })
    expect(surfaceResult.success).toBe(true)
  })

  it("AppSurfaceSchema.starterTools accepts a valid CliTool via the SAME CliToolSchema export", () => {
    const cliTool = {
      name: "list_things",
      argv: [
        { kind: "literal" as const, value: "/usr/bin/things" },
        { kind: "literal" as const, value: "list" },
      ],
      policy: {
        cwd: "/tmp",
        readPaths: ["/tmp"],
        writePaths: [],
        allowNet: [],
        timeoutMs: 5000,
      },
    }
    expect(CliToolSchema.safeParse(cliTool).success).toBe(true)
    const surfaceResult = AppSurfaceSchema.safeParse({
      kind: "cli",
      displayName: "CLI",
      connection: { kind: "cli", credentialEnvVar: "THING_PAT" },
      auth: [{ mode: "token" }],
      build: {
        platformIdTemplate: "{app}-cli",
        via: "descriptor",
        credential: { kind: "bearer", from: "auth" },
      },
      starterTools: [cliTool],
    })
    expect(surfaceResult.success).toBe(true)
  })

  it("rejects a starterTool that fails HttpRequestToolSchema's own refinements (proves it's not loosely re-validated)", () => {
    // A path placeholder with no matching declared param — HttpRequestToolSchema
    // refine rejects this. If catalog-schema silently accepted it, that would
    // prove it redefined a laxer schema instead of reusing the real one.
    const badHttpTool = {
      name: "get_thing",
      description: "Get a thing.",
      method: "GET" as const,
      path: "/things/{id}",
      params: [],
    }
    expect(HttpRequestToolSchema.safeParse(badHttpTool).success).toBe(false)
    const surfaceResult = AppSurfaceSchema.safeParse({
      kind: "http",
      displayName: "HTTP",
      connection: { kind: "http", baseUrl: "https://api.example.com" },
      auth: [{ mode: "token" }],
      build: {
        platformIdTemplate: "{app}-http",
        via: "descriptor",
        credential: { kind: "bearer", from: "auth" },
      },
      starterTools: [badHttpTool],
    })
    expect(surfaceResult.success).toBe(false)
  })
})
