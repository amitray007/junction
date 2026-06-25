// SPDX-License-Identifier: AGPL-3.0-only

/** @junction/mcp-server — public API. */

export { serveStdio } from "./serve.js"
export type { McpServerHandlers } from "./server.js"
export { createMcpServer, safeUpstreamMessage } from "./server.js"
