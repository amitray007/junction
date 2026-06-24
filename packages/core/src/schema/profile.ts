// SPDX-License-Identifier: AGPL-3.0-only
// Profile entity schema — what an agent sees; gets its own MCP endpoint.
// Design spec §4 entity shape.

import { z } from "zod"

import { deriveMcpEndpointPath, ProfileIdSchema, ProfileNameSchema } from "./primitives.js"
import { SourceRefSchema } from "./source-ref.js"

// ---------------------------------------------------------------------------
// ProfileSchema
// ---------------------------------------------------------------------------

export const ProfileSchema = z
  .object({
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
     * The per-profile MCP endpoint path. Convention: /profiles/{name}/mcp.
     * This is the agent-facing routing key, so it MUST equal the path derived
     * from `name` (enforced below). Storing it as an independent string would
     * let it drift to a different profile or a malformed path
     * (e.g. /profiles//mcp, /profiles/a/b/mcp) — the refine closes that hole.
     */
    mcpEndpointPath: z.string(),
  })
  .superRefine((profile, ctx) => {
    // If `name` is itself invalid, the field-level error already fired — skip
    // (and avoid deriveMcpEndpointPath, which throws on an invalid name).
    if (!ProfileNameSchema.safeParse(profile.name).success) return
    const expected = deriveMcpEndpointPath(profile.name)
    if (profile.mcpEndpointPath !== expected) {
      ctx.addIssue({
        code: "custom",
        message: `mcpEndpointPath must be "${expected}" (derived from name "${profile.name}"), got "${profile.mcpEndpointPath}"`,
        path: ["mcpEndpointPath"],
      })
    }
  })

export type Profile = z.infer<typeof ProfileSchema>
