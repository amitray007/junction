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

/** Opaque source-ref identifier. */
export const SourceRefIdSchema = z.string().min(1).brand("SourceRefId")
export type SourceRefId = z.infer<typeof SourceRefIdSchema>

/**
 * Opaque API-key identifier — the Crockford-base32 ULID that doubles as the
 * `keyid` segment of the `jct_<keyid>_<secret>` token (increment 27 §2.1).
 * Constrained to exactly 26 chars of the Crockford b32 alphabet (no I/L/O/U)
 * so the token regex `/^jct_([0-9A-HJKMNP-TV-Z]{26})_(.+)$/` can parse it
 * deterministically — the keyid charset never contains `_`, which is what
 * lets the first two `_` delimiters split the token unambiguously even
 * though base64url secrets may themselves contain `_`.
 */
export const ApiKeyIdSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, {
    message: "ApiKeyId must be a 26-char Crockford-base32 ULID (no I/L/O/U)",
  })
  .brand("ApiKeyId")
export type ApiKeyId = z.infer<typeof ApiKeyIdSchema>

/** API-key label: trimmed, non-empty, ≤64 chars. Duplicates allowed — the
 *  keyid is the stable handle, the label is purely descriptive. */
export const ApiKeyLabelSchema = z
  .string()
  .trim()
  .min(1, { message: "label must be non-empty" })
  .max(64, { message: "label must be ≤64 characters" })
export type ApiKeyLabel = z.infer<typeof ApiKeyLabelSchema>

// ---------------------------------------------------------------------------
// Naming-convention schemas
// ---------------------------------------------------------------------------

/** Tool namespace: lowercase alphanumeric with SINGLE underscores between
 *  segments. Consecutive underscores are forbidden so the `<namespace>__<tool>`
 *  convention (double underscore, design spec §4) splits unambiguously — a
 *  namespace or tool containing `__` would break the split.
 *  Valid: "github_work", "list_issues". Invalid: "a__b", "_x", "x_".
 *
 *  ⚠️ LOAD-BEARING (increment 27): the multi-profile scoped-proxy naming
 *  layer (`sources/scoped-proxy.ts`) prepends `<profileName>__` and splits
 *  the assembled name on the FIRST `__` to recover the profile. That split
 *  is only deterministic because a namespace can never itself contain `__`.
 *  Loosening this schema to allow `__` would make multi-profile tool-name
 *  parsing ambiguous — see the regression test asserting `__` is rejected. */
export const ToolNamespaceSchema = z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, {
  message:
    "must match ^[a-z0-9]+(_[a-z0-9]+)*$ (lowercase/digits, single underscores between segments, no '__')",
})

/** Profile name: URL-safe lowercase alphanumeric + hyphens.
 *  Example: "work", "personal", "client-acme"
 *
 *  ⚠️ LOAD-BEARING (increment 27): the multi-profile scoped-proxy naming
 *  layer prepends `<profileName>__` to tool names for `profiles`/`global`
 *  scoped keys. That charset (`^[a-z0-9-]+$`, no underscore) is what
 *  guarantees a profile name can never contain `_`, so the FIRST `__` in a
 *  `<profileName>__<namespace>__<tool>` name is unambiguously the
 *  profile/namespace boundary. Loosening this schema to allow `_` would
 *  break that parse — see the regression test asserting `_` is rejected. */
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
