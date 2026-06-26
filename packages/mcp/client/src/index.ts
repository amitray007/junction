// SPDX-License-Identifier: AGPL-3.0-only
// @junction/mcp-client public API — narrow barrel.
// SOURCE-AGNOSTIC: generic upstream MCP connector. No vendor code.
//
// NOTE (increment 14): createProfileProxy, namespaceToolName / splitNamespacedName,
// ProfileProxy, ResolveProviderFn, and ToolResult have moved to @junction/core.
// The proxy and naming helpers are now source-agnostic and live in core/src/sources/.

export { connectSource } from "./connect.js"
export { createMcpProvider } from "./provider.js"
export type { UpstreamSession } from "./session.js"
