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
 *
 * INVARIANT: every field here is metadata or a REFERENCE — never a token value.
 * When the OAuth increment adds a refresh-token field, it MUST be a handle
 * (e.g. `refreshTokenRef: string` resolving through the CredentialStore /
 * token table), NOT the raw refresh token. Same secrets-as-references rule as
 * `Credential.secretRef` (docs/rules/security.md). Adding optional fields here
 * is additive/non-breaking (z.object strips unknowns).
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

/**
 * Persisted verify-on-add / test-connection outcome (migration 0008).
 * "not-verifiable" is deliberately NOT a member here — that outcome is a
 * property of the platform/source kind, not a persisted event; it's never
 * written to lastVerifyResult (see source-runtime's verifyCredential).
 */
export const CredentialVerifyResult = z.enum(["ok", "auth-failed", "unreachable"])
export type CredentialVerifyResult = z.infer<typeof CredentialVerifyResult>

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
  /**
   * Ms-epoch timestamp of the last verify-on-add / test-connection attempt.
   * Absent = never verified. Set together with lastVerifyResult.
   */
  lastVerifiedAt: z.number().optional(),
  /** Outcome of the last verify attempt. Absent = never verified. */
  lastVerifyResult: CredentialVerifyResult.optional(),
})

export type Credential = z.infer<typeof CredentialSchema>
