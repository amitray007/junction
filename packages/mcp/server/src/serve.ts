// SPDX-License-Identifier: AGPL-3.0-only
/**
 * serveStdio — connect a per-profile MCP server to stdin/stdout.
 *
 * The process speaks MCP over stdin/stdout until closed. No HTTP transport
 * (SSE is deprecated; streamable HTTP + the long-running daemon are deferred
 * to post-foundation increments).
 *
 * CRITICAL: stdout belongs to the MCP protocol. Nothing may write to stdout
 * except MCP JSON-RPC frames — a single stray line corrupts the stream and
 * breaks every MCP client. Human-readable output goes to stderr only.
 */

import type { Profile } from "@junction/core"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer } from "./server.js"

/**
 * Serve a per-profile MCP server over stdio.
 *
 * Connects the server and awaits transport close (the process runs until the
 * MCP client disconnects or the process is killed). Returns a Promise that
 * resolves when the server closes.
 */
export async function serveStdio(profile: Profile): Promise<void> {
  const server = createMcpServer(profile)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
