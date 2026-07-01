// SPDX-License-Identifier: AGPL-3.0-only
// Platform mutation server function wrappers — POST endpoints for platform write paths.
// Routes MUST NOT import @junction/core, @junction/platform-orchestration, or
// platform-mutations.server.ts directly.
//
// Pattern mirrors profile-mutations.functions.ts exactly:
//   validator (pure: trim, requireString, type checks) → handler (assertLocalHost → thin server helper).

import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireString } from "./fn-guards.server.js"
import type { AddPlatformInput, SimpleAuthInput } from "./platform-mutations.server.js"
import {
  mutateAddPlatform,
  mutateDeletePlatform,
  mutateRefreshPlatform,
  mutateUpdatePlatform,
} from "./platform-mutations.server.js"

// ---------------------------------------------------------------------------
// Validator helpers — pure, no I/O, no core.
// ---------------------------------------------------------------------------

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Shared pure validator for the id-only mutations (delete, refresh). */
function validateIdOnly(raw: unknown): { id: string } {
  const d = raw as Record<string, unknown>
  return { id: requireString(d.id, "id") }
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === "string")
}

/** Validate the optional simple-auth sub-form shared by openapi/graphql. */
function validateAuth(raw: unknown): SimpleAuthInput | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const d = raw as Record<string, unknown>
  if (d.scheme === "bearer") return { scheme: "bearer" }
  if (d.scheme === "apiKey") {
    return { scheme: "apiKey", name: requireString(d.name, "auth.name") }
  }
  return { scheme: "none" }
}

function validateAddPlatformInput(raw: unknown): AddPlatformInput {
  const d = raw as Record<string, unknown>
  const id = requireString(d.id, "id")
  const displayName = requireString(d.displayName, "displayName")

  switch (d.kind) {
    case "mcp-http":
      return {
        kind: "mcp-http",
        id,
        displayName,
        url: requireString(d.url, "url"),
        authHeader: optionalString(d.authHeader),
      }
    case "mcp-stdio":
      return {
        kind: "mcp-stdio",
        id,
        displayName,
        command: requireString(d.command, "command"),
        args: optionalStringArray(d.args),
        tokenEnvVar: optionalString(d.tokenEnvVar),
      }
    case "openapi":
      return {
        kind: "openapi",
        id,
        displayName,
        specUrl: requireString(d.specUrl, "specUrl"),
        baseUrl: optionalString(d.baseUrl),
        auth: validateAuth(d.auth),
      }
    case "graphql":
      return {
        kind: "graphql",
        id,
        displayName,
        endpoint: requireString(d.endpoint, "endpoint"),
        auth: validateAuth(d.auth),
      }
    case "cli":
      return {
        kind: "cli",
        id,
        displayName,
        descriptor: requireString(d.descriptor, "descriptor"),
      }
    default:
      throw new Response(`Bad Request: unknown platform kind "${String(d.kind)}"`, {
        status: 400,
      })
  }
}

// ---------------------------------------------------------------------------
// Server functions (POST — platform mutations)
// ---------------------------------------------------------------------------

export const addPlatformFn = createServerFn({ method: "POST" })
  .validator(validateAddPlatformInput)
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateAddPlatform(data)
  })

export const updatePlatformFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    return {
      id: requireString(d.id, "id"),
      displayName: requireString(d.displayName, "displayName"),
    }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateUpdatePlatform(data)
  })

export const deletePlatformFn = createServerFn({ method: "POST" })
  .validator(validateIdOnly)
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateDeletePlatform(data.id)
  })

export const refreshPlatformFn = createServerFn({ method: "POST" })
  .validator(validateIdOnly)
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateRefreshPlatform(data.id)
  })
