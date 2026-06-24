// SPDX-License-Identifier: AGPL-3.0-only
// Profile entity schema — what an agent sees; gets its own MCP endpoint.
// Design spec §4 entity shape.

import { z } from "zod"

import { ProfileIdSchema, ProfileNameSchema } from "./primitives.js"
import { SourceRefSchema } from "./source-ref.js"

// ---------------------------------------------------------------------------
// ProfileSchema
// ---------------------------------------------------------------------------

export const ProfileSchema = z.object({
  /** Opaque stable profile ID */
  id: ProfileIdSchema,
  /**
   * URL-safe profile name, e.g. "work", "personal", "client-acme".
   * Validated per ^[a-z0-9-]+$ — used in the MCP endpoint path.
   */
  name: ProfileNameSchema,
  /** Activated (Platform, Credential) sources available to this profile */
  sources: z.array(SourceRefSchema),
  /**
   * The per-profile MCP endpoint path.
   * Convention: /profiles/{name}/mcp (design spec §4).
   * Validated to start with /profiles/ and end with /mcp.
   */
  mcpEndpointPath: z
    .string()
    .startsWith("/profiles/", { message: 'mcpEndpointPath must start with "/profiles/"' })
    .endsWith("/mcp", { message: 'mcpEndpointPath must end with "/mcp"' }),
})

export type Profile = z.infer<typeof ProfileSchema>
