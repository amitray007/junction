// SPDX-License-Identifier: AGPL-3.0-only
// Server-only profile mutation helpers — add/remove route, toggle, create/delete profile.
// Called exclusively from profile-mutations.functions.ts createServerFn handlers.
// Profile mutations need only the DB (getDb); no credential store required.
// SECURITY: all output is metadata-only — no secret, no secretRef.

import {
  createRepositories,
  deriveMcpEndpointPath,
  newProfileId,
  ProfileNameSchema,
  SourceRefSchema,
  ToolFilterSchema,
} from "@junction/core"
import { getDb } from "./shared.server.js"

// ---------------------------------------------------------------------------
// Shared helper: open memoised DB, call fn, propagate errors.
// ---------------------------------------------------------------------------

async function withRepos<T>(
  fn: (repos: ReturnType<typeof createRepositories>) => Promise<T>,
): Promise<T> {
  const db = await getDb()
  if (db === null) throw new Error("Database unavailable")
  return fn(createRepositories(db))
}

// ---------------------------------------------------------------------------
// Human-readable error messages for DB error kinds.
// ---------------------------------------------------------------------------

function profileErrorMessage(kind: string, extra?: string): string {
  switch (kind) {
    case "not-found":
      return extra ? `Not found: ${extra}` : "Not found"
    case "duplicate-namespace":
      return extra
        ? `Namespace "${extra}" already exists in this profile`
        : "Duplicate namespace in profile"
    case "query-failed":
      return "Database error"
    case "constraint-violation":
      return extra ?? "Constraint violation"
    default:
      return "Operation failed"
  }
}

// ---------------------------------------------------------------------------
// Profile mutations
// ---------------------------------------------------------------------------

/**
 * Create a new profile with the given name (no initial sources).
 * Returns the new profile's id and name on success.
 */
export async function mutateCreateProfile(
  name: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  // Validate name per ProfileNameSchema before touching the DB.
  const parsed = ProfileNameSchema.safeParse(name)
  if (!parsed.success) {
    return { ok: false, error: "Profile name must be lowercase letters, digits, and hyphens only" }
  }

  return withRepos(async (repos) => {
    const id = newProfileId()
    const result = await repos.profiles.create({
      id,
      name: parsed.data,
      mcpEndpointPath: deriveMcpEndpointPath(parsed.data),
      sources: [],
    })
    if (result.isErr()) {
      const e = result.error
      // Constraint violation → duplicate name (unique index on profiles.name)
      return {
        ok: false as const,
        error:
          e.kind === "constraint-violation"
            ? `Profile name "${name}" already exists`
            : profileErrorMessage(e.kind),
      }
    }
    return { ok: true as const, id: String(id), name: parsed.data }
  })
}

/**
 * Delete a profile by id. Cascades source_refs.
 */
export async function mutateDeleteProfile(
  profileId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withRepos(async (repos) => {
    const result = await repos.profiles.delete(profileId)
    if (result.isErr()) {
      return { ok: false as const, error: profileErrorMessage(result.error.kind) }
    }
    return { ok: true as const }
  })
}

/**
 * Add a route (source_ref) to a profile.
 * platformId, namespace are required; credentialId and toolFilter are optional.
 */
export async function mutateAddRoute(input: {
  profileId: string
  platformId: string
  namespace: string
  credentialId?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Validate the SourceRef shape before touching the DB.
  const srParsed = SourceRefSchema.safeParse({
    platformId: input.platformId,
    toolNamespace: input.namespace,
    enabled: true,
    ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
    ...(input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {}),
  })
  if (!srParsed.success) {
    const msg = srParsed.error.issues.map((i) => i.message).join("; ")
    return { ok: false, error: `Invalid route: ${msg}` }
  }

  return withRepos(async (repos) => {
    const result = await repos.profiles.addSource(input.profileId, srParsed.data)
    if (result.isErr()) {
      return {
        ok: false as const,
        error: profileErrorMessage(
          result.error.kind,
          result.error.kind === "duplicate-namespace"
            ? (result.error as { namespace?: string }).namespace
            : undefined,
        ),
      }
    }
    return { ok: true as const }
  })
}

/**
 * Remove a route (source_ref) from a profile by namespace.
 */
export async function mutateRemoveRoute(
  profileId: string,
  namespace: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withRepos(async (repos) => {
    const result = await repos.profiles.removeSource(profileId, namespace)
    if (result.isErr()) {
      return { ok: false as const, error: profileErrorMessage(result.error.kind, namespace) }
    }
    return { ok: true as const }
  })
}

/**
 * Toggle a route's enabled flag on or off.
 */
export async function mutateToggleRoute(
  profileId: string,
  namespace: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withRepos(async (repos) => {
    const result = await repos.profiles.setSourceEnabled(profileId, namespace, enabled)
    if (result.isErr()) {
      return { ok: false as const, error: profileErrorMessage(result.error.kind, namespace) }
    }
    return { ok: true as const }
  })
}

// Re-export ToolFilterSchema for validator use in functions.ts
export { ToolFilterSchema }
