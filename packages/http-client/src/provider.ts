// SPDX-License-Identifier: AGPL-3.0-only
// provider.ts — createHttpProvider: operator-declared REST request-tools as a
// ToolProvider. The REST twin of the `cli` surface (core/sources/cli/provider.ts):
// operator declares tools[], one tool = one MCP tool, pre-built at construction.
// Request execution reuses @junction/openapi-client's shared binding engine
// (buildAndExecuteRequest) — see docs/methods/30.7-http-surface.md §2 for the
// binding factoring decision. SOURCE-AGNOSTIC: no vendor-specific code.
//
// SECRET DISCIPLINE: `secret` is passed straight through to
// buildAndExecuteRequest, which injects it ONLY into the outbound HTTP
// request (never stored on the provider, never in results/logs).

import type { HttpConnection, HttpRequestTool, ProviderTool, ToolProvider } from "@junction/core"
import { buildAndExecuteRequest, DEFAULT_TIMEOUT_MS } from "@junction/openapi-client"
import { errAsync, okAsync } from "neverthrow"
import { validateHttpArgs } from "./args.js"
import { buildHttpInputSchema } from "./tools.js"

/**
 * Create a ToolProvider backed by operator-declared REST request-tools.
 *
 * @param connection  The validated HttpConnection descriptor (operator-declared tools).
 * @param secret      Resolved credential secret (plain string), or null for
 *                    public/no-auth tools — matches the openapi/graphql shape.
 *
 * listTools: pre-built at construction, one ProviderTool per declared tool.
 * callTool: resolve tool by name → validate agent args → bind + execute via
 *           the shared openapi-client request engine → ToolResult.
 * close: stateless HTTP — no-op.
 */
export function createHttpProvider(
  connection: HttpConnection,
  secret: string | null,
): ToolProvider {
  // Build a name→tool lookup once at construction time.
  const byName = new Map<string, HttpRequestTool>()
  for (const tool of connection.tools) {
    byName.set(tool.name, tool)
  }

  // Pre-build ProviderTool descriptors (stable across calls — listTools is pure).
  const providerTools: ProviderTool[] = connection.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: buildHttpInputSchema(tool),
  }))

  return {
    listTools() {
      return okAsync(providerTools)
    },

    callTool(rawName, rawArgs) {
      const tool = byName.get(rawName)
      if (!tool) {
        return errAsync({ kind: "tool-not-found", name: rawName })
      }

      const argsResult = validateHttpArgs(tool.params, rawArgs)
      if (argsResult.isErr()) {
        return errAsync(argsResult.error)
      }
      const validatedArgs = argsResult.value

      // The one in:"body" param (if declared) carries the JSON body value —
      // the operator names it; buildAndExecuteRequest reads it via bodyArgKey
      // rather than a hardcoded "body" key (that's OpenAPI's convention, not
      // http-client's — the operator's param name is the contract here).
      const bodyParam = tool.params.find((p) => p.in === "body")

      return buildAndExecuteRequest({
        baseUrl: connection.baseUrl,
        method: tool.method,
        pathTemplate: tool.path,
        params: tool.params.map((p) => ({ name: p.name, in: p.in, required: p.required })),
        auth: connection.auth,
        secret,
        defaultHeaders: connection.defaultHeaders,
        args: validatedArgs,
        timeoutMs: tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(bodyParam ? { bodyArgKey: bodyParam.name } : {}),
      })
    },

    async close(): Promise<void> {
      // Stateless HTTP — nothing to close.
    },
  }
}
