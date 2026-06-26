// SPDX-License-Identifier: AGPL-3.0-only
// Platform entity schema — a supported external system, exists once in the catalog.
// Design spec §4 entity shape.

import { z } from "zod"

import { GraphQlConnectionSchema } from "./graphql-connection.js"
import { McpConnectionSchema } from "./mcp-connection.js"
import { OpenApiConnectionSchema } from "./openapi-connection.js"
import { PlatformIdSchema } from "./primitives.js"

// ---------------------------------------------------------------------------
// PlatformKind
// ---------------------------------------------------------------------------

export const PlatformKind = z.enum(["mcp", "openapi", "graphql", "cli", "custom"])
export type PlatformKind = z.infer<typeof PlatformKind>

// ---------------------------------------------------------------------------
// PlatformSchema
// ---------------------------------------------------------------------------

export const PlatformSchema = z.object({
  /** Opaque stable platform ID, e.g. "github", "linear", "openapi:acme" */
  id: PlatformIdSchema,
  /** Integration kind — drives how junction connects to the platform */
  kind: PlatformKind,
  /** Human-readable name shown in the UI */
  displayName: z.string().min(1),
  /** OpenAPI / GraphQL / MCP discovery document URL (optional) */
  specUrl: z.string().url().optional(),
  /** Self-hosted instance base URL override (optional) */
  baseUrl: z.string().url().optional(),
  /**
   * Generic MCP connection descriptor — transport (http or stdio) + params.
   * Meaningful when kind === "mcp". No vendor-specific fields:
   * connection details are DATA in this row, not code.
   */
  connection: McpConnectionSchema.optional(),
  /**
   * Generic OpenAPI/REST connection descriptor.
   * Meaningful when kind === "openapi". No vendor-specific fields.
   */
  openapi: OpenApiConnectionSchema.optional(),
  /**
   * Generic GraphQL connection descriptor.
   * Meaningful when kind === "graphql". No vendor-specific fields.
   */
  graphql: GraphQlConnectionSchema.optional(),
})

export type Platform = z.infer<typeof PlatformSchema>
