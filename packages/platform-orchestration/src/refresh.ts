// SPDX-License-Identifier: AGPL-3.0-only
// refresh.ts — re-pull an OpenAPI platform's spec from its stored URL. Mirrors
// refreshCommand.run's domain logic from the original cli/commands/platform.ts.
// DB-free: the caller loads the platform and upserts the returned update.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { getPaths, openapiSpecCacheFile, type Platform } from "@junction/core"
import {
  countOperationsByTag,
  extractTools,
  parseSpec,
  resolveSpecBaseUrl,
} from "@junction/openapi-client"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import { mapSpecError, type PlatformOrchestrationError } from "./errors.js"

export interface RefreshOpenApiPlatformInput {
  /** The platform loaded from the repo by the caller (this package stays DB-free). */
  platform: Platform
}

export interface RefreshOpenApiPlatformResult {
  /** The updated Platform — the caller is responsible for upserting it. */
  platform: Platform
  oldCount: number | null
  newCount: number
  cacheFile: string
  zeroToolsWarning?: string
}

export function refreshOpenApiPlatform(
  input: RefreshOpenApiPlatformInput,
): ResultAsync<RefreshOpenApiPlatformResult, PlatformOrchestrationError> {
  return new ResultAsync(refreshOpenApiPlatformAsync(input))
}

async function refreshOpenApiPlatformAsync(
  input: RefreshOpenApiPlatformInput,
): Promise<Result<RefreshOpenApiPlatformResult, PlatformOrchestrationError>> {
  const { platform } = input

  // Only openapi platforms can be refreshed
  if (platform.kind !== "openapi" || !platform.openapi) {
    return err({ kind: "not-openapi", platformKind: platform.kind })
  }
  const openapi = platform.openapi

  // Only specs added from a URL can be refreshed (inline/file have no URL to re-pull)
  if (openapi.spec.from !== "url") {
    return err({ kind: "not-url-spec", specFrom: openapi.spec.from })
  }

  const specUrl = openapi.spec.url
  const maxTools = openapi.maxTools ?? 75

  // Re-fetch + parse the spec
  const specResult = await parseSpec({ from: "url", url: specUrl })
  if (specResult.isErr()) {
    return err(mapSpecError(specResult.error))
  }
  const { schema: newSchema } = specResult.value

  // Re-resolve base URL; fall back to the existing one on error so a working platform
  // never breaks from a spec that drops or templates its servers on refresh.
  const baseUrlResult = resolveSpecBaseUrl(newSchema, specUrl, undefined)
  const baseUrl = baseUrlResult.isOk() ? baseUrlResult.value : openapi.baseUrl

  // Re-extract tools (same select + maxTools as the stored descriptor).
  // REFUSE if the refreshed spec would exceed the cap — never clobber a working platform.
  const toolsResult = extractTools(newSchema, maxTools, openapi.select)
  if (toolsResult.isErr()) {
    const e = toolsResult.error
    if (e.kind === "too-many-tools") {
      const tagCounts = countOperationsByTag(newSchema)
      return err({ kind: "too-many-tools", count: e.count, cap: e.cap, tagCounts })
    }
    return err({ kind: "extract-failed", extractKind: e.kind })
  }
  const newCount = toolsResult.value.length

  const paths = getPaths()
  const cacheFile = openapiSpecCacheFile(paths, platform.id)

  // Compute old count from the cached spec for the delta report (best-effort)
  let oldCount: number | null = null
  try {
    const oldSpec = JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, unknown>
    const oldToolsResult = extractTools(oldSpec, maxTools, openapi.select)
    if (oldToolsResult.isOk()) oldCount = oldToolsResult.value.length
  } catch {
    // Cache missing or unreadable — delta reporting degrades gracefully
  }

  // Re-cache the refreshed spec
  try {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(newSchema), "utf8")
  } catch (cause) {
    return err({ kind: "spec-cache-failed", cause })
  }

  // A refresh that yields zero tools is usually a stale selection (the chosen
  // tag/path vanished upstream) rather than a healthy empty API — flag it.
  let zeroToolsWarning: string | undefined
  if (newCount === 0) {
    zeroToolsWarning =
      openapi.select?.tags || openapi.select?.paths
        ? "refreshed spec exposes 0 tools — the selected tag/path may no longer exist in the spec"
        : "refreshed spec exposes 0 tools"
  }

  const updatedPlatform: Platform = {
    ...platform,
    openapi: { ...openapi, baseUrl },
  }

  return ok({ platform: updatedPlatform, oldCount, newCount, cacheFile, zeroToolsWarning })
}
