// SPDX-License-Identifier: AGPL-3.0-only
// The `.jvlt` archive format constants + the decrypted manifest schema — shared by
// export-vault.ts and import-vault.ts so the two never drift. See
// docs/methods/32.4-vault-backup-recovery.md §1.

import { z } from "zod"
import type { DbError } from "../errors/index.js"
import { CredentialKind, CredentialVerifyResult } from "../schema/credential.js"
import { PlatformSchema } from "../schema/platform.js"
import { ProfileSchema } from "../schema/profile.js"

/** Render any DbError kind to a short string — "cause" isn't present on every variant.
 *  Shared by export-vault + import-vault so the mapping never drifts (and never leaks a secret). */
export function describeDbError(e: DbError): string {
  switch (e.kind) {
    case "not-found":
      return `not found: ${e.entity} ${e.id}`
    case "duplicate-namespace":
      return `duplicate namespace: ${e.namespace}`
    default:
      return String(e.cause)
  }
}

/** `"JVLT"` — the 4-byte archive magic. */
export const VAULT_MAGIC = Buffer.from([0x4a, 0x56, 0x4c, 0x54])
export const VAULT_VERSION = 1
/** kdf=1 → scrypt (the foundation params in vault-crypto.ts). */
export const VAULT_KDF = 1

/**
 * `oauthMeta` inside the manifest carries METADATA only — never the *Ref handles
 * (those are source-machine-local store handles, meaningless on the target; see
 * method file §1's "Note the ref-stripping"). The actual secret VALUES ride in the
 * sibling secret/refreshToken/clientId/clientSecret fields.
 */
const ManifestOAuthMetaSchema = z.object({
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().nullable().optional(),
  providerId: z.string().min(1).optional(),
  authMode: z.enum(["authorization_code", "device_code", "client_credentials"]).optional(),
  needsReauth: z.boolean().optional(),
  obtainedAt: z.string().optional(),
})

const ManifestCredentialSchema = z.object({
  platformId: z.string().min(1),
  account: z.string().min(1),
  kind: CredentialKind,
  oauthMeta: ManifestOAuthMetaSchema.optional(),
  lastVerifyResult: CredentialVerifyResult.optional(),
  lastVerifiedAt: z.number().optional(),
  /** The resolved secret VALUE — only ever present inside the encrypted blob. */
  secret: z.string(),
  refreshToken: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  /** Source-machine credential id — used ONLY for the profile route remap on import. */
  _srcId: z.string().min(1),
})

export const VaultManifestSchema = z.object({
  v: z.literal(1),
  exportedAt: z.string(),
  platforms: z.array(PlatformSchema),
  credentials: z.array(ManifestCredentialSchema),
  profiles: z.array(ProfileSchema).optional(),
})

export type VaultManifest = z.infer<typeof VaultManifestSchema>
