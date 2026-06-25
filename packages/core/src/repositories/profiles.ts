// SPDX-License-Identifier: AGPL-3.0-only
// Profiles repository — manages profiles + their source_refs (nested).
// source_refs have no independent lifecycle; managed only through this repo.
// Profile create/delete are transactional (source_refs cascade on delete).

import { eq } from "drizzle-orm"
import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import { mapDbError } from "../db/errors.js"
import type { Db } from "../db/index.js"
import { profiles, sourceRefs } from "../db/schema.js"
import type { DbError } from "../errors/index.js"
import { newSourceRefId } from "../ids/index.js"
import type { Profile } from "../schema/profile.js"
import { ProfileSchema } from "../schema/profile.js"
import type { SourceRef } from "../schema/source-ref.js"
import { SourceRefSchema, ToolFilterSchema } from "../schema/source-ref.js"

// Sentinel symbols for custom transaction errors (avoids instanceof checks on plain Error)
const _DUPLICATE_NS = Symbol("duplicate-namespace")

function reconstructProfile(
  profileRow: typeof profiles.$inferSelect,
  sourceRefRows: (typeof sourceRefs.$inferSelect)[],
): Profile {
  return ProfileSchema.parse({
    id: profileRow.id,
    name: profileRow.name,
    mcpEndpointPath: profileRow.mcpEndpointPath,
    sources: sourceRefRows.map((sr) => ({
      platformId: sr.platformId,
      credentialId: sr.credentialId,
      toolNamespace: sr.toolNamespace,
      enabled: sr.enabled,
      // Validate JSON on read — boundary validation per docs/rules/data.md
      toolFilter: sr.toolFilter
        ? ToolFilterSchema.parse(JSON.parse(sr.toolFilter) as unknown)
        : undefined,
    })),
  })
}

export function createProfilesRepo(db: Db) {
  return {
    create(input: Profile): ResultAsync<Profile, DbError> {
      try {
        const validated = ProfileSchema.parse(input)
        db.transaction((tx) => {
          tx.insert(profiles)
            .values({
              id: validated.id,
              name: validated.name,
              mcpEndpointPath: validated.mcpEndpointPath,
            })
            .run()
          for (const sr of validated.sources) {
            tx.insert(sourceRefs)
              .values({
                id: newSourceRefId(),
                profileId: validated.id,
                platformId: sr.platformId,
                credentialId: sr.credentialId,
                toolNamespace: sr.toolNamespace,
                enabled: sr.enabled,
                toolFilter: sr.toolFilter ? JSON.stringify(sr.toolFilter) : null,
              })
              .run()
          }
        })
        return okAsync(validated)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    /**
     * Append a SourceRef to an existing Profile.
     *
     * Invariants enforced:
     * - Profile must exist (FK → profiles.id; becomes constraint-violation if absent)
     * - platformId + credentialId must exist (FK enforced by SQLite)
     * - toolNamespace must be unique within the profile (explicit duplicate guard)
     *
     * All checks run inside a transaction for atomicity.
     */
    addSource(profileId: string, sourceRef: SourceRef): ResultAsync<void, DbError> {
      try {
        const validatedSr = SourceRefSchema.parse(sourceRef)
        db.transaction((tx) => {
          // Guard: reject duplicate toolNamespace within this profile
          const existing = tx
            .select({ toolNamespace: sourceRefs.toolNamespace })
            .from(sourceRefs)
            .where(eq(sourceRefs.profileId, profileId))
            .all()
          const hasDuplicate = existing.some((sr) => sr.toolNamespace === validatedSr.toolNamespace)
          if (hasDuplicate) {
            throw Object.assign(new Error(`duplicate namespace: ${validatedSr.toolNamespace}`), {
              _sentinel: _DUPLICATE_NS,
              _namespace: validatedSr.toolNamespace,
            })
          }
          // FK constraints (profileId, platformId, credentialId) enforced by SQLite
          tx.insert(sourceRefs)
            .values({
              id: newSourceRefId(),
              profileId,
              platformId: validatedSr.platformId,
              credentialId: validatedSr.credentialId,
              toolNamespace: validatedSr.toolNamespace,
              enabled: validatedSr.enabled,
              toolFilter: validatedSr.toolFilter ? JSON.stringify(validatedSr.toolFilter) : null,
            })
            .run()
        })
        return okAsync(undefined)
      } catch (cause) {
        // Custom sentinel: duplicate toolNamespace within the profile
        if (
          cause !== null &&
          typeof cause === "object" &&
          "_sentinel" in cause &&
          (cause as { _sentinel: unknown })._sentinel === _DUPLICATE_NS
        ) {
          const ns = (cause as { _namespace?: unknown })._namespace
          return errAsync({
            kind: "duplicate-namespace" as const,
            namespace: typeof ns === "string" ? ns : String(ns),
          })
        }
        return errAsync(mapDbError(cause))
      }
    },

    get(id: string): ResultAsync<Profile, DbError> {
      try {
        const profileRow = db.select().from(profiles).where(eq(profiles.id, id)).get()
        if (!profileRow) return errAsync({ kind: "not-found" as const, entity: "profile", id })
        const srRows = db
          .select()
          .from(sourceRefs)
          .where(eq(sourceRefs.profileId, id))
          .orderBy(sourceRefs.toolNamespace)
          .all()
        return okAsync(reconstructProfile(profileRow, srRows))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    getByName(name: string): ResultAsync<Profile, DbError> {
      try {
        const profileRow = db.select().from(profiles).where(eq(profiles.name, name)).get()
        if (!profileRow)
          return errAsync({ kind: "not-found" as const, entity: "profile", id: name })
        const srRows = db
          .select()
          .from(sourceRefs)
          .where(eq(sourceRefs.profileId, profileRow.id))
          .orderBy(sourceRefs.toolNamespace)
          .all()
        return okAsync(reconstructProfile(profileRow, srRows))
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    list(): ResultAsync<Profile[], DbError> {
      try {
        const profileRows = db.select().from(profiles).all()
        const result: Profile[] = []
        for (const profileRow of profileRows) {
          const srRows = db
            .select()
            .from(sourceRefs)
            .where(eq(sourceRefs.profileId, profileRow.id))
            .orderBy(sourceRefs.toolNamespace)
            .all()
          result.push(reconstructProfile(profileRow, srRows))
        }
        return okAsync(result)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },

    delete(id: string): ResultAsync<void, DbError> {
      try {
        // source_refs CASCADE on profiles.id delete (FK: ON DELETE CASCADE)
        db.delete(profiles).where(eq(profiles.id, id)).run()
        return okAsync(undefined)
      } catch (cause) {
        return errAsync(mapDbError(cause))
      }
    },
  }
}

export type ProfilesRepo = ReturnType<typeof createProfilesRepo>
