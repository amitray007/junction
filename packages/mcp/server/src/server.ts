// SPDX-License-Identifier: AGPL-3.0-only
/**
 * createMcpServer — builds a per-profile MCP server (low-level Server API).
 *
 * Design: one Server instance per Profile (per-profile isolation, design spec §4).
 * The shared-endpoint-with-filter model is explicitly rejected — each Profile gets
 * its own MCP endpoint so that tool namespacing and capability negotiation are
 * correct per profile without any runtime filtering.
 *
 * VERIFIED GOTCHA (SDK 1.29): a high-level McpServer with zero registerTool calls
 * does NOT advertise the tools capability, so tools/list returns -32601 Method not
 * found (not an empty list). Passing capabilities:{tools:{}} to McpServer does not
 * fix it. We use the low-level Server with an explicit setRequestHandler to always
 * serve a profile-driven tool list — empty now, real tools later.
 */

import type { Profile } from "@junction/core"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

/**
 * Derive the list of MCP tools for a Profile.
 *
 * Returns [] this increment (zero sources connected). Future tools MUST use the
 * `<namespace>__<tool>` naming convention (double underscore, design spec §4) via
 * `core.namespacedTool(sourceRef.toolNamespace, toolName)`. Adding a tool here
 * without that convention would break every agent prompt that parses on "__".
 */
function deriveToolsFromProfile(
  _profile: Profile,
): Array<{ name: string; description?: string; inputSchema: object }> {
  // Increment 7 shell: zero sources → zero tools.
  // When real SourceRefs exist, iterate profile.sources and map each platform's
  // tool descriptors through namespacedTool(sourceRef.toolNamespace, toolName).
  return []
}

/**
 * Build a per-profile MCP server.
 *
 * Per-profile isolation: this function returns a NEW Server per call. Callers
 * must not share a single Server across profiles — each profile has independent
 * tool lists, capabilities, and transport lifecycle.
 */
export function createMcpServer(profile: Profile): Server {
  const server = new Server({ name: "junction", version: "0.0.0" }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return Promise.resolve({ tools: deriveToolsFromProfile(profile) })
  })

  return server
}
