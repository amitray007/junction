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
  findOperationByOperationId,
  hasAmbiguousSanitizedName,
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
  /**
   * Operator-designated verify operationId (increment 28.9). Must resolve to a
   * GET operation with no required parameters in the parsed spec — validated
   * here, before the platform is persisted. Absent ⇒ platform stays honestly
   * "not-verifiable" for verify-on-add/test-connection.
   */
  verifyOperationId?: string
}

// ---------------------------------------------------------------------------
// verifyOperationId validation — must resolve to a GET with no required params
// ---------------------------------------------------------------------------

/**
 * Locate `operationId` anywhere in the spec's paths (via openapi-client's
 * findOperationByOperationId) and validate it resolves to a GET with no
 * required parameters. Returns an error string (not thrown) describing why
 * the id is unusable, or undefined if it validates.
 */
function validateVerifyOperationId(
  schema: Record<string, unknown>,
  operationId: string,
): string | undefined {
  const found = findOperationByOperationId(schema, operationId)
  if (found === null) {
    return `operationId "${operationId}" not found in spec`
  }
  if (found.method !== "get") {
    return `operationId "${operationId}" is a ${found.method.toUpperCase()} operation; verifyOperationId must be a GET`
  }
  if (found.hasRequiredParameter) {
    return `operationId "${operationId}" has required parameters; verifyOperationId must take no required parameters`
  }
  // The runtime verify call sanitizes operationId before matching a tool
  // name (see source-runtime's verify-credential.ts). If another operation
  // in the spec sanitizes to the SAME tool name, the verify call could bind
  // to the wrong operation — reject rather than silently mis-verify forever.
  if (hasAmbiguousSanitizedName(schema, operationId)) {
    return `operationId "${operationId}" sanitizes to the same tool name as another operation in this spec; verifyOperationId must be unambiguous after sanitization`
  }
  return undefined
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

  // Validate verifyOperationId (if the operator designated one) BEFORE the
  // platform is persisted — must resolve to a GET with no required params.
  if (input.verifyOperationId !== undefined) {
    const verifyError = validateVerifyOperationId(schema, input.verifyOperationId)
    if (verifyError !== undefined) {
      return err({ kind: "verify-op-invalid", message: verifyError })
    }
  }

  // Build the OpenAPI connection descriptor (select persisted so runtime enforces the same slice)
  const openapiParseResult = OpenApiConnectionSchema.safeParse({
    spec: { from: "url", url: input.specUrl },
    baseUrl: baseUrlResult.value,
    auth,
    maxTools,
    select: input.select,
    verifyOperationId: input.verifyOperationId,
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
