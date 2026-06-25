// SPDX-License-Identifier: AGPL-3.0-only
// McpConnectionSchema — generic MCP transport descriptor.
// Discriminated union: http (remote URL) or stdio (local command).
// SOURCE-AGNOSTIC: no vendor-specific fields. Connection details are DATA,
// not code (no "if platform === 'github'" anywhere). Design spec §4 + method 10.

import { z } from "zod"

// ---------------------------------------------------------------------------
// McpConnectionSchema
// ---------------------------------------------------------------------------

/**
 * Generic MCP connection descriptor — transport is the discriminant.
 * Meaningful when Platform.kind === "mcp".
 *
 * Two transports cover all MCP sources:
 *   - http  : remote MCP server accessible via URL (e.g. hosted MCP APIs)
 *   - stdio : local MCP server launched as a subprocess (e.g. npx packages)
 *
 * Bearer credentials are injected at call-time (increment B) — not stored here.
 */
export const McpConnectionSchema = z.discriminatedUnion("transport", [
  /**
   * HTTP transport — point junction at any remote MCP URL.
   *
   * auth.header: the HTTP header the bearer token rides in (default "Authorization").
   * This is generic — "Authorization: Bearer <token>" is the common case, but
   * some MCP servers use a custom header (e.g. "X-Api-Token").
   */
  z.object({
    transport: z.literal("http"),
    url: z.string().url(),
    auth: z
      .object({
        scheme: z.literal("bearer"),
        /** HTTP header name that carries the bearer token. Default: "Authorization". */
        header: z.string().min(1).default("Authorization"),
      })
      .optional(),
  }),
  /**
   * Stdio transport — launch an MCP server binary as a child process.
   *
   * command: executable to run (e.g. "npx", "uvx", "/usr/local/bin/my-mcp").
   * args: arguments passed to the command (default []).
   * tokenEnvVar: environment variable the bearer token is injected into (optional).
   */
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Env-var name the bearer token is injected into (e.g. "GITHUB_TOKEN"). */
    tokenEnvVar: z.string().min(1).optional(),
  }),
])

export type McpConnection = z.infer<typeof McpConnectionSchema>
