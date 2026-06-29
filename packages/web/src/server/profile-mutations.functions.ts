// SPDX-License-Identifier: AGPL-3.0-only
// Profile mutation server function wrappers — POST endpoints for profile write paths.
// Routes MUST NOT import @junction/core or profile-mutations.server.ts directly.
//
// Pattern mirrors mutations.functions.ts exactly:
//   validator (pure: trim, requireString, type checks) → handler (assertLocalHost → thin server helper).
//
// Profile mutations need only the DB (no credential store needed).

import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireString } from "./fn-guards.server.js"
import {
  mutateAddRoute,
  mutateCreateProfile,
  mutateDeleteProfile,
  mutateRemoveRoute,
  mutateToggleRoute,
} from "./profile-mutations.server.js"

// ---------------------------------------------------------------------------
// Server functions (POST — profile mutations)
// ---------------------------------------------------------------------------

export const createProfileFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return { name: requireString(d.name, "name") }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateCreateProfile(data.name)
  })

export const deleteProfileFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return { profileId: requireString(d.profileId, "profileId") }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateDeleteProfile(data.profileId)
  })

export const addRouteFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    // credentialId and toolFilter are optional
    const credentialId =
      typeof d.credentialId === "string" && d.credentialId.trim() !== ""
        ? d.credentialId.trim()
        : undefined
    // toolFilter: optional allow/deny arrays — validate type only, not contents (server validates via Zod)
    const toolFilter =
      d.toolFilter !== null && typeof d.toolFilter === "object" && !Array.isArray(d.toolFilter)
        ? (d.toolFilter as { allow?: string[]; deny?: string[] })
        : undefined
    return {
      profileId: requireString(d.profileId, "profileId"),
      platformId: requireString(d.platformId, "platformId"),
      namespace: requireString(d.namespace, "namespace"),
      credentialId,
      toolFilter,
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateAddRoute(data)
  })

export const removeRouteFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      profileId: requireString(d.profileId, "profileId"),
      namespace: requireString(d.namespace, "namespace"),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateRemoveRoute(data.profileId, data.namespace)
  })

export const toggleRouteFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    if (typeof d.enabled !== "boolean") {
      throw new Response("Bad Request: enabled must be a boolean", { status: 400 })
    }
    return {
      profileId: requireString(d.profileId, "profileId"),
      namespace: requireString(d.namespace, "namespace"),
      enabled: d.enabled,
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateToggleRoute(data.profileId, data.namespace, data.enabled)
  })
