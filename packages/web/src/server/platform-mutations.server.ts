// SPDX-License-Identifier: AGPL-3.0-only
// Server-only platform mutation helpers — add/update/delete/refresh a platform.
// Called exclusively from platform-mutations.functions.ts createServerFn handlers.
// SECURITY: all output is metadata-only — no secret, no secretRef.
//
// Auth exposed at add-time (v1, pragmatic subset — see report):
//   - mcp-http:  bearer only (authHeader override, default "Authorization")
//   - mcp-stdio: no auth sub-form (credential injection stays CLI-only for now)
//   - openapi:   no-auth | bearer | apiKey (header) — basic + query/cookie apiKey deferred
//   - graphql:   no-auth | bearer | apiKey (header) — same deferral as openapi
//   - cli:       none (descriptor carries its own credentialEnvVar)
// Full CLI auth-flag parity (query/cookie apiKey, basic) is deferred to a future
// increment; this is a bearer-first subset, not the complete CLI surface (slice B).

import type { Platform } from "@junction/core"
import {
  addCliPlatform,
  addGraphQlPlatform,
  addMcpPlatform,
  addOpenApiPlatform,
  refreshOpenApiPlatform,
} from "@junction/platform-orchestration"
import { errAsync, type ResultAsync } from "neverthrow"
import { withRepos } from "./shared.server.js"

// ---------------------------------------------------------------------------
// Input shapes — mirror the discriminated validator output in
// platform-mutations.functions.ts exactly.
// ---------------------------------------------------------------------------

export type SimpleAuthInput =
  | { scheme: "none" }
  | { scheme: "bearer" }
  | { scheme: "apiKey"; name: string }

export type AddPlatformInput =
  | {
      kind: "mcp-http"
      id: string
      displayName: string
      url: string
      authHeader?: string
    }
  | {
      kind: "mcp-stdio"
      id: string
      displayName: string
      command: string
      args?: string[]
      tokenEnvVar?: string
    }
  | {
      kind: "openapi"
      id: string
      displayName: string
      specUrl: string
      baseUrl?: string
      auth?: SimpleAuthInput
    }
  | {
      kind: "graphql"
      id: string
      displayName: string
      endpoint: string
      auth?: SimpleAuthInput
    }
  | {
      kind: "cli"
      id: string
      displayName: string
      /** Raw JSON descriptor text — parsed here, not in the pure validator. */
      descriptor: string
    }

export type PlatformMetaResult =
  | { ok: true; platform: { id: string; kind: string; displayName: string; baseUrl?: string } }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Human-readable error messages for orchestration + DB error kinds.
// ---------------------------------------------------------------------------

function orchestrationErrorMessage(e: { kind: string; [k: string]: unknown }): string {
  switch (e.kind) {
    case "invalid-transport":
      return `Invalid transport "${e.transport}"`
    case "missing-field":
      return `Missing required field "${e.field}" for ${e.context}`
    case "spec-fetch-failed":
      return "Failed to fetch the spec — check the URL and network access"
    case "spec-parse-failed":
      return "Failed to parse the spec — it may not be valid OpenAPI/GraphQL SDL"
    case "too-many-tools":
      return `Spec exposes ${e.count} tools, over the cap of ${e.cap} — narrow with a tag/path selection`
    case "extract-failed":
      return "Failed to extract tools from the spec"
    case "base-url":
      return e.reason === "base-url-has-variables"
        ? "Spec's server URL has unresolved template variables — provide an explicit base URL"
        : "Could not determine a base URL — provide one explicitly"
    case "invalid-connection":
      return `Invalid connection: ${e.message}`
    case "invalid-platform":
      return `Invalid platform: ${e.message}`
    case "apikey-in-query-unsupported":
      return "API key in query is not supported for GraphQL — use a header instead"
    case "invalid-descriptor":
      return `Invalid CLI descriptor: ${e.message}`
    case "policy-invalid":
      return `Policy invalid for tool "${e.toolName}": ${e.reason}`
    case "spec-cache-failed":
      return "Failed to cache the spec locally"
    case "not-openapi":
      return "Only OpenAPI platforms can be refreshed"
    case "not-url-spec":
      return "Only specs added from a URL can be refreshed"
    default:
      return "Operation failed"
  }
}

function dbErrorMessage(kind: string): string {
  switch (kind) {
    case "not-found":
      return "Platform not found"
    case "in-use":
      return "Platform is in use by one or more credentials or sources; remove those first"
    case "constraint-violation":
      return "A platform with that id already exists"
    case "query-failed":
      return "Database error"
    default:
      return "Operation failed"
  }
}

function toPlatformMeta(p: Platform): PlatformMetaResult & { ok: true } {
  return {
    ok: true,
    platform: {
      id: String(p.id),
      kind: p.kind,
      displayName: p.displayName,
      ...(p.openapi?.baseUrl !== undefined ? { baseUrl: p.openapi.baseUrl } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Auth mapping — SimpleAuthInput (web's bearer-first subset) → orchestration AuthInput
// ---------------------------------------------------------------------------

function toAuthInput(
  auth: SimpleAuthInput | undefined,
): { scheme?: "apiKey" | "bearer" | "basic"; in?: "header"; name?: string } | undefined {
  if (!auth || auth.scheme === "none") return undefined
  if (auth.scheme === "bearer") return { scheme: "bearer" }
  return { scheme: "apiKey", in: "header", name: auth.name }
}

// ---------------------------------------------------------------------------
// Dispatch: add a platform by kind, upsert on success.
// ---------------------------------------------------------------------------

function addByKind(
  input: AddPlatformInput,
): ResultAsync<
  { platform: Platform; sandboxWarning?: string },
  { kind: string; [k: string]: unknown }
> {
  switch (input.kind) {
    case "mcp-http":
      return addMcpPlatform({
        id: input.id,
        displayName: input.displayName,
        transport: "http",
        url: input.url,
        authHeader: input.authHeader,
      }).map((platform) => ({ platform }))
    case "mcp-stdio":
      return addMcpPlatform({
        id: input.id,
        displayName: input.displayName,
        transport: "stdio",
        command: input.command,
        args: input.args,
        tokenEnvVar: input.tokenEnvVar,
      }).map((platform) => ({ platform }))
    case "openapi":
      return addOpenApiPlatform({
        id: input.id,
        displayName: input.displayName,
        specUrl: input.specUrl,
        baseUrl: input.baseUrl,
        auth: toAuthInput(input.auth),
      }).map(({ platform }) => ({ platform }))
    case "graphql":
      return addGraphQlPlatform({
        id: input.id,
        displayName: input.displayName,
        endpoint: input.endpoint,
        auth: toAuthInput(input.auth),
      }).map(({ platform }) => ({ platform }))
    case "cli": {
      let descriptor: unknown
      try {
        descriptor = JSON.parse(input.descriptor)
      } catch {
        return errAsync({ kind: "invalid-descriptor", message: "descriptor is not valid JSON" })
      }
      return addCliPlatform({ id: input.id, displayName: input.displayName, descriptor }).map(
        ({ platform, sandboxWarning }) => ({ platform, sandboxWarning }),
      )
    }
  }
}

/**
 * Add a platform of any kind. Dispatches to the matching orchestration add* fn,
 * then upserts the resulting Platform. Returns metadata-only shape.
 */
export async function mutateAddPlatform(input: AddPlatformInput): Promise<PlatformMetaResult> {
  const addResult = await addByKind(input)
  if (addResult.isErr()) {
    return { ok: false, error: orchestrationErrorMessage(addResult.error) }
  }
  const { platform } = addResult.value

  return withRepos(async (repos) => {
    const upsertResult = await repos.platforms.upsert(platform)
    if (upsertResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(upsertResult.error.kind) }
    }
    return toPlatformMeta(upsertResult.value)
  })
}

/**
 * Update a platform's displayName only (v1 — pragmatic edit scope).
 * Full re-add-as-edit (re-running the kind-specific add with new fields) is
 * deferred: it would re-fetch specs / re-probe sandboxes on a pure rename.
 * get + upsert preserves every field the edit form doesn't submit.
 */
export async function mutateUpdatePlatform(input: {
  id: string
  displayName: string
}): Promise<PlatformMetaResult> {
  return withRepos(async (repos) => {
    const getResult = await repos.platforms.get(input.id)
    if (getResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(getResult.error.kind) }
    }
    const updated: Platform = { ...getResult.value, displayName: input.displayName }
    const upsertResult = await repos.platforms.upsert(updated)
    if (upsertResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(upsertResult.error.kind) }
    }
    return toPlatformMeta(upsertResult.value)
  })
}

/**
 * Delete a platform by id. Fails with a clean message when a FK RESTRICT fires
 * (credentials or source_refs still reference it) — matches the CLI's remove semantics.
 */
export async function mutateDeletePlatform(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withRepos(async (repos) => {
    const result = await repos.platforms.delete(id)
    if (result.isErr()) {
      return { ok: false as const, error: dbErrorMessage(result.error.kind) }
    }
    return { ok: true as const }
  })
}

/**
 * Refresh an OpenAPI platform's spec. Non-openapi platforms are rejected before
 * calling the orchestration fn (a clearer message than letting refreshOpenApiPlatform's
 * not-openapi error surface, though that path is also covered).
 */
export async function mutateRefreshPlatform(
  id: string,
): Promise<
  | { ok: true; oldCount: number | null; newCount: number; zeroToolsWarning?: string }
  | { ok: false; error: string }
> {
  return withRepos(async (repos) => {
    const getResult = await repos.platforms.get(id)
    if (getResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(getResult.error.kind) }
    }
    const platform = getResult.value
    if (platform.kind !== "openapi") {
      return { ok: false as const, error: "Only OpenAPI platforms can be refreshed" }
    }

    const refreshResult = await refreshOpenApiPlatform({ platform })
    if (refreshResult.isErr()) {
      return { ok: false as const, error: orchestrationErrorMessage(refreshResult.error) }
    }
    const { platform: updated, oldCount, newCount, zeroToolsWarning } = refreshResult.value

    const upsertResult = await repos.platforms.upsert(updated)
    if (upsertResult.isErr()) {
      return { ok: false as const, error: dbErrorMessage(upsertResult.error.kind) }
    }
    return {
      ok: true as const,
      oldCount,
      newCount,
      ...(zeroToolsWarning ? { zeroToolsWarning } : {}),
    }
  })
}
