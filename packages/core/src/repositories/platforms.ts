// SPDX-License-Identifier: AGPL-3.0-only
// Platforms repository — CRUD + upsert behind ResultAsync. dry.md: no generic base.
// better-sqlite3 is sync; we present an async API for libsql-swap safety.

import { eq } from "drizzle-orm"
import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { mapDbError } from "../db/errors.js"
import type { Db } from "../db/index.js"
import { platforms } from "../db/schema.js"
import type { DbError } from "../errors/index.js"
import { GraphQlConnectionSchema } from "../schema/graphql-connection.js"
import { McpConnectionSchema } from "../schema/mcp-connection.js"
import { OpenApiConnectionSchema } from "../schema/openapi-connection.js"
import type { Platform } from "../schema/platform.js"
import { PlatformSchema } from "../schema/platform.js"

function rowToPlatform(row: typeof platforms.$inferSelect): Platform {
  const raw: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    specUrl: row.specUrl ?? undefined,
    baseUrl: row.baseUrl ?? undefined,
  }
  if (row.connection) {
    // Validate JSON on read — boundary validation per docs/rules/data.md
    raw.connection = McpConnectionSchema.parse(JSON.parse(row.connection) as unknown)
  }
  if (row.openapi) {
    raw.openapi = OpenApiConnectionSchema.parse(JSON.parse(row.openapi) as unknown)
  }
  if (row.graphql) {
    raw.graphql = GraphQlConnectionSchema.parse(JSON.parse(row.graphql) as unknown)
  }
  return PlatformSchema.parse(raw)
}

/** Serialise a validated Platform to the DB row shape (JSON-encode nested objects). */
function toPlatformRow(p: Platform) {
  return {
    id: p.id,
    kind: p.kind,
    displayName: p.displayName,
    specUrl: p.specUrl ?? null,
    baseUrl: p.baseUrl ?? null,
    connection: p.connection ? JSON.stringify(p.connection) : null,
    openapi: p.openapi ? JSON.stringify(p.openapi) : null,
    graphql: p.graphql ? JSON.stringify(p.graphql) : null,
  }
}

export function createPlatformsRepo(db: Db) {
  return {
    create(input: Platform): ResultAsync<Platform, DbError> {
      try {
        const validated = PlatformSchema.parse(input)
        db.insert(platforms).values(toPlatformRow(validated)).run()
        return okAsync(validated)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Create-or-replace a Platform including its connection descriptor.
     * Replaces all fields on conflict (the platform may be edited/updated).
     */
    upsert(input: Platform): ResultAsync<Platform, DbError> {
      try {
        const validated = PlatformSchema.parse(input)
        const row = toPlatformRow(validated)
        db.insert(platforms)
          .values(row)
          .onConflictDoUpdate({
            target: platforms.id,
            set: {
              kind: row.kind,
              displayName: row.displayName,
              specUrl: row.specUrl,
              baseUrl: row.baseUrl,
              connection: row.connection,
              openapi: row.openapi,
              graphql: row.graphql,
            },
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
        const result = db.delete(platforms).where(eq(platforms.id, id)).run()
        // changes === 0 means no row matched — surface as typed not-found rather
        // than silently returning Ok. FK RESTRICT violations throw (caught below).
        if (result.changes === 0) {
          return errAsync({ kind: "not-found" as const, entity: "platform", id })
        }
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },
  }
}

export type PlatformsRepo = ReturnType<typeof createPlatformsRepo>
