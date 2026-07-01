// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest"
import { addMcpPlatform } from "../mcp.js"

describe("addMcpPlatform", () => {
  it("builds an http platform with the bearer auth default header", async () => {
    const result = await addMcpPlatform({
      id: "gh",
      displayName: "GitHub",
      transport: "http",
      url: "https://mcp.example.com",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.kind).toBe("mcp")
    expect(result.value.connection).toEqual({
      transport: "http",
      url: "https://mcp.example.com",
      auth: { scheme: "bearer", header: "Authorization" },
    })
  })

  it("builds an http platform with a custom auth header", async () => {
    const result = await addMcpPlatform({
      id: "gh",
      displayName: "GitHub",
      transport: "http",
      url: "https://mcp.example.com",
      authHeader: "X-Token",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.connection?.auth).toEqual({ scheme: "bearer", header: "X-Token" })
  })

  it("http transport without --url returns missing-field", async () => {
    const result = await addMcpPlatform({ id: "gh", displayName: "GitHub", transport: "http" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toEqual({ kind: "missing-field", field: "url", context: "http transport" })
  })

  it("builds a stdio platform with args + tokenEnvVar", async () => {
    const result = await addMcpPlatform({
      id: "local",
      displayName: "Local server",
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp-server"],
      tokenEnvVar: "SOME_TOKEN_VAR",
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.connection).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp-server"],
      tokenEnvVar: "SOME_TOKEN_VAR",
    })
  })

  it("stdio transport without --command returns missing-field", async () => {
    const result = await addMcpPlatform({ id: "local", displayName: "Local", transport: "stdio" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toEqual({
      kind: "missing-field",
      field: "command",
      context: "stdio transport",
    })
  })

  it("unknown transport returns invalid-transport", async () => {
    const result = await addMcpPlatform({
      id: "x",
      displayName: "X",
      // biome-ignore lint/suspicious/noExplicitAny: exercising the invalid-input branch
      transport: "carrier-pigeon" as any,
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error).toEqual({ kind: "invalid-transport", transport: "carrier-pigeon" })
  })

  it("invalid platform id fails PlatformSchema validation", async () => {
    const result = await addMcpPlatform({
      id: "",
      displayName: "GitHub",
      transport: "http",
      url: "https://mcp.example.com",
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-platform")
  })
})
