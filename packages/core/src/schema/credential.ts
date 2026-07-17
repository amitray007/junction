// SPDX-License-Identifier: AGPL-3.0-only
// Credential entity schema — one account's keys for one Platform.
// MANY Credentials per Platform — this is the multi-account wedge.
// Design spec §4 entity shape.

import { z } from "zod"

import { CredentialIdSchema, PlatformIdSchema } from "./primitives.js"

// ---------------------------------------------------------------------------
// CredentialName — the credential's SOLE identity (increment 42, Phase 1 of
// docs/specs/2026-07-17-credential-platform-normalization.md). Lowercase slug,
// globally unique across ALL credentials (linked or not). No `_`/`__` contract
// here — credential names never enter tool namespaces (those come from
// profile/source wiring, see primitives.ts's ToolNamespaceSchema).
// ---------------------------------------------------------------------------

export const CredentialNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message:
    "name must match ^[a-z0-9][a-z0-9-]*$ (lowercase, digits, hyphens; must start alphanumeric)",
})
export type CredentialName = z.infer<typeof CredentialNameSchema>

// ---------------------------------------------------------------------------
// CredentialKind
// ---------------------------------------------------------------------------

export const CredentialKind = z.enum(["api-key", "bearer", "oauth2", "file", "env"])
export type CredentialKind = z.infer<typeof CredentialKind>

// ---------------------------------------------------------------------------
// OAuthMetaSchema — reserved slot (OAuth increment fleshes this out)
// ---------------------------------------------------------------------------

/**
 * OAuth metadata for a credential (increment 29 — the OAuth vault).
 * Present day one so the OAuth increment needs no migration (design spec §4a);
 * extended here with the fields the connect/refresh flows populate.
 *
 * INVARIANT: every field here is metadata or a REFERENCE — never a token value.
 * `refreshTokenRef` / `clientIdRef` / `clientSecretRef` are handles resolving
 * through the CredentialStore, exactly like `Credential.secretRef` — NEVER the
 * raw refresh token or a raw client_secret. The access token stays in the
 * credential's existing `secretRef`. Same secrets-as-references rule as
 * `Credential.secretRef` (docs/rules/security.md). All fields are optional so
 * old rows still parse — additive, no migration (z.object strips unknowns).
 */
export const OAuthMetaSchema = z.object({
  /** Granted OAuth scopes */
  scopes: z.array(z.string()).optional(),
  /** Token expiry as ISO 8601 string, or null if unknown/non-expiring */
  expiresAt: z.string().nullable().optional(),
  // --- inc 29 additive ---
  /** Second minted ULID ref → the refresh token in the CredentialStore. NEVER the raw token. */
  refreshTokenRef: z.string().min(1).optional(),
  /** Catalog provider key, e.g. "google" | "github" | "slack" | "generic" */
  providerId: z.string().min(1).optional(),
  /** How this credential was obtained / is refreshed */
  authMode: z.enum(["authorization_code", "device_code", "client_credentials"]).optional(),
  /** BYO client credentials, stored as refs (the client_secret is a secret). */
  clientIdRef: z.string().min(1).optional(),
  clientSecretRef: z.string().min(1).optional(),
  /** First-class re-auth state (surfaced as Reconnect everywhere). */
  needsReauth: z.boolean().optional(),
  /** ISO 8601 timestamp the tokens were obtained. */
  obtainedAt: z.string().optional(),
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
  /**
   * The credential's SOLE identity (increment 42 — Phase 1 of
   * docs/specs/2026-07-17-credential-platform-normalization.md). Lowercase
   * slug, globally UNIQUE across every credential (linked or not). Shown
   * everywhere a credential is referenced (CLI `--credential`, web list,
   * agent-facing displays). Required on every create path — see
   * `deriveCredentialName` for paths that don't take a user-supplied name
   * (OAuth connect, catalog connect, legacy CLI `--account`).
   */
  name: CredentialNameSchema,
  /**
   * FK → Platform. Multiple Credentials can share the same platformId (the
   * wedge). NULLABLE as of increment 42 — a credential no longer requires a
   * platform to exist (a standalone vault secret). Carries NO uniqueness role
   * (identity lives entirely in `name`).
   */
  platformId: PlatformIdSchema.nullable(),
  /**
   * @deprecated Increment 42 — vestigial, WRITE-ONLY legacy column. The OAuth
   * connect flow still writes it (Phase 1 leaves OAuth untouched), but
   * nothing NEW may read it for identity or uniqueness — use `name`
   * exclusively. Phase 3 (docs/specs/2026-07-17-credential-platform-
   * normalization.md) physically drops this column.
   */
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
