// SPDX-License-Identifier: AGPL-3.0-only
// adaptToMcpHandlers — ResultAsync proxy → Promise-based McpServerHandlers.
//
// This stays in cli (not @junction/source-runtime): it bridges a core proxy
// to the McpServerHandlers shape, a serving composition-root concern that
// needs @junction/mcp-server. Keeping it here keeps source-runtime free of an
// mcp-server edge — see docs/methods/28-web-probe-call.md, "Boundary note —
// why adaptToMcpHandlers stays in cli".
//
// buildProvider / resolveCredentialSecret / makeResolveProvider moved to
// @junction/source-runtime (increment 28) — import them from there.

import type { ResultAsync, UpstreamError } from "@junction/core"
import type { McpServerHandlers } from "@junction/mcp-server"

// ---------------------------------------------------------------------------
// adaptToMcpHandlers — ResultAsync proxy → Promise-based McpServerHandlers
// ---------------------------------------------------------------------------

/**
 * Adapt a core proxy (ProfileProxy or ScopedProxy — both ResultAsync-based)
 * to McpServerHandlers (Promise-based), the shape createMcpServer / serveStdio
 * / serveHttp expect.
 *
 * Shared between `junction mcp serve` (wraps a single ProfileProxy) and
 * `junction serve` (wraps a ScopedProxy over multiple profiles) — both need
 * the identical Result→Promise unwrap plus the safe-error-message mapping on
 * callTool. `safeUpstreamMessage` is lazy-imported (mirrors the mcp-server
 * import pattern already used at each call site) so cli commands that never
 * hit this path don't pay for it.
 *
 * SECURITY: callTool's error path renders via safeUpstreamMessage — NO
 * secret value is ever placed in the response.
 */
export function adaptToMcpHandlers(proxy: {
  listTools: () => ResultAsync<
    Array<{ name: string; description?: string; inputSchema: object }>,
    UpstreamError
  >
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => ResultAsync<{ content: unknown; isError?: boolean }, UpstreamError>
}): McpServerHandlers {
  return {
    async listTools() {
      const result = await proxy.listTools()
      // listTools always Ok (per-source resilience); if somehow Err, return empty.
      if (result.isErr())
        return { tools: [] as Array<{ name: string; description?: string; inputSchema: object }> }
      return { tools: result.value }
    },
    async callTool(name: string, callArgs: Record<string, unknown>) {
      const result = await proxy.callTool(name, callArgs)
      if (result.isErr()) {
        // Map to a safe MCP error response — NO secret in the message.
        const { safeUpstreamMessage } = await import("@junction/mcp-server")
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: safeUpstreamMessage(result.error) }],
        }
      }
      // Forward the upstream result. Content comes from the upstream MCP server
      // (data, not secrets). isError reflects whether the upstream flagged an error.
      return {
        content: result.value.content as Array<{ type: "text"; text: string }>,
        isError: result.value.isError,
      }
    },
  }
}
