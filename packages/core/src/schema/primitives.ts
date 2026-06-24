// SPDX-License-Identifier: AGPL-3.0-only
// Branded ID schemas, tool-namespace / profile-name refinements,
// and the load-bearing naming-convention helpers.
// Per docs/principles/dry.md §3: factor stable primitives immediately.

import { z } from "zod"

// ---------------------------------------------------------------------------
// Branded ID schemas
// ---------------------------------------------------------------------------

/** Opaque platform identifier. Non-empty string — format validation is
 *  deliberately light so that the ULID → uuid swap is a one-file change in ids/. */
export const PlatformIdSchema = z.string().min(1).brand("PlatformId")
export type PlatformId = z.infer<typeof PlatformIdSchema>

/** Opaque credential identifier. */
export const CredentialIdSchema = z.string().min(1).brand("CredentialId")
export type CredentialId = z.infer<typeof CredentialIdSchema>

/** Opaque profile identifier. */
export const ProfileIdSchema = z.string().min(1).brand("ProfileId")
export type ProfileId = z.infer<typeof ProfileIdSchema>

// ---------------------------------------------------------------------------
// Naming-convention schemas
// ---------------------------------------------------------------------------

/** Tool namespace: lowercase alphanumeric with SINGLE underscores between
 *  segments. Consecutive underscores are forbidden so the `<namespace>__<tool>`
 *  convention (double underscore, design spec §4) splits unambiguously — a
 *  namespace or tool containing `__` would break the split.
 *  Valid: "github_work", "list_issues". Invalid: "a__b", "_x", "x_". */
export const ToolNamespaceSchema = z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, {
  message:
    "must match ^[a-z0-9]+(_[a-z0-9]+)*$ (lowercase/digits, single underscores between segments, no '__')",
})

/** Profile name: URL-safe lowercase alphanumeric + hyphens.
 *  Validated per the `/profiles/{name}/mcp` endpoint convention.
 *  Example: "work", "personal", "client-acme" */
export const ProfileNameSchema = z.string().regex(/^[a-z0-9-]+$/, {
  message: "profileName must match ^[a-z0-9-]+$ (lowercase, digits, hyphens only)",
})

// ---------------------------------------------------------------------------
// Convention helpers — renaming these later breaks every agent prompt
// ---------------------------------------------------------------------------

/**
 * Build a namespaced tool name from a namespace and tool name.
 * Convention: `<namespace>__<tool>` (double underscore, design spec §4).
 *
 * Both parts must match ToolNamespaceSchema (^[a-z0-9_]+$, which forbids the
 * `__` separator inside either part). If `tool` could itself contain `__`, the
 * split would be ambiguous for any parser that later splits on `__`.
 *
 * @throws {Error} if namespace OR tool is not valid per ToolNamespaceSchema
 */
export function namespacedTool(namespace: string, tool: string): string {
  for (const [label, value] of [
    ["namespace", namespace],
    ["tool", tool],
  ] as const) {
    const result = ToolNamespaceSchema.safeParse(value)
    if (!result.success) {
      throw new Error(
        `Invalid tool ${label} "${value}": ${result.error.issues.map((i) => i.message).join(", ")}`,
      )
    }
  }
  return `${namespace}__${tool}`
}

/**
 * Derive the per-profile MCP endpoint path from a profile name.
 * Convention: `/profiles/{name}/mcp` (design spec §4).
 *
 * @throws {Error} if profileName is not valid per ProfileNameSchema
 */
export function deriveMcpEndpointPath(profileName: string): string {
  const result = ProfileNameSchema.safeParse(profileName)
  if (!result.success) {
    throw new Error(
      `Invalid profile name "${profileName}": ${result.error.issues.map((i) => i.message).join(", ")}`,
    )
  }
  return `/profiles/${profileName}/mcp`
}
