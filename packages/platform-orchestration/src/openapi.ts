// SPDX-License-Identifier: AGPL-3.0-only
// openapi.ts — assemble an OpenAPI Platform. Mirrors addOpenApiPlatform from the
// original cli/commands/platform.ts: fetch+parse spec, extract tools, resolve
// auth + base URL, validate the connection + platform, cache the dereferenced spec.

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  getPaths,
  type OpenApiConnection,
  OpenApiConnectionSchema,
  openapiSpecCacheFile,
  type Platform,
  PlatformSchema,
} from "@junction/core"
import {
  countOperationsByTag,
  extractTools,
  parseSpec,
  resolveSpecBaseUrl,
} from "@junction/openapi-client"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import type { AuthInput } from "./auth.js"
import { buildPlatformAuth, deriveAuthFromSpec } from "./auth.js"
import { mapSpecError, type PlatformOrchestrationError } from "./errors.js"

export interface AddOpenApiPlatformInput {
  id: string
  displayName: string
  specUrl: string
  baseUrl?: string
  /** Caller-provided auth override. Undefined → derive from the spec's securitySchemes. */
  auth?: AuthInput
  maxTools?: number
  select?: { tags?: string[]; paths?: string[] }
}

export interface AddOpenApiPlatformResult {
  platform: Platform
  toolCount: number
  cacheFile: string
}

export function addOpenApiPlatform(
  input: AddOpenApiPlatformInput,
): ResultAsync<AddOpenApiPlatformResult, PlatformOrchestrationError> {
  return new ResultAsync(addOpenApiPlatformAsync(input))
}

async function addOpenApiPlatformAsync(
  input: AddOpenApiPlatformInput,
): Promise<Result<AddOpenApiPlatformResult, PlatformOrchestrationError>> {
  const specResult = await parseSpec({ from: "url", url: input.specUrl })
  if (specResult.isErr()) {
    return err(mapSpecError(specResult.error))
  }
  const { schema } = specResult.value
  const maxTools = input.maxTools ?? 75

  // Check operation count against cap (after applying the selection filter)
  const toolsResult = extractTools(schema, maxTools, input.select)
  if (toolsResult.isErr()) {
    const e = toolsResult.error
    if (e.kind === "too-many-tools") {
      const tagCounts = countOperationsByTag(schema)
      return err({ kind: "too-many-tools", count: e.count, cap: e.cap, tagCounts })
    }
    return err({ kind: "extract-failed", extractKind: e.kind })
  }

  // Build auth descriptor — caller-provided override, or fall back to spec's securitySchemes
  const authResult = buildPlatformAuth(input.auth ?? {})
  if (authResult.isErr()) return err(authResult.error)
  const auth: OpenApiConnection["auth"] =
    authResult.value === undefined ? deriveAuthFromSpec(schema) : authResult.value

  // Resolve base URL — relative servers resolved against the spec URL;
  // validates overrides; fails early if no base URL can be determined.
  const baseUrlResult = resolveSpecBaseUrl(schema, input.specUrl, input.baseUrl)
  if (baseUrlResult.isErr()) {
    return err({ kind: "base-url", reason: baseUrlResult.error.kind })
  }

  // Build the OpenAPI connection descriptor (select persisted so runtime enforces the same slice)
  const openapiParseResult = OpenApiConnectionSchema.safeParse({
    spec: { from: "url", url: input.specUrl },
    baseUrl: baseUrlResult.value,
    auth,
    maxTools,
    select: input.select,
  })
  if (!openapiParseResult.success) {
    const message = openapiParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-connection", message })
  }
  const openapi = openapiParseResult.data

  const platformParseResult = PlatformSchema.safeParse({
    id: input.id,
    kind: "openapi",
    displayName: input.displayName,
    openapi,
  })
  if (!platformParseResult.success) {
    const message = platformParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-platform", message })
  }
  const platform = platformParseResult.data

  // Cache the dereferenced spec to ~/.junction/openapi/<platformId>.json
  const paths = getPaths()
  const cacheFile = openapiSpecCacheFile(paths, platform.id)
  try {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(schema), "utf8")
  } catch (cause) {
    return err({ kind: "spec-cache-failed", cause })
  }

  return ok({ platform, toolCount: toolsResult.value.length, cacheFile })
}
