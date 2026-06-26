// SPDX-License-Identifier: AGPL-3.0-only
// `junction platform` — platform management commands: `add`, `list`.
// SOURCE-AGNOSTIC: no vendor/GitHub-specific logic. Platforms are generic DATA rows.
// Edge stays thin: calls core, formats output. No business logic here.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  type McpConnection,
  type OpenApiConnection,
  OpenApiConnectionSchema,
  type Platform,
  PlatformSchema,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { collectRepeatableFlag, JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportDbError, reportIdRemoved, reportInUseError } from "../format.js"

/** Report a string error in the appropriate format and set exitCode=1. */
function reportError(msg: string, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  else consola.error(msg)
  process.exitCode = 1
}

/** Format a spec-fetch or spec-parse error for display. */
function formatSpecError(e: { kind: string; cause?: unknown }): string {
  return e.kind === "spec-fetch-failed"
    ? `Failed to fetch spec: ${String(e.cause)}`
    : `Failed to parse spec: ${String(e.cause)}`
}

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Define or update a platform (MCP or OpenAPI/REST source).",
  },
  args: {
    id: { type: "string", description: "Stable platform ID (e.g. my-mcp-server)", required: true },
    kind: {
      type: "string",
      description: "Platform kind: mcp or openapi (default: mcp)",
      default: "mcp",
    },
    "display-name": {
      type: "string",
      description: "Human-readable name (e.g. My MCP Server)",
      required: true,
    },
    // MCP transport flags
    transport: {
      type: "string",
      description: "[mcp] Transport: http (remote URL) or stdio (local command)",
    },
    // HTTP transport flags
    url: { type: "string", description: "[mcp/http] Remote MCP server URL" },
    "auth-header": {
      type: "string",
      description: "[mcp/http] HTTP header to carry the bearer token (default: Authorization)",
    },
    // Stdio transport flags
    command: {
      type: "string",
      description: "[mcp/stdio] Command to launch the MCP server (e.g. npx)",
    },
    "token-env": {
      type: "string",
      description: "[mcp/stdio] Env-var name the bearer token is injected into",
    },
    // OpenAPI flags
    "spec-url": { type: "string", description: "[openapi] URL of the OpenAPI spec document" },
    "base-url": { type: "string", description: "[openapi] Base URL override for API calls" },
    "auth-scheme": {
      type: "string",
      description: "[openapi] Auth scheme: apiKey, bearer, or basic",
    },
    "auth-in": {
      type: "string",
      description: "[openapi/apiKey] Where to send the key: header, query, or cookie",
    },
    "auth-name": {
      type: "string",
      description: "[openapi/apiKey] Parameter name for the API key (e.g. X-API-Key)",
    },
    "auth-username": {
      type: "string",
      description: "[openapi/basic] Username for HTTP Basic auth",
    },
    "max-tools": {
      type: "string",
      description: "[openapi] Max operations to expose (default: 75)",
    },
    tag: {
      type: "string",
      description:
        "[openapi] Include only operations with this tag (repeatable: --tag pet --tag store)",
    },
    path: {
      type: "string",
      description:
        "[openapi] Include only operations whose path starts with this prefix (repeatable: --path /pet)",
    },
    json: JSON_ARG,
  },
  async run({ args, rawArgs }) {
    const json = args.json ?? false
    const kind = args.kind ?? "mcp"

    if (kind === "openapi") {
      await addOpenApiPlatform(args, rawArgs, json)
      return
    }

    // MCP platform (original flow)
    const transport = args.transport
    if (!transport) {
      reportError("--transport is required for mcp kind", json)
      return
    }

    let connection: McpConnection | undefined
    if (transport === "http") {
      if (!args.url) {
        reportError("--url is required for http transport", json)
        return
      }
      connection = {
        transport: "http",
        url: args.url,
        auth: { scheme: "bearer", header: args["auth-header"] ?? "Authorization" },
      }
    } else if (transport === "stdio") {
      if (!args.command) {
        reportError("--command is required for stdio transport", json)
        return
      }
      connection = {
        transport: "stdio",
        command: args.command,
        args: collectRepeatableFlag(rawArgs, "--arg"),
        tokenEnvVar: args["token-env"],
      }
    } else {
      reportError(`unknown transport "${transport}": must be "http" or "stdio"`, json)
      return
    }

    const parseResult = PlatformSchema.safeParse({
      id: args.id,
      kind: "mcp",
      displayName: args["display-name"],
      connection,
    })
    if (!parseResult.success) {
      const msg = parseResult.error.issues.map((i: { message: string }) => i.message).join(", ")
      reportError(`Invalid platform: ${msg}`, json)
      return
    }
    const platform: Platform = parseResult.data

    const repos = await openDb(json)
    if (!repos) return

    const result = await repos.platforms.upsert(platform)
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, platform: result.value })}\n`)
    } else {
      consola.success(
        `Platform "${platform.displayName}" (${platform.id}) defined — transport: ${transport}`,
      )
    }
  },
})

async function addOpenApiPlatform(
  args: Record<string, unknown>,
  rawArgs: string[],
  json: boolean,
): Promise<void> {
  const specUrl = args["spec-url"] as string | undefined
  if (!specUrl) {
    reportError("--spec-url is required for openapi kind", json)
    return
  }

  // Collect repeatable --tag / --path flags from rawArgs (same pattern as --allow/--deny)
  const selectedTags = collectRepeatableFlag(rawArgs, "--tag")
  const selectedPaths = collectRepeatableFlag(rawArgs, "--path")
  // Build select only when at least one filter is active; absent means all operations.
  const select =
    selectedTags.length > 0 || selectedPaths.length > 0
      ? {
          ...(selectedTags.length > 0 ? { tags: selectedTags } : {}),
          ...(selectedPaths.length > 0 ? { paths: selectedPaths } : {}),
        }
      : undefined

  // Lazy-import openapi-client (avoids load cost for non-openapi commands)
  const { parseSpec, extractTools, countOperationsByTag, resolveSpecBaseUrl } = await import(
    "@junction/openapi-client"
  )

  // Fetch + parse + validate the spec
  if (!json) consola.info(`Fetching spec from ${specUrl} …`)
  const specResult = await parseSpec({ from: "url", url: specUrl })
  if (specResult.isErr()) {
    reportError(formatSpecError(specResult.error), json)
    return
  }

  const { schema } = specResult.value
  const maxTools = args["max-tools"] ? parseInt(args["max-tools"] as string, 10) : 75

  // Check operation count against cap (after applying the selection filter)
  const toolsResult = extractTools(schema, maxTools, select)
  if (toolsResult.isErr()) {
    const e = toolsResult.error
    if (e.kind === "too-many-tools") {
      const tagCounts = countOperationsByTag(schema)
      const tagLines = tagCounts
        .map(({ tag, count }: { tag: string; count: number }) => `  ${tag}: ${count}`)
        .join("\n")
      reportError(
        `Spec has ${e.count} operations, exceeding the cap of ${e.cap}.\n` +
          `Operations by tag:\n${tagLines}\n` +
          `Narrow with --tag <name> and/or --path <prefix> to add a slice, or pick a smaller spec.`,
        json,
      )
      return
    }
    reportError(`Failed to extract tools: ${e.kind}`, json)
    return
  }

  // Build auth descriptor
  let auth: OpenApiConnection["auth"]
  const authScheme = args["auth-scheme"] as string | undefined

  if (authScheme === "apiKey") {
    const authIn = (args["auth-in"] as string | undefined) ?? "header"
    const authName = args["auth-name"] as string | undefined
    if (!authName) {
      reportError("--auth-name is required for apiKey auth scheme", json)
      return
    }
    if (authIn !== "header" && authIn !== "query" && authIn !== "cookie") {
      reportError("--auth-in must be header, query, or cookie", json)
      return
    }
    auth = { scheme: "apiKey", in: authIn, name: authName }
  } else if (authScheme === "bearer") {
    auth = { scheme: "bearer", header: "Authorization" }
  } else if (authScheme === "basic") {
    const username = args["auth-username"] as string | undefined
    if (!username) {
      reportError("--auth-username is required for basic auth scheme", json)
      return
    }
    auth = { scheme: "basic", username }
  } else if (authScheme) {
    reportError(`Unknown auth scheme "${authScheme}". Must be apiKey, bearer, or basic.`, json)
    return
  } else {
    // Try to derive auth from securitySchemes
    auth = deriveAuthFromSpec(schema)
  }

  // Resolve base URL — relative servers resolved against the spec URL;
  // validates overrides; fails early if no base URL can be determined.
  const baseUrlResult = resolveSpecBaseUrl(schema, specUrl, args["base-url"] as string | undefined)
  if (baseUrlResult.isErr()) {
    const e = baseUrlResult.error
    const msg =
      e.kind === "no-base-url"
        ? "could not determine a base URL from the spec's `servers`; pass --base-url"
        : e.kind === "base-url-has-variables"
          ? "the spec's server URL uses variables ({...}); pass --base-url"
          : "--base-url must be an absolute http(s) URL"
    reportError(msg, json)
    return
  }

  // Build the OpenAPI connection descriptor (select persisted so runtime enforces the same slice)
  const openapiParseResult = OpenApiConnectionSchema.safeParse({
    spec: { from: "url", url: specUrl },
    baseUrl: baseUrlResult.value,
    auth,
    maxTools,
    select,
  })
  if (!openapiParseResult.success) {
    const msg = openapiParseResult.error.issues
      .map((i: { message: string }) => i.message)
      .join(", ")
    reportError(`Invalid OpenAPI connection: ${msg}`, json)
    return
  }

  const openapi = openapiParseResult.data

  const platformParseResult = PlatformSchema.safeParse({
    id: args.id as string,
    kind: "openapi",
    displayName: args["display-name"] as string,
    openapi,
  })
  if (!platformParseResult.success) {
    const msg = platformParseResult.error.issues
      .map((i: { message: string }) => i.message)
      .join(", ")
    reportError(`Invalid platform: ${msg}`, json)
    return
  }

  const platform: Platform = platformParseResult.data

  const repos = await openDb(json)
  if (!repos) return

  // Cache the dereferenced spec to ~/.junction/openapi/<platformId>.json
  const { getPaths, openapiSpecCacheFile } = await import("@junction/core")
  const paths = getPaths()
  const cacheFile = openapiSpecCacheFile(paths, platform.id)

  try {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(schema), "utf8")
  } catch (cause) {
    reportError(`Failed to cache spec: ${String(cause)}`, json)
    return
  }

  const result = await repos.platforms.upsert(platform)
  if (result.isErr()) {
    reportDbError(result.error, json)
    return
  }

  const toolCount = toolsResult.value.length
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, platform: result.value, toolCount })}\n`)
  } else {
    consola.success(
      `Platform "${platform.displayName}" (${platform.id}) defined — kind: openapi, ${toolCount} operations`,
    )
    consola.info(`Spec cached to ${cacheFile}`)
  }
}

/** Derive auth from the spec's securitySchemes (best-effort). */
function deriveAuthFromSpec(schema: Record<string, unknown>): OpenApiConnection["auth"] {
  const components = schema.components
  if (components === null || typeof components !== "object") return undefined

  const schemes = (components as Record<string, unknown>).securitySchemes
  if (schemes === null || typeof schemes !== "object") return undefined

  for (const [, scheme] of Object.entries(schemes as Record<string, unknown>)) {
    if (scheme === null || typeof scheme !== "object") continue
    const s = scheme as Record<string, unknown>

    if (s.type === "apiKey") {
      const location = s.in
      const name = s.name
      if (
        typeof name === "string" &&
        (location === "header" || location === "query" || location === "cookie")
      ) {
        return { scheme: "apiKey", in: location, name }
      }
    }

    if (s.type === "http") {
      const httpScheme = s.scheme
      if (httpScheme === "bearer") return { scheme: "bearer", header: "Authorization" }
      if (httpScheme === "basic") {
        // Can't derive username from spec — caller must provide --auth-username
        return undefined
      }
    }

    if (s.type === "oauth2") {
      return { scheme: "oauth2" }
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// platform refresh — re-pull an OpenAPI platform's spec from its stored URL
// ---------------------------------------------------------------------------

const refreshCommand = defineCommand({
  meta: {
    name: "refresh",
    description: "Re-fetch an OpenAPI platform's spec from its stored URL and update the cache.",
  },
  args: {
    id: { type: "string", description: "Platform ID to refresh", required: true },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const id = args.id

    const repos = await openDb(json)
    if (!repos) return

    // Load the platform
    const platformResult = await repos.platforms.get(id)
    if (platformResult.isErr()) {
      const e = platformResult.error
      if (e.kind === "not-found") {
        reportError(`platform "${id}" not found`, json)
      } else {
        reportDbError(e, json)
      }
      return
    }
    const platform = platformResult.value

    // Only openapi platforms can be refreshed
    if (platform.kind !== "openapi" || !platform.openapi) {
      reportError(
        `refresh only applies to openapi platforms; "${id}" is kind "${platform.kind}"`,
        json,
      )
      return
    }

    const openapi = platform.openapi

    // Only specs added from a URL can be refreshed (inline/file have no URL to re-pull)
    if (openapi.spec.from !== "url") {
      reportError(
        `cannot refresh a spec that wasn't added from a URL; "${id}" uses spec.from="${openapi.spec.from}"`,
        json,
      )
      return
    }

    const specUrl = openapi.spec.url
    const maxTools = openapi.maxTools ?? 75

    // Lazy-import openapi-client
    const { parseSpec, extractTools, countOperationsByTag, resolveSpecBaseUrl } = await import(
      "@junction/openapi-client"
    )

    // Re-fetch + parse the spec
    if (!json) consola.info(`Refreshing spec for "${id}" from ${specUrl} …`)
    const specResult = await parseSpec({ from: "url", url: specUrl })
    if (specResult.isErr()) {
      reportError(formatSpecError(specResult.error), json)
      return
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
        const tagLines = tagCounts
          .map(({ tag, count }: { tag: string; count: number }) => `  ${tag}: ${count}`)
          .join("\n")
        reportError(
          `Refreshed spec has ${e.count} operations, exceeding the cap of ${e.cap}.\n` +
            `Operations by tag:\n${tagLines}\n` +
            `The existing spec and platform descriptor have been kept unchanged.`,
          json,
        )
        return
      }
      reportError(`Failed to extract tools from refreshed spec: ${e.kind}`, json)
      return
    }

    const newCount = toolsResult.value.length

    const { getPaths, openapiSpecCacheFile } = await import("@junction/core")
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
      reportError(`Failed to cache refreshed spec: ${String(cause)}`, json)
      return
    }

    // Upsert with the refreshed descriptor (preserving auth, select, maxTools, displayName)
    const updatedPlatform: Platform = {
      ...platform,
      openapi: { ...openapi, baseUrl },
    }
    const upsertResult = await repos.platforms.upsert(updatedPlatform)
    if (upsertResult.isErr()) {
      reportDbError(upsertResult.error, json)
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, platform: upsertResult.value, oldCount, newCount })}\n`,
      )
    } else {
      const delta =
        oldCount !== null ? ` (${oldCount} → ${newCount} tools)` : ` (${newCount} tools)`
      consola.success(`Platform "${platform.displayName}" (${platform.id}) refreshed${delta}`)
      consola.info(`Spec cached to ${cacheFile}`)
    }
    // A refresh that yields zero tools is usually a stale selection (the chosen
    // tag/path vanished upstream) rather than a healthy empty API — flag it.
    if (newCount === 0) {
      const hint =
        openapi.select?.tags || openapi.select?.paths
          ? " — the selected --tag/--path may no longer exist in the spec"
          : ""
      if (json) process.stderr.write(`warning: refreshed spec exposes 0 tools${hint}\n`)
      else consola.warn(`Refreshed spec exposes 0 tools${hint}`)
    }
  },
})

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all platforms.",
  },
  args: { json: JSON_ARG },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const result = await repos.platforms.list()
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    const platformList = result.value

    if (json) {
      process.stdout.write(`${JSON.stringify(platformList)}\n`)
      return
    }

    if (platformList.length === 0) {
      process.stdout.write('No platforms yet. Use "junction platform add" to define a source.\n')
      return
    }

    const lines = [
      "  id                      kind     transport  display name",
      "  ----------------------  -------  ---------  --------------------------------",
      ...platformList.map((p: Platform) => {
        const transport = p.connection?.transport ?? (p.openapi ? "openapi" : "-")
        return `  ${p.id.padEnd(22)}  ${p.kind.padEnd(7)}  ${transport.padEnd(9)}  ${p.displayName}`
      }),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

// ---------------------------------------------------------------------------
// platform remove — delete a platform (RESTRICT FK: fails if credentials reference it)
// ---------------------------------------------------------------------------

const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a platform (fails if credentials still reference it).",
  },
  args: {
    id: {
      type: "string",
      description: "Platform ID",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    // platforms.delete returns not-found when no row matches (checks .changes),
    // and in-use when a FK RESTRICT fires (credentials or source_refs reference it).
    const result = await repos.platforms.delete(args.id)
    if (result.isErr()) {
      const e = result.error
      if (e.kind === "in-use") {
        // platforms.id is RESTRICT-referenced by both credentials.platformId AND
        // source_refs.platformId — so either a credential or a source ref can block removal.
        reportInUseError(
          json,
          `platform "${args.id}" is in use by one or more credentials or sources; remove those first`,
        )
        return
      }
      reportDbError(e, json)
      return
    }

    reportIdRemoved(json, args.id, "Platform")
  },
})

export const platformCommand = defineCommand({
  meta: {
    name: "platform",
    description: "Manage source platforms (MCP, OpenAPI/REST).",
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
    remove: removeCommand,
    refresh: refreshCommand,
  },
})
