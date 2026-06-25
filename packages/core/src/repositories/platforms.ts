// SPDX-License-Identifier: AGPL-3.0-only
// Platforms repository — CRUD behind ResultAsync. dry.md: no generic base.
// better-sqlite3 is sync; we present an async API for libsql-swap safety.

import { eq } from "drizzle-orm"
import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { mapDbError } from "../db/errors.js"
import type { Db } from "../db/index.js"
import { platforms } from "../db/schema.js"
import type { DbError } from "../errors/index.js"
import type { Platform } from "../schema/platform.js"
import { PlatformSchema } from "../schema/platform.js"

function rowToPlatform(row: typeof platforms.$inferSelect): Platform {
  return PlatformSchema.parse({
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    specUrl: row.specUrl ?? undefined,
    baseUrl: row.baseUrl ?? undefined,
  })
}

export function createPlatformsRepo(db: Db) {
  return {
    create(input: Platform): ResultAsync<Platform, DbError> {
      try {
        const validated = PlatformSchema.parse(input)
        db.insert(platforms)
          .values({
            id: validated.id,
            kind: validated.kind,
            displayName: validated.displayName,
            specUrl: validated.specUrl ?? null,
            baseUrl: validated.baseUrl ?? null,
          })
          .run()
        return okAsync(validated)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    get(id: string): ResultAsync<Platform, DbError> {
      try {
        const row = db.select().from(platforms).where(eq(platforms.id, id)).get()
        if (!row) return errAsync({ kind: "not-found" as const, entity: "platform", id })
        return okAsync(rowToPlatform(row))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    list(): ResultAsync<Platform[], DbError> {
      try {
        const rows = db.select().from(platforms).all()
        return okAsync(rows.map(rowToPlatform))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    delete(id: string): ResultAsync<void, DbError> {
      try {
        db.delete(platforms).where(eq(platforms.id, id)).run()
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },
  }
}

export type PlatformsRepo = ReturnType<typeof createPlatformsRepo>
