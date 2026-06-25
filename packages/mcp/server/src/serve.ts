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
import type { McpServerHandlers } from "./server.js"
import { createMcpServer } from "./server.js"

/**
 * Serve a per-profile MCP server over stdio.
 *
 * Connects the server, then explicitly awaits transport close. The transport
 * closes when the MCP client disconnects (stdin reaches EOF). Wires both
 * transport.onclose and stdin 'end' so the process exits cleanly on either
 * signal — never hangs, never exits prematurely.
 *
 * @param profile  - Profile being served (for server metadata and future audit).
 * @param handlers - Injected tool handlers from the cli composition root.
 */
export async function serveStdio(profile: Profile, handlers: McpServerHandlers): Promise<void> {
  const server = createMcpServer(profile, handlers)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Await explicit close so the caller's await tracks the full session lifetime.
  // transport.onclose fires when the MCP SDK closes the transport (client disconnect);
  // stdin 'end' is a belt-and-suspenders catch for EOF before the SDK fires onclose.
  await new Promise<void>((resolve) => {
    const prev = transport.onclose
    transport.onclose = () => {
      prev?.()
      resolve()
    }
    process.stdin.once("end", resolve)
  })
}
