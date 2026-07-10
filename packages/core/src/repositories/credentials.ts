// SPDX-License-Identifier: AGPL-3.0-only
// Credentials repository — CRUD + forPlatform (the multi-account wedge).
// dry.md: no generic base. security.md: only secret_ref stored, never plaintext.
// better-sqlite3 is sync; we present an async API for libsql-swap safety.

import { eq } from "drizzle-orm"
import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { mapDbError } from "../db/errors.js"
import type { Db } from "../db/index.js"
import { credentials } from "../db/schema.js"
import type { DbError } from "../errors/index.js"
import type { Credential, CredentialVerifyResult, OAuthMeta } from "../schema/credential.js"
import { CredentialSchema, OAuthMetaSchema } from "../schema/credential.js"
import type { PlatformId } from "../schema/primitives.js"

/**
 * Fetch a credential row by id, or a typed not-found error. Shared by every
 * method that must read-before-write (setSecretRef, setVerifyState) or that
 * simply reads one row (get) — the rule-of-three point where this earns
 * extraction (docs/principles/dry.md).
 */
function fetchRowOrNotFound(
  db: Db,
  id: string,
): { ok: true; row: typeof credentials.$inferSelect } | { ok: false; error: DbError } {
  const row = db.select().from(credentials).where(eq(credentials.id, id)).get()
  if (!row) return { ok: false, error: { kind: "not-found" as const, entity: "credential", id } }
  return { ok: true, row }
}

function rowToCredential(row: typeof credentials.$inferSelect): Credential {
  return CredentialSchema.parse({
    id: row.id,
    platformId: row.platformId,
    profileName: row.profileName,
    kind: row.kind,
    secretRef: row.secretRef,
    oauthMeta: row.oauthMeta
      ? OAuthMetaSchema.parse(JSON.parse(row.oauthMeta) as unknown)
      : undefined,
    lastVerifiedAt: row.lastVerifiedAt ?? undefined,
    lastVerifyResult: row.lastVerifyResult ?? undefined,
  })
}

export function createCredentialsRepo(db: Db) {
  return {
    create(input: Credential): ResultAsync<Credential, DbError> {
      try {
        const validated = CredentialSchema.parse(input)
        db.insert(credentials)
          .values({
            id: validated.id,
            platformId: validated.platformId,
            profileName: validated.profileName,
            kind: validated.kind,
            secretRef: validated.secretRef,
            oauthMeta: validated.oauthMeta ? JSON.stringify(validated.oauthMeta) : null,
          })
          .run()
        return okAsync(validated)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    get(id: string): ResultAsync<Credential, DbError> {
      try {
        const found = fetchRowOrNotFound(db, id)
        if (!found.ok) return errAsync(found.error)
        return okAsync(rowToCredential(found.row))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    forPlatform(platformId: PlatformId): ResultAsync<Credential[], DbError> {
      try {
        const rows = db
          .select()
          .from(credentials)
          .where(eq(credentials.platformId, platformId))
          .all()
        return okAsync(rows.map(rowToCredential))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    list(): ResultAsync<Credential[], DbError> {
      try {
        const rows = db.select().from(credentials).all()
        return okAsync(rows.map(rowToCredential))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Update a credential row's secretRef (used by rotateCredential).
     * Only the secretRef column is modified; id, platformId, profileName, and kind
     * are immutable through this path.
     */
    setSecretRef(id: string, newSecretRef: string): ResultAsync<Credential, DbError> {
      try {
        // Fetch first so we can return the full updated Credential (and surface not-found).
        const found = fetchRowOrNotFound(db, id)
        if (!found.ok) return errAsync(found.error)
        db.update(credentials).set({ secretRef: newSecretRef }).where(eq(credentials.id, id)).run()
        return okAsync(rowToCredential({ ...found.row, secretRef: newSecretRef }))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Update a credential row's profileName (the account label) in place — used
     * by renameCredential. Only the profileName column is modified; id,
     * platformId, kind, secretRef, and oauthMeta are untouched. Read-before-write
     * so a not-found surfaces (and the full updated Credential is returned).
     */
    setProfileName(id: string, newProfileName: string): ResultAsync<Credential, DbError> {
      try {
        const found = fetchRowOrNotFound(db, id)
        if (!found.ok) return errAsync(found.error)
        db.update(credentials)
          .set({ profileName: newProfileName })
          .where(eq(credentials.id, id))
          .run()
        return okAsync(rowToCredential({ ...found.row, profileName: newProfileName }))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    delete(id: string): ResultAsync<void, DbError> {
      try {
        const result = db.delete(credentials).where(eq(credentials.id, id)).run()
        // changes === 0 means no row matched — surface as typed not-found rather
        // than silently returning Ok (32.13 Slice E1 — mirrors platforms.delete).
        if (result.changes === 0) {
          return errAsync({ kind: "not-found" as const, entity: "credential", id })
        }
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Record a verify-on-add / test-connection outcome. Only "ok" | "auth-failed" |
     * "unreachable" are persisted — "not-verifiable" is a property of the platform/
     * source kind, not an event, and is never written here (see VerifyOutcome in
     * @junction/source-runtime).
     */
    setVerifyState(
      id: string,
      result: CredentialVerifyResult,
      at: number,
    ): ResultAsync<void, DbError> {
      try {
        const found = fetchRowOrNotFound(db, id)
        if (!found.ok) return errAsync(found.error)
        db.update(credentials)
          .set({ lastVerifiedAt: at, lastVerifyResult: result })
          .where(eq(credentials.id, id))
          .run()
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Atomic write of the OAuth token refs + expiry into `oauth_meta` (inc 29 —
     * the OAuth vault). Merges the patch onto the EXISTING oauthMeta — it does
     * NOT clobber unrelated fields.
     *
     * CONTRACT: an ABSENT key OR an explicit `undefined` value both retain the
     * prior value (a no-op for that field) — pass `null` (for the nullable
     * `expiresAt`) to actually clear it. This is NOT a `"key" in patch`
     * presence check: a caller building a patch via conditional spread (e.g.
     * `{ refreshTokenRef: rotated ? mint(newToken) : undefined }` — the exact
     * shape A2's refresh engine uses when a provider doesn't rotate the
     * refresh token) would have the key PRESENT with value `undefined`; a
     * presence check would then write `undefined`, which
     * `OAuthMetaSchema.parse` + `JSON.stringify` silently DROP — wiping a
     * live refresh ref and orphaning its secret in the store. Checking
     * `!== undefined` instead correctly admits `null` and `false` (the two
     * other meaningful non-omission values: `expiresAt: null` = non-expiring,
     * `needsReauth: false` = re-auth cleared) while treating `undefined` as
     * "don't touch this field."
     *
     * `secretRef` (the access token) is a COLUMN, not part of oauthMeta — when
     * present (and not undefined) in the patch it repoints the credential's
     * secretRef column, mirroring `setSecretRef`. Every other field merges
     * into the `oauth_meta` JSON blob.
     */
    setOAuthTokens(
      id: string,
      patch: {
        secretRef?: string
        refreshTokenRef?: string
        expiresAt?: string | null
        scopes?: string[]
        needsReauth?: boolean
        obtainedAt?: string
        providerId?: string
        authMode?: OAuthMeta["authMode"]
        clientIdRef?: string
        clientSecretRef?: string
      },
    ): ResultAsync<Credential, DbError> {
      try {
        const found = fetchRowOrNotFound(db, id)
        if (!found.ok) return errAsync(found.error)

        const existing = found.row.oauthMeta
          ? OAuthMetaSchema.parse(JSON.parse(found.row.oauthMeta) as unknown)
          : {}

        const merged: OAuthMeta = { ...existing }
        if (patch.refreshTokenRef !== undefined) merged.refreshTokenRef = patch.refreshTokenRef
        if (patch.expiresAt !== undefined) merged.expiresAt = patch.expiresAt
        if (patch.scopes !== undefined) merged.scopes = patch.scopes
        if (patch.needsReauth !== undefined) merged.needsReauth = patch.needsReauth
        if (patch.obtainedAt !== undefined) merged.obtainedAt = patch.obtainedAt
        if (patch.providerId !== undefined) merged.providerId = patch.providerId
        if (patch.authMode !== undefined) merged.authMode = patch.authMode
        if (patch.clientIdRef !== undefined) merged.clientIdRef = patch.clientIdRef
        if (patch.clientSecretRef !== undefined) merged.clientSecretRef = patch.clientSecretRef

        const validated = OAuthMetaSchema.parse(merged)
        const secretRef = patch.secretRef !== undefined ? patch.secretRef : found.row.secretRef

        db.update(credentials)
          .set({ secretRef, oauthMeta: JSON.stringify(validated) })
          .where(eq(credentials.id, id))
          .run()
        return okAsync(
          rowToCredential({ ...found.row, secretRef, oauthMeta: JSON.stringify(validated) }),
        )
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },
  }
}

export type CredentialsRepo = ReturnType<typeof createCredentialsRepo>
