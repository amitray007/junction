// SPDX-License-Identifier: AGPL-3.0-only
// createMcpProvider — adapt connectSource + UpstreamSession to the ToolProvider interface.
//
// Returns a ResultAsync<ToolProvider> so the connection happens eagerly (inside
// resolveProvider in the cli). The proxy then calls listTools / callTool on the
// connected provider and closes it in a finally block (connect-per-call lifecycle).
//
// RAW NAMES: the ToolProvider exposes raw upstream names. Namespacing, ≤64-guard,
// and toolFilter enforcement are handled by core/src/sources/proxy.ts.
//
// SECRET DISCIPLINE: the secret is passed to connectSource which injects it only
// into the transport. It is never stored on the ToolProvider or returned in any output.
//
// SOURCE-AGNOSTIC: zero vendor code. McpConnection is generic data.

import type { McpConnection, ToolProvider, UpstreamError } from "@junction/core"
import type { ResultAsync } from "neverthrow"
import { connectSource } from "./connect.js"

/**
 * Build a ToolProvider for a single MCP source.
 *
 * Connects to the upstream (via connectSource) and wraps the resulting
 * UpstreamSession as a ToolProvider. The provider holds an open session;
 * call provider.close() when done (the proxy does this in a finally block).
 *
 * @param connection - Generic MCP transport descriptor (http | stdio).
 * @param secret - Resolved plaintext credential, or null if not needed.
 */
export function createMcpProvider(
  connection: McpConnection,
  secret: string | null,
): ResultAsync<ToolProvider, UpstreamError> {
  return connectSource(connection, secret).map((session) => ({
    listTools() {
      return session.listTools()
    },
    callTool(rawName: string, args: Record<string, unknown>) {
      return session.callTool(rawName, args)
    },
    async close(): Promise<void> {
      await session.close()
    },
  }))
}
