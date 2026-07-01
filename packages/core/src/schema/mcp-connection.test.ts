// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for McpConnectionSchema — parse/reject for both transports.

import { describe, expect, it } from "vitest"
import { newCredentialId, newPlatformId } from "../ids/index.js"
import { McpConnectionSchema } from "./mcp-connection.js"
import { PlatformSchema } from "./platform.js"
import { SourceRefSchema } from "./source-ref.js"

describe("McpConnectionSchema", () => {
  describe("http transport", () => {
    it("parses a minimal http connection (no auth)", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "http",
        url: "https://api.example.com/mcp/",
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.transport).toBe("http")
        if (result.data.transport === "http") {
          expect(result.data.url).toBe("https://api.example.com/mcp/")
          expect(result.data.auth).toBeUndefined()
        }
      }
    })

    it("parses an http connection with explicit auth header", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "http",
        url: "https://api.example.com/mcp/",
        auth: { scheme: "bearer", header: "Authorization" },
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "http") {
        expect(result.data.auth?.header).toBe("Authorization")
        expect(result.data.auth?.scheme).toBe("bearer")
      }
    })

    it("applies default header 'Authorization' when auth is set without explicit header", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "http",
        url: "https://api.example.com/mcp/",
        auth: { scheme: "bearer" },
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "http") {
        expect(result.data.auth?.header).toBe("Authorization")
      }
    })

    it("parses an http connection with a custom auth header", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "http",
        url: "https://api.example.com/mcp/",
        auth: { scheme: "bearer", header: "X-Api-Token" },
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "http") {
        expect(result.data.auth?.header).toBe("X-Api-Token")
      }
    })

    it("rejects a bad URL", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "http",
        url: "not-a-url",
      })
      expect(result.success).toBe(false)
    })

    it("rejects missing url", () => {
      const result = McpConnectionSchema.safeParse({ transport: "http" })
      expect(result.success).toBe(false)
    })

    it("rejects empty auth header", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "http",
        url: "https://api.example.com/mcp/",
        auth: { scheme: "bearer", header: "" },
      })
      expect(result.success).toBe(false)
    })
  })

  describe("stdio transport", () => {
    it("parses a minimal stdio connection", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "stdio") {
        expect(result.data.command).toBe("npx")
        expect(result.data.args).toEqual([])
        expect(result.data.tokenEnvVar).toBeUndefined()
      }
    })

    it("parses a stdio connection with args and tokenEnvVar", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-example"],
        tokenEnvVar: "MCP_TOKEN",
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "stdio") {
        expect(result.data.args).toEqual(["-y", "@modelcontextprotocol/server-example"])
        expect(result.data.tokenEnvVar).toBe("MCP_TOKEN")
      }
    })

    it("defaults args to [] when not provided", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "my-mcp-server",
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "stdio") {
        expect(result.data.args).toEqual([])
      }
    })

    it("rejects missing command", () => {
      const result = McpConnectionSchema.safeParse({ transport: "stdio" })
      expect(result.success).toBe(false)
    })

    it("rejects empty command", () => {
      const result = McpConnectionSchema.safeParse({ transport: "stdio", command: "" })
      expect(result.success).toBe(false)
    })

    it("parses a stdio connection with a static env map", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
        env: { NODE_ENV: "production", GH_HOST: "github.example.com" },
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "stdio") {
        expect(result.data.env).toEqual({
          NODE_ENV: "production",
          GH_HOST: "github.example.com",
        })
      }
    })

    it("parses a stdio connection WITHOUT env (backward-compat)", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-example"],
        tokenEnvVar: "MCP_TOKEN",
      })
      expect(result.success).toBe(true)
      if (result.success && result.data.transport === "stdio") {
        expect(result.data.env).toBeUndefined()
      }
    })

    it("rejects an env key that is not a valid env-var identifier", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
        env: { "not-a-valid-name": "x" },
      })
      expect(result.success).toBe(false)
    })

    it("rejects an env key equal to tokenEnvVar (would shadow the credential slot)", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
        tokenEnvVar: "GITHUB_TOKEN",
        env: { GITHUB_TOKEN: "static-value" },
      })
      expect(result.success).toBe(false)
    })

    it("rejects an env key of JUNCTION_MASTER_KEY", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
        env: { JUNCTION_MASTER_KEY: "x" },
      })
      expect(result.success).toBe(false)
    })

    it("rejects an env key of JUNCTION_MASTER_KEY_FILE", () => {
      const result = McpConnectionSchema.safeParse({
        transport: "stdio",
        command: "npx",
        env: { JUNCTION_MASTER_KEY_FILE: "/path" },
      })
      expect(result.success).toBe(false)
    })
  })

  it("rejects unknown transport (discriminated union is strict)", () => {
    const result = McpConnectionSchema.safeParse({
      transport: "websocket",
      url: "wss://example.com",
    })
    expect(result.success).toBe(false)
  })
})

describe("PlatformSchema with connection", () => {
  it("parses a platform with an http connection", () => {
    const result = PlatformSchema.safeParse({
      id: newPlatformId(),
      kind: "mcp",
      displayName: "Example MCP Server",
      connection: {
        transport: "http",
        url: "https://api.example.com/mcp/",
        auth: { scheme: "bearer", header: "Authorization" },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.connection?.transport).toBe("http")
    }
  })

  it("parses a platform with a stdio connection", () => {
    const result = PlatformSchema.safeParse({
      id: newPlatformId(),
      kind: "mcp",
      displayName: "Local MCP Server",
      connection: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-example"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success && result.data.connection?.transport === "stdio") {
      expect(result.data.connection.args).toEqual(["-y", "@modelcontextprotocol/server-example"])
    }
  })

  it("parses a platform without a connection (optional)", () => {
    const result = PlatformSchema.safeParse({
      id: newPlatformId(),
      kind: "openapi",
      displayName: "OpenAPI Platform",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.connection).toBeUndefined()
    }
  })

  it("rejects a platform with a bad connection URL", () => {
    const result = PlatformSchema.safeParse({
      id: newPlatformId(),
      kind: "mcp",
      displayName: "Bad Platform",
      connection: { transport: "http", url: "not-a-url" },
    })
    expect(result.success).toBe(false)
  })
})

describe("SourceRefSchema with toolFilter", () => {
  const platformId = newPlatformId()
  const credentialId = newCredentialId()

  it("parses a SourceRef without toolFilter (expose all)", () => {
    const result = SourceRefSchema.safeParse({
      platformId,
      credentialId,
      toolNamespace: "myservice",
      enabled: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.toolFilter).toBeUndefined()
    }
  })

  it("parses a SourceRef with an allow-list", () => {
    const result = SourceRefSchema.safeParse({
      platformId,
      credentialId,
      toolNamespace: "myservice",
      enabled: true,
      toolFilter: { allow: ["list_items", "get_item"] },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.toolFilter?.allow).toEqual(["list_items", "get_item"])
      expect(result.data.toolFilter?.deny).toBeUndefined()
    }
  })

  it("parses a SourceRef with a deny-list", () => {
    const result = SourceRefSchema.safeParse({
      platformId,
      credentialId,
      toolNamespace: "myservice",
      enabled: true,
      toolFilter: { deny: ["admin_delete", "bulk_destroy"] },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.toolFilter?.deny).toEqual(["admin_delete", "bulk_destroy"])
    }
  })

  it("parses a SourceRef with both allow and deny lists", () => {
    const result = SourceRefSchema.safeParse({
      platformId,
      credentialId,
      toolNamespace: "myservice",
      enabled: true,
      toolFilter: {
        allow: ["list_items", "get_item"],
        deny: ["delete_item"],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.toolFilter?.allow).toEqual(["list_items", "get_item"])
      expect(result.data.toolFilter?.deny).toEqual(["delete_item"])
    }
  })
})
