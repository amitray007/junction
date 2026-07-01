// SPDX-License-Identifier: AGPL-3.0-only
// `junction platform` — platform management commands: `add`, `list`.
// SOURCE-AGNOSTIC: no vendor/GitHub-specific logic. Platforms are generic DATA rows.
// Edge stays thin: argv → @junction/platform-orchestration → format output. No business
// logic here — domain assembly (spec fetch/parse, tool extraction, auth resolution,
// sandbox probing, spec caching) lives in @junction/platform-orchestration.

import type { Platform } from "@junction/core"
import type {
  AddCliPlatformResult,
  AddGraphQlPlatformResult,
  AddMcpPlatformInput,
  AddOpenApiPlatformResult,
  AuthInput,
  PlatformOrchestrationError,
  RefreshOpenApiPlatformResult,
} from "@junction/platform-orchestration"
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

/** Open the DB, upsert the platform, and report any DB errors. */
async function upsertPlatform(platform: Platform, json: boolean): Promise<Platform | null> {
  const repos = await openDb(json)
  if (!repos) return null
  const result = await repos.platforms.upsert(platform)
  if (result.isErr()) {
    reportDbError(result.error, json)
    return null
  }
  return result.value
}

/**
 * Reconstruct the exact user-facing error string the original inlined logic produced,
 * from a PlatformOrchestrationError. `context` disambiguates the two "too-many-tools"
 * strings (add vs. refresh) and the two "spec-cache-failed" strings.
 */
function formatOrchestrationError(
  e: PlatformOrchestrationError,
  context: "add" | "add-graphql" | "refresh",
  id?: string,
): string {
  switch (e.kind) {
    case "invalid-transport":
      return `unknown transport "${e.transport}": must be "http" or "stdio"`
    case "missing-field":
      if (e.field === "url") return "--url is required for http transport"
      if (e.field === "command") return "--command is required for stdio transport"
      if (e.field === "auth-name") return "--auth-name is required for apiKey auth scheme"
      if (e.field === "auth-username") return "--auth-username is required for basic auth scheme"
      return `${e.field} is required for ${e.context}`
    case "spec-fetch-failed":
      return `Failed to fetch spec: ${String(e.cause)}`
    case "spec-parse-failed":
      return `Failed to parse spec: ${String(e.cause)}`
    case "too-many-tools": {
      const tagLines = e.tagCounts.map(({ tag, count }) => `  ${tag}: ${count}`).join("\n")
      const head = `Spec has ${e.count} operations, exceeding the cap of ${e.cap}.\nOperations by tag:\n${tagLines}\n`
      return context === "add"
        ? `${head}Narrow with --tag <name> and/or --path <prefix> to add a slice, or pick a smaller spec.`
        : `${head}The existing spec and platform descriptor have been kept unchanged.`
    }
    case "extract-failed":
      return context === "add"
        ? `Failed to extract tools: ${e.extractKind}`
        : `Failed to extract tools from refreshed spec: ${e.extractKind}`
    case "base-url":
      return e.reason === "no-base-url"
        ? "could not determine a base URL from the spec's `servers`; pass --base-url"
        : e.reason === "base-url-has-variables"
          ? "the spec's server URL uses variables ({...}); pass --base-url"
          : "--base-url must be an absolute http(s) URL"
    case "invalid-connection":
      // buildPlatformAuth surfaces two raw (un-prefixed) messages as "invalid-connection";
      // everything else at this kind is a Zod validation failure from the connection schema.
      if (e.message.startsWith("auth-in must be"))
        return "--auth-in must be header, query, or cookie"
      if (e.message.startsWith("Unknown auth scheme")) return e.message
      if (e.message.startsWith("endpoint must be a valid URL"))
        return `--endpoint must be a valid URL: "${e.message.slice(e.message.indexOf('"') + 1, -1)}"`
      return context === "add-graphql"
        ? `Invalid GraphQL connection: ${e.message}`
        : `Invalid OpenAPI connection: ${e.message}`
    case "invalid-platform":
      return `Invalid platform: ${e.message}`
    case "apikey-in-query-unsupported":
      return "--auth-in query is not supported for graphql (single POST endpoint); use --auth-in header (or cookie)"
    case "invalid-descriptor":
      return `Invalid CLI descriptor: ${e.message}`
    case "policy-invalid":
      return `Tool "${e.toolName}" has an invalid policy: ${e.reason}`
    case "spec-cache-failed":
      return context === "add"
        ? `Failed to cache spec: ${String(e.cause)}`
        : `Failed to cache refreshed spec: ${String(e.cause)}`
    case "not-openapi":
      return `refresh only applies to openapi platforms; "${id}" is kind "${e.platformKind}"`
    case "not-url-spec":
      return `cannot refresh a spec that wasn't added from a URL; "${id}" uses spec.from="${e.specFrom}"`
  }
}

/** Build the shared AuthInput from --auth-scheme/--auth-in/--auth-name/--auth-username flags. */
function buildAuthInput(args: Record<string, unknown>): AuthInput {
  return {
    scheme: args["auth-scheme"] as AuthInput["scheme"],
    in: args["auth-in"] as AuthInput["in"],
    name: args["auth-name"] as string | undefined,
    username: args["auth-username"] as string | undefined,
  }
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
    // GraphQL flags
    endpoint: {
      type: "string",
      description: "[graphql] GraphQL endpoint URL",
    },
    header: {
      type: "string",
      description:
        "[graphql] Extra request header in key=value form (repeatable: --header User-Agent=junction)",
    },
    // CLI flags
    descriptor: {
      type: "string",
      description:
        "[cli] JSON descriptor string (CliConnectionSchema). Use --descriptor '$(cat file.json)'",
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

    if (kind === "graphql") {
      await addGraphQlPlatform(args, rawArgs, json)
      return
    }

    if (kind === "cli") {
      await addCliPlatform(args, json)
      return
    }

    // MCP platform
    const transport = args.transport
    if (!transport) {
      reportError("--transport is required for mcp kind", json)
      return
    }
    if (transport !== "http" && transport !== "stdio") {
      reportError(`unknown transport "${transport}": must be "http" or "stdio"`, json)
      return
    }

    const { addMcpPlatform } = await import("@junction/platform-orchestration")
    const input: AddMcpPlatformInput = {
      id: args.id,
      displayName: args["display-name"],
      transport,
      url: args.url,
      authHeader: args["auth-header"],
      command: args.command,
      args: transport === "stdio" ? collectRepeatableFlag(rawArgs, "--arg") : undefined,
      tokenEnvVar: args["token-env"],
    }
    const result = await addMcpPlatform(input)
    if (result.isErr()) {
      reportError(formatOrchestrationError(result.error, "add"), json)
      return
    }

    const persisted = await upsertPlatform(result.value, json)
    if (!persisted) return

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, platform: persisted })}\n`)
    } else {
      consola.success(
        `Platform "${persisted.displayName}" (${persisted.id}) defined — transport: ${transport}`,
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

  if (!json) consola.info(`Fetching spec from ${specUrl} …`)

  const { addOpenApiPlatform: addOpenApi } = await import("@junction/platform-orchestration")
  const maxTools = args["max-tools"] ? parseInt(args["max-tools"] as string, 10) : undefined
  const result = await addOpenApi({
    id: args.id as string,
    displayName: args["display-name"] as string,
    specUrl,
    baseUrl: args["base-url"] as string | undefined,
    auth: buildAuthInput(args),
    maxTools,
    select,
  })
  if (result.isErr()) {
    reportError(formatOrchestrationError(result.error, "add"), json)
    return
  }

  const { platform, toolCount, cacheFile }: AddOpenApiPlatformResult = result.value

  /* jscpd:ignore-start — persist+report tail is structurally identical to the MCP/GraphQL/CLI
     add paths (same upsert helper, different kind/field + success wording); the distinct
     per-kind message text is the point. Deferred until a shared reporter earns its keep. */
  const persisted = await upsertPlatform(platform, json)
  if (!persisted) return

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, platform: persisted, toolCount })}\n`)
  } else {
    consola.success(
      `Platform "${persisted.displayName}" (${persisted.id}) defined — kind: openapi, ${toolCount} operations`,
    )
    consola.info(`Spec cached to ${cacheFile}`)
  }
  /* jscpd:ignore-end */
}

// ---------------------------------------------------------------------------
// addGraphQlPlatform — handle --kind graphql add path
// ---------------------------------------------------------------------------

async function addGraphQlPlatform(
  args: Record<string, unknown>,
  rawArgs: string[],
  json: boolean,
): Promise<void> {
  const endpoint = args.endpoint as string | undefined
  if (!endpoint) {
    reportError("--endpoint is required for graphql kind", json)
    return
  }

  // Validate endpoint URL
  try {
    new URL(endpoint)
  } catch {
    reportError(`--endpoint must be a valid URL: "${endpoint}"`, json)
    return
  }

  // Collect repeatable --header key=value flags
  const rawHeaders = collectRepeatableFlag(rawArgs, "--header")
  const defaultHeaders: Record<string, string> = {}
  for (const h of rawHeaders) {
    const eqIdx = h.indexOf("=")
    if (eqIdx < 1) {
      reportError(`--header value must be in key=value form, got: "${h}"`, json)
      return
    }
    defaultHeaders[h.slice(0, eqIdx)] = h.slice(eqIdx + 1)
  }

  if (!json) consola.info(`Introspecting schema at ${endpoint} …`)

  const { addGraphQlPlatform: addGraphQl } = await import("@junction/platform-orchestration")
  const result = await addGraphQl({
    id: args.id as string,
    displayName: args["display-name"] as string,
    endpoint,
    auth: buildAuthInput(args),
    defaultHeaders,
  })
  if (result.isErr()) {
    reportError(formatOrchestrationError(result.error, "add-graphql"), json)
    return
  }

  const { platform, sdlCached }: AddGraphQlPlatformResult = result.value

  if (!sdlCached && !json) {
    consola.warn(
      "Could not introspect schema (introspection may be disabled or require auth). " +
        "graphql_schema will attempt live introspection at call time.",
    )
  } else if (!json) {
    consola.success("Schema introspected and cached.")
  }

  const persisted = await upsertPlatform(platform, json)
  if (!persisted) return

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, platform: persisted })}\n`)
  } else {
    const sdlNote = sdlCached ? " (SDL cached)" : " (no SDL cached)"
    consola.success(
      `Platform "${persisted.displayName}" (${persisted.id}) defined — kind: graphql${sdlNote}`,
    )
  }
}

// ---------------------------------------------------------------------------
// addCliPlatform — handle --kind cli add path
// ---------------------------------------------------------------------------

async function addCliPlatform(args: Record<string, unknown>, json: boolean): Promise<void> {
  const descriptorStr = args.descriptor as string | undefined
  if (!descriptorStr) {
    reportError(
      "--descriptor is required for cli kind. Pass the CliConnectionSchema JSON inline:\n" +
        "  --descriptor '{\"tools\":[...]}'\n" +
        '  --descriptor "$(cat cli-descriptor.json)"',
      json,
    )
    return
  }

  // Parse the JSON string
  let descriptor: unknown
  try {
    descriptor = JSON.parse(descriptorStr) as unknown
  } catch (cause) {
    reportError(`--descriptor is not valid JSON: ${String(cause)}`, json)
    return
  }

  const { addCliPlatform: addCli } = await import("@junction/platform-orchestration")
  const result = await addCli({
    id: args.id as string,
    displayName: args["display-name"] as string,
    descriptor,
  })
  if (result.isErr()) {
    reportError(formatOrchestrationError(result.error, "add"), json)
    return
  }

  const { platform, toolCount, sandboxWarning }: AddCliPlatformResult = result.value

  if (sandboxWarning) {
    if (json) process.stderr.write(`warning: ${sandboxWarning}\n`)
    else consola.warn(sandboxWarning)
  }

  const persisted = await upsertPlatform(platform, json)
  if (!persisted) return

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, platform: persisted, toolCount })}\n`)
  } else {
    consola.success(
      `Platform "${persisted.displayName}" (${persisted.id}) defined — kind: cli, ${toolCount} tool(s)`,
    )
  }
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

    // Only specs added from a URL can be refreshed (inline/file have no URL to re-pull)
    if (platform.openapi.spec.from !== "url") {
      reportError(
        `cannot refresh a spec that wasn't added from a URL; "${id}" uses spec.from="${platform.openapi.spec.from}"`,
        json,
      )
      return
    }

    if (!json) consola.info(`Refreshing spec for "${id}" from ${platform.openapi.spec.url} …`)

    const { refreshOpenApiPlatform } = await import("@junction/platform-orchestration")
    const result = await refreshOpenApiPlatform({ platform })
    if (result.isErr()) {
      reportError(formatOrchestrationError(result.error, "refresh", id), json)
      return
    }

    const {
      platform: updatedPlatform,
      oldCount,
      newCount,
      cacheFile,
      zeroToolsWarning,
    }: RefreshOpenApiPlatformResult = result.value

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
    if (zeroToolsWarning) {
      if (json) process.stderr.write(`warning: ${zeroToolsWarning}\n`)
      else consola.warn(zeroToolsWarning)
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
