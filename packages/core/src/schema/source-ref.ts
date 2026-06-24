// SPDX-License-Identifier: AGPL-3.0-only
// SourceRef entity schema — an activated (Platform, Credential) pair inside a Profile.
// Design spec §4 entity shape.

import { z } from "zod"

import { CredentialIdSchema, PlatformIdSchema, ToolNamespaceSchema } from "./primitives.js"

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
})

export type SourceRef = z.infer<typeof SourceRefSchema>
