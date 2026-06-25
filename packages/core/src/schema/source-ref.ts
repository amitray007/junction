// SPDX-License-Identifier: AGPL-3.0-only
// SourceRef entity schema — an activated (Platform, Credential) pair inside a Profile.
// Design spec §4 entity shape.

import { z } from "zod"

import { CredentialIdSchema, PlatformIdSchema, ToolNamespaceSchema } from "./primitives.js"

// ---------------------------------------------------------------------------
// ToolFilterSchema — generic per-source tool allow/deny list
// ---------------------------------------------------------------------------

/**
 * Optional tool filter applied to this source's upstream tools.
 * Absent means expose all upstream tools (full by default).
 * Applied uniformly in increment C (proxy). No vendor-specific logic.
 *
 * allow: if present, ONLY listed upstream tool names are exposed.
 *   allow present ⇒ only listed tools; allow: [] ⇒ none exposed.
 * deny: these upstream tool names are hidden (applied after allow).
 */
export const ToolFilterSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
})

export type ToolFilter = z.infer<typeof ToolFilterSchema>

// ---------------------------------------------------------------------------
// SourceRefSchema
// ---------------------------------------------------------------------------

export const SourceRefSchema = z.object({
  /** FK → Platform */
  platformId: PlatformIdSchema,
  /** FK → Credential */
  credentialId: CredentialIdSchema,
  /**
   * Collision-free tool namespace for this source within the profile.
   * Convention: lowercase alphanumeric + underscores (^[a-z0-9_]+$).
   * Used to build the double-underscore tool names: `<namespace>__<tool>`.
   * Example: "github_work", "linear_personal"
   */
  toolNamespace: ToolNamespaceSchema,
  /** Whether this source is currently active in the profile */
  enabled: z.boolean(),
  /**
   * Optional generic tool filter — absent means expose all upstream tools.
   * Allow/deny lists are applied uniformly to every source in increment C.
   */
  toolFilter: ToolFilterSchema.optional(),
})

export type SourceRef = z.infer<typeof SourceRefSchema>
