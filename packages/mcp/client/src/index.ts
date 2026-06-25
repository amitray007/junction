// SPDX-License-Identifier: AGPL-3.0-only
// @junction/mcp-client public API — narrow barrel.
// SOURCE-AGNOSTIC: generic upstream MCP connector. No vendor code.

export { connectSource } from "./connect.js"
export { splitNamespacedName } from "./helpers.js"
export type { ProfileProxy, ResolvedSource, ResolveSourceFn, SessionFactory } from "./proxy.js"
export { createProfileProxy } from "./proxy.js"
export type { ListToolsResult, NamespacedTool, ToolResult, UpstreamSession } from "./session.js"
