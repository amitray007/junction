// SPDX-License-Identifier: AGPL-3.0-only
// Profile entity schema — what an agent sees.
// Design spec §4 entity shape.
//
// SINGLE-ENDPOINT MODEL (increment 27): profiles no longer carry their own MCP
// endpoint path. A single shared `/mcp` endpoint (see mcp/server serve-http.ts)
// authenticates by junction API key; the key's scope selects which profile(s)
// the caller gets. See docs/methods/27-junction-keys-single-endpoint.md §1.

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
   * Validated per ^[a-z0-9-]+$ (no underscores — load-bearing for the
   * multi-profile scoped-proxy `__` naming parse, see primitives.ts).
   */
  name: ProfileNameSchema,
  /** Activated (Platform, Credential) sources available to this profile */
  sources: z.array(SourceRefSchema),
})

export type Profile = z.infer<typeof ProfileSchema>
