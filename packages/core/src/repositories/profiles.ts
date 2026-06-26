// SPDX-License-Identifier: AGPL-3.0-only
// Profiles repository — manages profiles + their source_refs (nested).
// source_refs have no independent lifecycle; managed only through this repo.
// Profile create/delete are transactional (source_refs cascade on delete).

import { and, eq } from "drizzle-orm"
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
const _SOURCE_NOT_FOUND = Symbol("source-not-found")

function isSourceNotFound(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "_sentinel" in cause &&
    (cause as { _sentinel: unknown })._sentinel === _SOURCE_NOT_FOUND
  )
}

/**
 * Shared transaction helper for source mutations (removeSource, setSourceEnabled).
 * Within a transaction: looks up the source_ref by (profileId, toolNamespace),
 * throws the sentinel if absent, then applies the requested operation by the
 * found row id (avoiding re-building the compound where clause in each caller).
 *
 * Uses a discriminated op union so the caller never needs to type the drizzle
 * transaction object (SQLiteTransaction ≠ Db — they share query methods but differ
 * structurally; passing `tx` through a callback would require a complex type extract).
 *
 * Returns a typed ResultAsync so both callers reduce to a single `return` expression.
 */
type SourceOp = { kind: "delete" } | { kind: "setEnabled"; enabled: boolean }

function runSourceMutation(
  db: Db,
  profileId: string,
  toolNamespace: string,
  op: SourceOp,
): ResultAsync<void, DbError> {
  try {
    db.transaction((tx) => {
      const existing = tx
        .select({ id: sourceRefs.id })
        .from(sourceRefs)
        .where(
          and(eq(sourceRefs.profileId, profileId), eq(sourceRefs.toolNamespace, toolNamespace)),
        )
        .get()
      if (!existing) {
        throw Object.assign(
          new Error(`source not found: ${toolNamespace} in profile ${profileId}`),
          { _sentinel: _SOURCE_NOT_FOUND, _namespace: toolNamespace },
        )
      }
      if (op.kind === "delete") {
        tx.delete(sourceRefs).where(eq(sourceRefs.id, existing.id)).run()
      } else {
        tx.update(sourceRefs)
          .set({ enabled: op.enabled })
          .where(eq(sourceRefs.id, existing.id))
          .run()
      }
    })
    return okAsync(undefined)
  } catch (cause) {
    if (isSourceNotFound(cause)) {
      return errAsync({ kind: "not-found" as const, entity: "source", id: toolNamespace })
    }
    return errAsync(mapDbError(cause))
  }
}

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
      // NULL DB value → undefined in schema (optional credentialId — public source)
      credentialId: sr.credentialId ?? undefined,
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

        // Guard: reject duplicate toolNamespace within the profile's initial sources.
        // Defense-in-depth beyond the DB unique index — catches the error before the
        // transaction rather than relying solely on a constraint-violation at write time.
        const seen = new Set<string>()
        for (const sr of validated.sources) {
          if (seen.has(sr.toolNamespace)) {
            return errAsync({
              kind: "duplicate-namespace" as const,
              namespace: sr.toolNamespace,
            })
          }
          seen.add(sr.toolNamespace)
        }

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
                // undefined → NULL in Drizzle; absent when no-auth source
                credentialId: sr.credentialId ?? null,
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
          // FK constraints (profileId, platformId) enforced by SQLite;
          // credentialId FK only applies when present — NULL is FK-exempt
          tx.insert(sourceRefs)
            .values({
              id: newSourceRefId(),
              profileId,
              platformId: validatedSr.platformId,
              // undefined → NULL in Drizzle; absent when no-auth source
              credentialId: validatedSr.credentialId ?? null,
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

    /**
     * Remove a single SourceRef from a profile by its tool namespace.
     * Transactional: verifies existence, then deletes.
     * Returns not-found if the (profile, namespace) pair doesn't exist.
     */
    removeSource(profileId: string, toolNamespace: string): ResultAsync<void, DbError> {
      return runSourceMutation(db, profileId, toolNamespace, { kind: "delete" })
    },

    /**
     * Toggle the enabled flag on a SourceRef.
     * Transactional: verifies existence, then updates.
     * Returns not-found if the (profile, namespace) pair doesn't exist.
     */
    setSourceEnabled(
      profileId: string,
      toolNamespace: string,
      enabled: boolean,
    ): ResultAsync<void, DbError> {
      return runSourceMutation(db, profileId, toolNamespace, { kind: "setEnabled", enabled })
    },
  }
}

export type ProfilesRepo = ReturnType<typeof createProfilesRepo>
