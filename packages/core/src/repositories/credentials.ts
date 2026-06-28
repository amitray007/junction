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
import type { Credential } from "../schema/credential.js"
import { CredentialSchema, OAuthMetaSchema } from "../schema/credential.js"
import type { PlatformId } from "../schema/primitives.js"

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
        const row = db.select().from(credentials).where(eq(credentials.id, id)).get()
        if (!row) return errAsync({ kind: "not-found" as const, entity: "credential", id })
        return okAsync(rowToCredential(row))
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
        const row = db.select().from(credentials).where(eq(credentials.id, id)).get()
        if (!row) return errAsync({ kind: "not-found" as const, entity: "credential", id })
        db.update(credentials).set({ secretRef: newSecretRef }).where(eq(credentials.id, id)).run()
        return okAsync(rowToCredential({ ...row, secretRef: newSecretRef }))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    delete(id: string): ResultAsync<void, DbError> {
      try {
        db.delete(credentials).where(eq(credentials.id, id)).run()
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },
  }
}

export type CredentialsRepo = ReturnType<typeof createCredentialsRepo>
