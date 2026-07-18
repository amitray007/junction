// SPDX-License-Identifier: AGPL-3.0-only
// `junction platform` — platform management commands: `add`, `list`.
// SOURCE-AGNOSTIC: no vendor/GitHub-specific logic. Platforms are generic DATA rows.
// Edge stays thin: argv → @junction/platform-orchestration → format output. No business
// logic here — domain assembly (spec fetch/parse, tool extraction, auth resolution,
// sandbox probing, spec caching) lives in @junction/platform-orchestration.

import type { Platform, Repositories } from "@junction/core"
import { getPaths, loadCustomDesigns, mergeDesigns } from "@junction/core"
import type {
  AddCliPlatformResult,
  AddGraphQlPlatformResult,
  AddHttpPlatformResult,
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
 * Upsert a fully-assembled platform and emit the shared add-success output
 * (JSON `{ok:true, platform, toolCount}` or the text success line). Shared by the
 * cli + http add paths, which differed only in the `kind:` label. A DB failure is
 * already reported by upsertPlatform; this is a no-op then.
 */
async function persistAndReport(
  platform: Platform,
  toolCount: number,
  kind: string,
  json: boolean,
): Promise<void> {
  const persisted = await upsertPlatform(platform, json)
  if (!persisted) return
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, platform: persisted, toolCount })}\n`)
  } else {
    consola.success(
      `Platform "${persisted.displayName}" (${persisted.id}) defined — kind: ${kind}, ${toolCount} tool(s)`,
    )
  }
}

/**
 * Reconstruct the exact user-facing error string the original inlined logic produced,
 * from a PlatformOrchestrationError. `context` disambiguates the two "too-many-tools"
 * strings (add vs. refresh) and the two "spec-cache-failed" strings.
 */
function formatOrchestrationError(
  e: PlatformOrchestrationError,
  context: "add" | "add-graphql" | "add-http" | "refresh",
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
      return context === "add-http"
        ? `Invalid HTTP descriptor: ${e.message}`
        : `Invalid CLI descriptor: ${e.message}`
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
    case "verify-op-invalid":
      return `--verify-op is invalid: ${e.message}`
    case "full-access-not-yet-supported":
      // A full-access CLI descriptor was submitted via the declared-add path.
      // Full CLI access is installed via `--full-access` (discovery flow, inc 41.4),
      // not via `--descriptor`. Until 41.4 lands this is a hard, honest refusal.
      return "full-access CLI platforms are not added via --descriptor; use `--full-access` (binary discovery flow)"
    case "invalid-binary-name":
      return `"${e.name}" is not a valid bare command name (no slashes/metacharacters allowed)`
    case "binary-not-found":
      return `could not find "${e.name}" on PATH or in common install dirs; pass --path to point at it manually`
    case "binary-path-invalid":
      return `--path "${e.path}" is invalid: ${e.reason}`
    case "sandbox-unavailable":
      return "no sandbox backend available on this host (Seatbelt on macOS, bubblewrap on Linux) — Full CLI access install requires one to extract the command schema"
    case "extract-refused":
      return `sandbox refused to run "--help" against the pinned binary: ${String(e.cause)}`
    case "not-full-access":
      return `shortcuts can only be set on a Full CLI access platform (this platform is kind "${e.platformKind}")`
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
    "verify-op": {
      type: "string",
      description:
        "[openapi] operationId used by verify-on-add/test-connection — must be a GET with no required params",
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
    // CLI / HTTP flags
    descriptor: {
      type: "string",
      description:
        "[cli/http] JSON descriptor string (CliConnectionSchema for --kind cli, " +
        "HttpConnectionSchema for --kind http). Use --descriptor '$(cat file.json)'",
    },
    // Full CLI access flags (inc 41.4 — discovery/install path, --kind cli only)
    "full-access": {
      type: "boolean",
      description:
        "[cli] Install Full CLI access: discover the binary by --name, extract its " +
        "--help tree (sandboxed), and let agents drive it via execute/help. " +
        "Mutually exclusive with --descriptor.",
      default: false,
    },
    name: {
      type: "string",
      description: "[cli/--full-access] Bare binary name to discover (e.g. gh)",
    },
    net: {
      type: "string",
      description:
        "[cli/--full-access] host:port to allow the binary to reach (repeatable: " +
        "--net api.github.com:443). Default: no network.",
    },
    "credential-env": {
      type: "string",
      description:
        "[cli/--full-access] Env-var name the bound credential's secret is injected under.",
    },
    "binary-path": {
      type: "string",
      description:
        "[cli/--full-access] Absolute path override — skip discovery and pin this binary directly.",
    },
    json: JSON_ARG,
  },
  async run({ args, rawArgs }) {
    const json = args.json ?? false
    const kind = args.kind ?? "mcp"

    // --verify-op only makes sense for openapi (it names an operationId in that
    // platform's spec) — reject it early for every other kind with a clean error,
    // rather than silently ignoring it.
    if (args["verify-op"] !== undefined && kind !== "openapi") {
      reportError(`--verify-op is only supported for --kind openapi (got "${kind}")`, json)
      return
    }

    if (kind === "openapi") {
      await addOpenApiPlatform(args, rawArgs, json)
      return
    }

    if (kind === "graphql") {
      await addGraphQlPlatform(args, rawArgs, json)
      return
    }

    if (kind === "cli") {
      if (args["full-access"]) {
        await addFullAccessCliPlatformCommand(args, rawArgs, json)
        return
      }
      await addCliPlatform(args, json)
      return
    }

    if (kind === "http") {
      await addHttpPlatform(args, json)
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
    verifyOperationId: args["verify-op"] as string | undefined,
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

  await persistAndReport(platform, toolCount, "cli", json)
}

// ---------------------------------------------------------------------------
// addFullAccessCliPlatformCommand — handle --kind cli --full-access add path
// (inc 41.4): discover the binary (or use --binary-path), extract its --help
// tree sandboxed, and upsert a Full CLI access platform.
// ---------------------------------------------------------------------------

interface FullAccessJsonReport {
  ok: true
  candidates: Array<{ path: string; realpath: string; version?: string; source: string }>
  chosen: string
  nodeCount: number
  truncated: boolean
  platform: unknown
}

async function addFullAccessCliPlatformCommand(
  args: Record<string, unknown>,
  rawArgs: string[],
  json: boolean,
): Promise<void> {
  const name = args.name as string | undefined
  const binaryPathOverride = args["binary-path"] as string | undefined

  if (!name && !binaryPathOverride) {
    reportError(
      "--name (binary to discover) or --binary-path (manual override) is required for --full-access",
      json,
    )
    return
  }

  const { discoverBinary } = await import("@junction/core")
  const netHosts = collectRepeatableFlag(rawArgs, "--net")
  const credentialEnvVar = args["credential-env"] as string | undefined

  let chosenRealpath: string
  let candidateReport: FullAccessJsonReport["candidates"] = []

  if (binaryPathOverride) {
    chosenRealpath = binaryPathOverride
  } else {
    if (!json) consola.info(`Discovering "${name}" …`)
    const discoverResult = await discoverBinary(name as string)
    if (discoverResult.isErr()) {
      reportError(`"${name}" is not a valid bare command name`, json)
      return
    }
    const candidates = discoverResult.value
    candidateReport = candidates.map((c) => ({
      path: c.path,
      realpath: c.realpath,
      ...(c.version !== undefined ? { version: c.version } : {}),
      source: c.source,
    }))
    const recommended = candidates[0]
    if (!recommended) {
      reportError(
        `could not find "${name}" on PATH or in common install dirs; pass --binary-path to point at it manually`,
        json,
      )
      return
    }
    chosenRealpath = recommended.realpath
    if (!json) consola.info(`Found "${name}" at ${chosenRealpath} — extracting --help tree …`)
  }

  const { addFullAccessCliPlatform } = await import("@junction/platform-orchestration")
  const result = await addFullAccessCliPlatform({
    id: args.id as string,
    displayName: args["display-name"] as string,
    binaryPath: chosenRealpath,
    ...(credentialEnvVar ? { credentialEnvVar } : {}),
    ...(netHosts.length > 0 ? { allowNet: netHosts } : {}),
  })
  if (result.isErr()) {
    reportError(formatOrchestrationError(result.error, "add"), json)
    return
  }

  const { platform, nodeCount, truncated } = result.value
  const persisted = await upsertPlatform(platform, json)
  if (!persisted) return

  if (json) {
    // Report the ACTUALLY-pinned path: addFullAccessCliPlatform realpath-resolves
    // the binary before storing it (inc 41 review #1), so a manual --binary-path
    // override or a symlink is reported as its resolved realpath, matching what
    // execute will run — not the raw input string.
    const pinnedPath =
      persisted.cli?.mode === "full-access" ? persisted.cli.binaryPath : chosenRealpath
    const report: FullAccessJsonReport = {
      ok: true,
      candidates: candidateReport,
      chosen: pinnedPath,
      nodeCount,
      truncated,
      platform: persisted,
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    consola.success(
      `Platform "${persisted.displayName}" (${persisted.id}) defined — kind: cli, Full CLI access, ` +
        `${nodeCount} command node(s) mapped${truncated ? " (partial — probe ceiling reached; remaining nodes explore lazily)" : ""}`,
    )
  }
}

// ---------------------------------------------------------------------------
// addHttpPlatform — handle --kind http add path
// ---------------------------------------------------------------------------

async function addHttpPlatform(args: Record<string, unknown>, json: boolean): Promise<void> {
  const descriptorStr = args.descriptor as string | undefined
  if (!descriptorStr) {
    reportError(
      "--descriptor is required for http kind. Pass the HttpConnectionSchema JSON inline:\n" +
        '  --descriptor \'{"baseUrl":"https://api.example.com","tools":[...]}\'\n' +
        '  --descriptor "$(cat http-descriptor.json)"',
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

  const { addHttpPlatform: addHttp } = await import("@junction/platform-orchestration")
  const result = await addHttp({
    id: args.id as string,
    displayName: args["display-name"] as string,
    descriptor,
  })
  if (result.isErr()) {
    reportError(formatOrchestrationError(result.error, "add-http"), json)
    return
  }

  const { platform, toolCount }: AddHttpPlatformResult = result.value
  await persistAndReport(platform, toolCount, "http", json)
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

// ---------------------------------------------------------------------------
// platform cli-shortcut add/remove — headless editing surface for a Full CLI
// access platform's shortcuts[] (increment 41.5). Mirrors the web ShortcutsPanel:
// same CliTool descriptor shape, same wholesale-replace semantics as upsert.
// ---------------------------------------------------------------------------

/** Load a platform, refuse cleanly if it doesn't exist or isn't kind:"cli". */
async function loadCliPlatform(
  id: string,
  json: boolean,
): Promise<{ repos: Repositories; platform: Platform } | null> {
  const repos = await openDb(json)
  if (!repos) return null
  const result = await repos.platforms.get(id)
  if (result.isErr()) {
    if (result.error.kind === "not-found") {
      reportError(`platform "${id}" not found`, json)
    } else {
      reportDbError(result.error, json)
    }
    return null
  }
  const platform = result.value
  if (platform.kind !== "cli" || !platform.cli) {
    reportError(`platform "${id}" is kind "${platform.kind}", not "cli"`, json)
    return null
  }
  return { repos, platform }
}

/** Parse a --descriptor JSON string into a raw object, reporting a clean error on bad JSON. */
function parseDescriptorArg(descriptorStr: string | undefined, json: boolean): unknown | null {
  if (!descriptorStr) {
    reportError(
      "--descriptor is required. Pass a single CliTool JSON object:\n" +
        '  --descriptor \'{"name":"pr_list","argv":[...],"policy":{...}}\'\n' +
        '  --descriptor "$(cat shortcut.json)"',
      json,
    )
    return null
  }
  try {
    return JSON.parse(descriptorStr) as unknown
  } catch (cause) {
    reportError(`--descriptor is not valid JSON: ${String(cause)}`, json)
    return null
  }
}

/** Read the platform's current shortcuts[] (empty if none yet, e.g. declared mode has no slot at all). */
function currentShortcuts(platform: Platform): unknown[] {
  const cli = platform.cli as { mode?: string; shortcuts?: unknown[] } | undefined
  return cli?.mode === "full-access" ? (cli.shortcuts ?? []) : []
}

async function runShortcutSet(
  args: Record<string, unknown>,
  nextShortcuts: unknown[],
): Promise<void> {
  const json = (args.json as boolean | undefined) ?? false
  const platformId = args.platform as string | undefined
  if (!platformId) {
    reportError("--platform is required", json)
    return
  }

  const loaded = await loadCliPlatform(platformId, json)
  if (!loaded) return
  const { repos, platform } = loaded

  const { setFullAccessCliShortcuts } = await import("@junction/platform-orchestration")
  // nextShortcuts is unvalidated JSON at this point (parsed from --descriptor,
  // same trust level as the `add --descriptor` path's `unknown`) —
  // setFullAccessCliShortcuts re-validates every element through
  // CliConnectionSchema.safeParse (via a throwaway single-tool parse) before
  // it can reach storage; this cast just satisfies the parameter type ahead
  // of that authoritative check, it grants no extra trust.
  const updateResult = setFullAccessCliShortcuts({
    platform,
    shortcuts: nextShortcuts as Parameters<typeof setFullAccessCliShortcuts>[0]["shortcuts"],
  })
  if (updateResult.isErr()) {
    reportError(formatOrchestrationError(updateResult.error, "add"), json)
    return
  }

  const upsertResult = await repos.platforms.upsert(updateResult.value)
  if (upsertResult.isErr()) {
    reportDbError(upsertResult.error, json)
    return
  }

  const persisted = upsertResult.value
  const shortcutCount =
    persisted.cli && "mode" in persisted.cli && persisted.cli.mode === "full-access"
      ? (persisted.cli.shortcuts?.length ?? 0)
      : 0

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, platform: persisted, shortcutCount })}\n`)
  } else {
    consola.success(
      `Platform "${persisted.displayName}" (${persisted.id}) — ${shortcutCount} shortcut(s)`,
    )
  }
}

const cliShortcutAddCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add (or replace, by name) a named shortcut on a Full CLI access platform.",
  },
  args: {
    platform: { type: "string", description: "Platform ID", required: true },
    descriptor: {
      type: "string",
      description: "CliTool JSON descriptor for the shortcut (name/argv/args/policy).",
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const descriptor = parseDescriptorArg(args.descriptor, json)
    if (descriptor === null) return
    const name = (descriptor as { name?: unknown }).name
    if (typeof name !== "string" || !name) {
      reportError('--descriptor must have a string "name" field', json)
      return
    }

    const loaded = await loadCliPlatform(args.platform, json)
    if (!loaded) return
    const existing = currentShortcuts(loaded.platform)
    // Add-or-replace-by-name: a shortcut with the same name is replaced in
    // place (matches the web form's edit-in-place UX), not duplicated.
    const next = [...existing.filter((s) => (s as { name?: unknown }).name !== name), descriptor]
    await runShortcutSet(args as Record<string, unknown>, next)
  },
})

const cliShortcutRemoveCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a named shortcut from a Full CLI access platform.",
  },
  args: {
    platform: { type: "string", description: "Platform ID", required: true },
    name: { type: "string", description: "Shortcut name to remove", required: true },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const loaded = await loadCliPlatform(args.platform, json)
    if (!loaded) return
    const existing = currentShortcuts(loaded.platform)
    const next = existing.filter((s) => (s as { name?: unknown }).name !== args.name)
    if (next.length === existing.length) {
      reportError(`no shortcut named "${args.name}" on platform "${args.platform}"`, json)
      return
    }
    await runShortcutSet(args as Record<string, unknown>, next)
  },
})

const cliShortcutCommand = defineCommand({
  meta: {
    name: "cli-shortcut",
    description: "Manage named shortcuts (saved commands) on a Full CLI access platform.",
  },
  subCommands: {
    add: cliShortcutAddCommand,
    remove: cliShortcutRemoveCommand,
  },
})

// ---------------------------------------------------------------------------
// set-oauth-design (increment 45, Slice D4) — bind a platform to an OAuth
// design (built-in OR custom:<slug>), validated against the MERGED set (the
// same lookup the resolver/refresh path uses) so a typo or a design that was
// never created fails closed here rather than at the next refresh attempt.
// Minimal, additive: does NOT touch the per-kind add/update assembly — a
// platform's connection fields are unaffected, only oauthProviderId changes.
// ---------------------------------------------------------------------------

const setOAuthDesignCommand = defineCommand({
  meta: {
    name: "set-oauth-design",
    description:
      "Bind a platform to an OAuth design (built-in id or custom:<slug>) — validated against the live design set.",
  },
  args: {
    platform: { type: "positional", description: "Platform ID", required: true },
    design: {
      type: "positional",
      description: "OAuth design id — a built-in (e.g. github) or custom:<slug>",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const platformResult = await repos.platforms.get(args.platform)
    if (platformResult.isErr()) {
      reportDbError(platformResult.error, json)
      return
    }

    const customResult = await loadCustomDesigns(getPaths())
    if (customResult.isErr()) {
      reportError(`custom designs store: ${customResult.error.kind}`, json)
      return
    }
    const merged = mergeDesigns(customResult.value)
    if (!merged.has(args.design)) {
      reportError(
        `unknown OAuth design "${args.design}" — not a built-in id and no custom design with that id exists`,
        json,
      )
      return
    }

    const updated: Platform = { ...platformResult.value, oauthProviderId: args.design }
    const upsertResult = await repos.platforms.upsert(updated)
    if (upsertResult.isErr()) {
      reportDbError(upsertResult.error, json)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, platform: upsertResult.value })}\n`)
    } else {
      consola.success(`Platform "${args.platform}" bound to OAuth design "${args.design}"`)
    }
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
    "cli-shortcut": cliShortcutCommand,
    "set-oauth-design": setOAuthDesignCommand,
  },
})
