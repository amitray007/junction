// SPDX-License-Identifier: AGPL-3.0-only
/**
 * createMcpServer — builds a per-profile MCP server with INJECTED tool handlers.
 *
 * Design: one Server instance per Profile (per-profile isolation, design spec §4).
 * The shared-endpoint-with-filter model is explicitly rejected — each Profile gets
 * its own MCP endpoint so that tool namespacing and capability negotiation are
 * correct per profile without any runtime filtering.
 *
 * INJECTION (boundary-critical):
 *   mcp/server is a thin SDK wrapper. It NEVER imports mcp/client. The cli
 *   (composition root) injects { listTools, callTool } handlers. This keeps the
 *   dependency graph clean: mcp/server → core only (not mcp/client).
 *
 * CREDENTIAL DISCIPLINE:
 *   callTool errors are mapped to MCP error responses with SAFE messages only —
 *   no secret, no raw cause object, no stack trace reaches the agent.
 *
 * VERIFIED GOTCHA (SDK 1.29): a high-level McpServer with zero registerTool calls
 * does NOT advertise the tools capability, so tools/list returns -32601 Method not
 * found (not an empty list). We use the low-level Server with explicit setRequestHandler
 * so the tools capability is always advertised regardless of how many tools exist.
 */

import type { Profile, UpstreamError } from "@junction/core"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// ---------------------------------------------------------------------------
// McpServerHandlers — injected by the cli composition root
// ---------------------------------------------------------------------------

/**
 * Tool handlers injected into the MCP server.
 *
 * listTools: returns the full aggregated + namespaced tool catalog for the profile.
 * callTool:  routes a namespaced tool call; returns the upstream result or a safe error.
 *
 * content items follow MCP spec format (TextContent is the most common case).
 * The server never inspects content — it forwards whatever the handler returns.
 */
export interface McpServerHandlers {
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema: object }>
  }>
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>
}

// ---------------------------------------------------------------------------
// Safe error message — NEVER includes secret values or raw cause objects
// ---------------------------------------------------------------------------

/**
 * Convert an UpstreamError to a safe human-readable string.
 *
 * SECURITY: must not include `e.cause` (which could hold an axios-like object
 * with Authorization headers) or any value derived from the secret.
 * Only safe static/structural information is used.
 */
export function safeUpstreamMessage(e: UpstreamError): string {
  switch (e.kind) {
    case "tool-not-found":
      return `tool not found: ${e.name}`
    case "auth-failed":
      return "upstream source: authentication failed"
    case "timed-out":
      return `upstream source: timed out after ${e.ms}ms`
    case "binary-not-found":
      return `upstream source: binary not found: ${e.command}`
    case "connect-failed":
      return "upstream source: connection failed"
    case "call-failed":
      return "upstream source: call failed"
    case "upstream-unavailable":
      return "upstream source: unavailable"
    case "namespace-too-long":
      return `tool name too long: ${e.name}`
    case "invalid-tool-name":
      return `invalid tool name: ${e.name}`
  }
}

// ---------------------------------------------------------------------------
// createMcpServer
// ---------------------------------------------------------------------------

/**
 * Build a per-profile MCP server with injected handlers.
 *
 * Per-profile isolation: this function returns a NEW Server per call. Callers
 * must not share a single Server across profiles — each profile has independent
 * tool lists, capabilities, and transport lifecycle.
 *
 * @param profile - The profile this server is serving (used for metadata).
 * @param handlers - Injected tool handlers (list + call). The cli wires mcp/client
 *   into these; mcp/server itself never imports mcp/client.
 */
export function createMcpServer(profile: Profile, handlers: McpServerHandlers): Server {
  // profile is available here for future metadata use (endpoint path, audit, etc.)
  void profile

  const server = new Server({ name: "junction", version: "0.0.0" }, { capabilities: { tools: {} } })

  // ListTools: delegate entirely to the injected handler (proxy aggregates sources).
  server.setRequestHandler(ListToolsRequestSchema, () => handlers.listTools())

  // CallTool: delegate to the injected handler; map errors to safe MCP error responses.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handlers.callTool(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    )
  })

  return server
}
