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
              })
              .run()
          }
        })
        return okAsync(validated)
      } catch (cause) {
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
