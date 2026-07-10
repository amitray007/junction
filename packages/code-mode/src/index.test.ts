// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AuditPrincipal,
  AuditSink,
  ProviderTool,
  ToolResult,
  UpstreamError,
} from "@junction/core"
import { ok, type Result } from "neverthrow"
import { describe, expect, it } from "vitest"
import { runCode } from "./index.js"
import type { ToolInvoker } from "./types.js"

const PRINCIPAL: AuditPrincipal = { kind: "stdio", keyId: null, label: null, profiles: ["default"] }

describe("runCode", () => {
  it("builds a fresh QuickJsExecutor and runs code against the invoker", async () => {
    const sink: AuditSink = { emit: () => {} }
    const invoker: ToolInvoker = {
      listTools: async (): Promise<Result<ProviderTool[], UpstreamError>> => ok([]),
      callTool: async (): Promise<Result<ToolResult, UpstreamError>> => ok({ content: null }),
    }
    const result = await runCode(`return 1 + 1;`, invoker, {
      principal: PRINCIPAL,
      sink,
      profile: "default",
      safeUpstreamMessage: () => "opaque error",
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe(2)
    }
  })

  it("defaults prefixed to false", async () => {
    const sink: AuditSink = { emit: () => {} }
    const invoker: ToolInvoker = {
      listTools: async (): Promise<Result<ProviderTool[], UpstreamError>> =>
        ok([{ name: "github__search", description: "d", inputSchema: {} }]),
      callTool: async (): Promise<Result<ToolResult, UpstreamError>> => ok({ content: "x" }),
    }
    const result = await runCode(`return typeof tools.github.search;`, invoker, {
      principal: PRINCIPAL,
      sink,
      profile: "default",
      safeUpstreamMessage: () => "opaque error",
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk() && result.value.ok) {
      expect(result.value.value).toBe("function")
    }
  })
})
