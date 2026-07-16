// SPDX-License-Identifier: AGPL-3.0-only
// ToolProvider — source-agnostic interface for any tool-providing backend.
//
// Providers return RAW (un-namespaced) tool names. Namespacing, the ≤64 guard,
// and toolFilter enforcement live in the core proxy — one enforcement point,
// identical treatment for every source type (MCP now, OpenAPI/GraphQL later).
//
// SOURCE-AGNOSTIC: zero vendor code; no transport, no HTTP, no fs.*Sync.

import type { UpstreamError } from "../errors/index.js"
import type { ResultAsync } from "../result/index.js"

// ---------------------------------------------------------------------------
// ProviderTool — raw upstream tool descriptor
// ---------------------------------------------------------------------------

/**
 * MCP tool annotations — behavioral hints surfaced to the calling agent/client.
 * Optional; a provider that has nothing to declare simply omits the field.
 *
 * NOTE (increment 41.3): this field is populated by the CLI full-access
 * provider's `execute`/`help` tools (docs/specs/2026-07-16-cli-exploratory-mode.md
 * §5 Q2), but is not yet forwarded end-to-end — mcp/client's session.ts
 * `listTools` mapping and mcp/server's `ListToolsRequestSchema` handler still
 * project only `{ name, description, inputSchema }` (see proxy.ts's
 * `hashToolIdentity` comment: the pin hash must grow to cover `annotations`
 * the same change that starts forwarding it end-to-end).
 */
export interface ProviderToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
}

/** A single tool as returned by an upstream source. name is RAW (un-namespaced). */
export interface ProviderTool {
  name: string
  description?: string | undefined
  inputSchema: object
  annotations?: ProviderToolAnnotations | undefined
}

// ---------------------------------------------------------------------------
// ToolResult — upstream call result
// ---------------------------------------------------------------------------

/** Result of calling an upstream tool. content follows MCP spec format. */
export interface ToolResult {
  content: unknown
  isError?: boolean | undefined
}

// ---------------------------------------------------------------------------
// ToolProvider — the source-agnostic interface
// ---------------------------------------------------------------------------

/**
 * Source-agnostic tool provider.
 *
 * Implementations must:
 *   - listTools: return RAW upstream tool names (no namespacing, no ≤64 guard).
 *   - callTool: accept the RAW upstream name (stripped by the proxy before dispatch).
 *   - close: release the connection. The proxy calls this in a finally block.
 *
 * The proxy (core/src/sources/proxy.ts) applies namespacing, ≤64-guard, and
 * toolFilter on top of whatever listTools/callTool return.
 */
export interface ToolProvider {
  listTools(): ResultAsync<ProviderTool[], UpstreamError>
  callTool(rawName: string, args: Record<string, unknown>): ResultAsync<ToolResult, UpstreamError>
  close(): Promise<void>
}
