// SPDX-License-Identifier: AGPL-3.0-only
// Credential entity schema — one account's keys for one Platform.
// MANY Credentials per Platform — this is the multi-account wedge.
// Design spec §4 entity shape.

import { z } from "zod"

import { CredentialIdSchema, PlatformIdSchema } from "./primitives.js"

// ---------------------------------------------------------------------------
// CredentialKind
// ---------------------------------------------------------------------------

export const CredentialKind = z.enum(["api-key", "bearer", "oauth2", "file", "env"])
export type CredentialKind = z.infer<typeof CredentialKind>

// ---------------------------------------------------------------------------
// OAuthMetaSchema — reserved slot (OAuth increment fleshes this out)
// ---------------------------------------------------------------------------

/**
 * Minimal reserved slot for OAuth metadata.
 * Present day one so the OAuth increment needs no migration (design spec §4a).
 * The OAuth refresh-loop increment will extend this schema.
 */
export const OAuthMetaSchema = z.object({
  /** Granted OAuth scopes */
  scopes: z.array(z.string()).optional(),
  /** Token expiry as ISO 8601 string, or null if unknown/non-expiring */
  expiresAt: z.string().nullable().optional(),
})

export type OAuthMeta = z.infer<typeof OAuthMetaSchema>

// ---------------------------------------------------------------------------
// CredentialSchema
// ---------------------------------------------------------------------------

export const CredentialSchema = z.object({
  /** Opaque stable credential ID */
  id: CredentialIdSchema,
  /** FK → Platform. Multiple Credentials can share the same platformId (the wedge). */
  platformId: PlatformIdSchema,
  /** Logical account name within a profile, e.g. "work", "personal", "client-acme" */
  profileName: z.string().min(1),
  /** Authentication mechanism kind */
  kind: CredentialKind,
  /**
   * Opaque reference/handle to where the secret lives in the CredentialStore
   * (increment 6 — OS keyring or AES-256-GCM encrypted file).
   *
   * IMPORTANT: this field is a REFERENCE, never the plaintext or ciphertext itself.
   * The main DB row holds this handle; the actual encrypted secret lives separately
   * via the CredentialStore. See docs/rules/security.md and docs/rules/data.md.
   */
  secretRef: z.string().min(1),
  /** Reserved OAuth metadata slot — optional, minimal for now */
  oauthMeta: OAuthMetaSchema.optional(),
})

export type Credential = z.infer<typeof CredentialSchema>
