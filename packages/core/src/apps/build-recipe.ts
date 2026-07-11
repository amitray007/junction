// SPDX-License-Identifier: AGPL-3.0-only
// build-recipe.ts — interprets a catalog surface's declarative `build` recipe
// (BuildRecipeSchema, catalog-schema.ts:122) into a concrete connect plan.
// Increment 30.11 (§4 Slice A). PURE — no I/O, no fetch, no fs; every input is
// already-loaded catalog data + the user's in-dialog choice. `core` imports
// nothing else in-repo (docs/rules/typescript.md; depcruise
// core-imports-nothing-in-repo) — this module defines its OWN PlatformInput
// shapes rather than importing @junction/platform-orchestration's Add*Input
// types; the caller (source-runtime's connect-from-catalog, which DOES depend
// on platform-orchestration) maps these onto the real add* calls.
//
// THE LOAD-BEARING PRECEDENCE RULE (method file §0 fact 2 / §4 item 1): the
// user's chosen `authMode` selects the credential kind for a "credential" plan
// — token/byo ALWAYS map to "bearer" + `auth:{scheme:"bearer"}` on the
// flattened platform input, REGARDLESS of the recipe's `build.credential.kind`
// (which is very often "oauth2" — that's the surface's DEFAULT auth, not what
// a token-mode connect should mint). The recipe's kind is only ever used as
// the fallback when the surface offers exactly one auth mode. oauth2 mode
// never reaches a "credential" plan at all — it's always an "oauth-handoff"
// (30.11 ships no inline oauth2 write; see the method file's scope decision).

import type { CliTool } from "../schema/cli-connection.js"
import type { HttpRequestTool } from "../schema/http-connection.js"
import type { AppAuth, AppCatalogEntry, AppSurface } from "./catalog-schema.js"

// ---------------------------------------------------------------------------
// Inputs the caller assembles from the catalog + the user's dialog choice
// ---------------------------------------------------------------------------

export interface ConnectChoice {
  authMode: "oauth2" | "token" | "byo" | "none"
}

// ---------------------------------------------------------------------------
// The credential kind a "credential" plan mints — a strict subset of
// CredentialKindForBuildSchema minus "oauth2" (oauth2 never reaches this path;
// it is always routed to "oauth-handoff" before a credentialKind is chosen).
// ---------------------------------------------------------------------------

export type ConnectCredentialKind = "api-key" | "bearer" | "file" | "env"

/** A minimal bearer-or-none auth descriptor — the only shapes this interpreter mints. */
export type FlattenedAuth = { scheme: "bearer" } | undefined

// ---------------------------------------------------------------------------
// via:"flattened" platform inputs — a small, core-owned shape per kind (NOT
// the orchestration Add*Input types — core must not depend on
// @junction/platform-orchestration). The source-runtime executor maps these
// 1:1 onto the real addMcpPlatform/addOpenApiPlatform/addGraphQlPlatform calls.
// ---------------------------------------------------------------------------

export interface FlattenedMcpInput {
  kind: "mcp"
  transport: "http" | "stdio"
  url?: string
  authHeader?: string
  command?: string
  args?: string[]
  tokenEnvVar?: string
  env?: Record<string, string>
}

export interface FlattenedOpenApiInput {
  kind: "openapi"
  specUrl: string
  baseUrl?: string
  auth: FlattenedAuth
  maxTools?: number
  select?: { tags?: string[]; paths?: string[] }
  verifyOperationId?: string
}

export interface FlattenedGraphQlInput {
  kind: "graphql"
  endpoint: string
  auth: FlattenedAuth
  defaultHeaders?: Record<string, string>
}

export type FlattenedPlatformInput =
  | FlattenedMcpInput
  | FlattenedOpenApiInput
  | FlattenedGraphQlInput

/**
 * via:"descriptor" platform inputs (http/cli) — the descriptor object handed
 * to addHttpPlatform/addCliPlatform's `descriptor: unknown` field, built by
 * merging the surface's connection template with its `starterTools`.
 */
export type DescriptorPlatformInput =
  | {
      kind: "http"
      descriptor: {
        baseUrl: string
        auth: FlattenedAuth
        defaultHeaders?: Record<string, string>
        tools: HttpRequestTool[]
      }
    }
  | {
      kind: "cli"
      descriptor: {
        tools: CliTool[]
        credentialEnvVar?: string
      }
    }

export type PlatformInput = FlattenedPlatformInput | DescriptorPlatformInput

// ---------------------------------------------------------------------------
// ConnectPlan — the discriminated result of planConnect
// ---------------------------------------------------------------------------

export type ConnectPlan =
  | {
      path: "credential"
      platformInput: PlatformInput
      credentialKind: ConnectCredentialKind
      platformId: string
      kind: PlatformInput["kind"]
      /** true iff the surface's verify hint resolves to a real verify primitive. */
      verifiable: boolean
    }
  | {
      path: "oauth-handoff"
      providerId: string
      /**
       * The surface's assembled platform shape (increment 38 D2) — carried so
       * an inline catalog-connect can bind a source across the OAuth
       * authorize→callback round-trip, instead of only deep-linking to
       * `/credentials`. `undefined` iff the surface's recipe can't produce a
       * platformInput at all (a `RecipeError` — see `platformInputError`);
       * the deep-link-only fallback still works in that case.
       */
      platformInput: PlatformInput | undefined
      platformId: string
      displayName: string
    }

/** Metadata-only projection for the client — NEVER the secret, NEVER the raw recipe/connection. */
export interface ConnectPlanPreview {
  platformId: string
  kind: PlatformInput["kind"] | "oauth2-handoff"
  /** Human-readable summary of what will be connected, e.g. "REST API · base https://api.github.com". */
  connectionSummary: string
  authModes: ConnectChoice["authMode"][]
  verifiable: boolean
}

// ---------------------------------------------------------------------------
// RecipeError — typed, discriminated
// ---------------------------------------------------------------------------

export type RecipeError =
  | { kind: "auth-mode-unavailable"; requested: ConnectChoice["authMode"]; offered: string[] }
  | { kind: "descriptor-no-starter-tools"; surfaceKind: string }
  | { kind: "unsupported-via"; via: string }

function isRecipeError(value: PlatformInput | RecipeError): value is RecipeError {
  return (
    value.kind === "descriptor-no-starter-tools" || (value.kind as string) === "unsupported-via"
  )
}

// ---------------------------------------------------------------------------
// resolvePlatformId
// ---------------------------------------------------------------------------

/**
 * Substitute the recipe's `platformIdTemplate` tokens. Only "{app}" is used by
 * any shipped surface today; "{kind}" is accepted (substituted with
 * `surfaceKind`, when provided) for 30.12 shape-compat (multi-surface-per-app
 * groupability, `{app}-{kind}`) — it is a no-op today because no catalog entry
 * uses that token yet.
 */
export function resolvePlatformId(template: string, appId: string, surfaceKind?: string): string {
  let resolved = template.replaceAll("{app}", appId)
  if (surfaceKind !== undefined) {
    resolved = resolved.replaceAll("{kind}", surfaceKind)
  }
  return resolved
}

// ---------------------------------------------------------------------------
// planConnect
// ---------------------------------------------------------------------------

/**
 * Interpret a catalog surface's build recipe into a concrete ConnectPlan for
 * the user's chosen auth mode. PURE — does not touch the network, filesystem,
 * or any repo. The caller (source-runtime's connect-from-catalog) executes
 * the plan against the real add/verify/persist path.
 */
export function planConnect(
  entry: AppCatalogEntry,
  surface: AppSurface,
  choice: ConnectChoice,
): ConnectPlan | RecipeError {
  const offeredModes = surface.auth.map((a) => a.mode)
  const matchedAuth = surface.auth.find((a) => a.mode === choice.authMode)
  if (matchedAuth === undefined) {
    return { kind: "auth-mode-unavailable", requested: choice.authMode, offered: offeredModes }
  }

  if (matchedAuth.mode === "oauth2") {
    // Increment 38 D2 — widen the oauth2 short-circuit to ALSO produce the
    // surface's platformInput + displayName (previously this returned before
    // ever calling buildPlatformInput, which is why 30.11 could only
    // deep-link to /credentials). oauth2 always mints a "bearer" auth shape
    // on the assembled platform — the runtime injects the (refreshed) oauth2
    // token as a bearer credential kind-agnostically (resolve-provider.ts),
    // so the platform's connection.auth must declare `{scheme:"bearer"}` or
    // the transport layer silently never attaches the token (openapi-client /
    // graphql-client's injectAuth no-ops when `auth` is undefined).
    const platformId = resolvePlatformId(surface.build.platformIdTemplate, entry.id, surface.kind)
    const built = buildPlatformInput(surface, "bearer")
    return {
      path: "oauth-handoff",
      providerId: matchedAuth.providerId,
      // A RecipeError here (e.g. descriptor-no-starter-tools) is NOT fatal
      // to the overall oauth-handoff plan — platformInput undefined just
      // means the inline bind can't happen; the deep-link-only /credentials
      // fallback (pre-inc-38 behavior) still works.
      platformInput: isRecipeError(built) ? undefined : built,
      platformId,
      displayName: surface.displayName,
    }
  }

  // token / byo / none all mint a "credential" plan. Precedence rule: the
  // CHOSEN mode decides the credential kind, ignoring the recipe's declared
  // kind, UNLESS the surface offers a single mode (then the recipe's kind is
  // the honest default — there is no user choice to override it with).
  const credentialKind = resolveCredentialKind(surface, matchedAuth)

  const platformId = resolvePlatformId(surface.build.platformIdTemplate, entry.id, surface.kind)

  const platformInput = buildPlatformInput(surface, credentialKind)
  if (isRecipeError(platformInput)) {
    return platformInput
  }

  return {
    path: "credential",
    platformInput,
    credentialKind,
    platformId,
    kind: platformInput.kind,
    verifiable: isVerifiable(surface),
  }
}

/** Build the metadata-only preview a web client is allowed to see. */
export function toConnectPlanPreview(
  entry: AppCatalogEntry,
  surface: AppSurface,
  plan: ConnectPlan,
): ConnectPlanPreview {
  const authModes = surface.auth.map((a) => a.mode)
  if (plan.path === "oauth-handoff") {
    return {
      platformId: resolvePlatformId(surface.build.platformIdTemplate, entry.id, surface.kind),
      kind: "oauth2-handoff",
      connectionSummary: `${entry.displayName} · ${surface.displayName} — OAuth registration`,
      authModes,
      verifiable: false,
    }
  }
  return {
    platformId: plan.platformId,
    kind: plan.kind,
    connectionSummary: connectionSummary(entry, surface),
    authModes,
    verifiable: plan.verifiable,
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * The precedence rule (method file §0 fact 2, §4 item 1): the CHOSEN authMode
 * decides the credential kind for a token/byo connect — always "bearer",
 * ignoring the recipe's `build.credential.kind` (frequently "oauth2", the
 * surface's DEFAULT auth). The recipe's declared kind is used ONLY as the
 * fallback when the surface offers a single auth mode (no user choice to
 * override with) — in that case the recipe's kind IS the mode's kind by
 * construction (every shipped single-mode surface declares a non-oauth2 kind
 * whenever its only mode is token/byo).
 */
function resolveCredentialKind(surface: AppSurface, matchedAuth: AppAuth): ConnectCredentialKind {
  if (matchedAuth.mode === "token" || matchedAuth.mode === "byo") {
    if (surface.auth.length === 1) {
      // Single-mode surface: trust the recipe's declared kind (already
      // guaranteed non-oauth2 by catalog authoring — the mode IS token/byo).
      const recipeKind = surface.build.credential.kind
      if (recipeKind !== "oauth2") return recipeKind
    }
    return "bearer"
  }
  // mode === "none" — no credential is minted; "bearer" is a structurally
  // inert placeholder (verify/add for a "none" surface is out of scope here;
  // no shipped surface offers only "none").
  return "bearer"
}

function isVerifiable(surface: AppSurface): boolean {
  const verify = surface.verify
  if (verify === undefined) return false
  switch (verify.kind) {
    case "openapi":
      return (
        surface.connection.kind === "openapi" && surface.connection.verifyOperationId !== undefined
      )
    case "mcp":
      return surface.connection.kind === "mcp"
    case "graphql":
      return surface.connection.kind === "graphql"
    case "none":
      return false
    default: {
      const _exhaustive: never = verify
      return _exhaustive
    }
  }
}

function buildPlatformInput(
  surface: AppSurface,
  credentialKind: ConnectCredentialKind,
): PlatformInput | RecipeError {
  const bearerAuth: FlattenedAuth = credentialKind === "bearer" ? { scheme: "bearer" } : undefined

  if (surface.build.via === "flattened") {
    const connection = surface.connection
    if (connection.kind === "mcp") {
      return {
        kind: "mcp",
        transport: connection.transport,
        url: connection.url,
        authHeader: connection.authHeader,
        command: connection.command,
        args: connection.args,
        tokenEnvVar: connection.tokenEnvVar,
        env: connection.env,
      }
    }
    if (connection.kind === "openapi") {
      return {
        kind: "openapi",
        specUrl: connection.specUrl,
        baseUrl: connection.baseUrl,
        auth: bearerAuth,
        maxTools: connection.maxTools,
        select: connection.select,
        verifyOperationId: connection.verifyOperationId,
      }
    }
    if (connection.kind === "graphql") {
      return {
        kind: "graphql",
        endpoint: connection.endpoint,
        auth: bearerAuth,
        defaultHeaders: connection.defaultHeaders,
      }
    }
    // A "flattened" recipe on an http/cli connection template is a catalog
    // authoring error (those kinds are always "descriptor" per the design) —
    // not reachable with today's shipped data, but handled honestly rather
    // than silently mis-assembling.
    return { kind: "unsupported-via", via: `flattened+${connection.kind}` }
  }

  // via: "descriptor" — http/cli. The connection template omits `tools`; it
  // MUST be merged with the surface's starterTools to form a valid descriptor.
  if (surface.starterTools === undefined || surface.starterTools.length === 0) {
    return { kind: "descriptor-no-starter-tools", surfaceKind: surface.kind }
  }

  if (surface.connection.kind === "http") {
    const httpTools = surface.starterTools.filter(isHttpRequestTool)
    return {
      kind: "http",
      descriptor: {
        baseUrl: surface.connection.baseUrl,
        auth: bearerAuth,
        defaultHeaders: surface.connection.defaultHeaders,
        tools: httpTools,
      },
    }
  }

  if (surface.connection.kind === "cli") {
    const cliTools = surface.starterTools.filter(isCliTool)
    return {
      kind: "cli",
      descriptor: {
        tools: cliTools,
        credentialEnvVar: surface.connection.credentialEnvVar,
      },
    }
  }

  return { kind: "unsupported-via", via: `descriptor+${surface.connection.kind}` }
}

function connectionSummary(entry: AppCatalogEntry, surface: AppSurface): string {
  const connection = surface.connection
  const parts: string[] = [`${entry.displayName} · ${surface.displayName}`]
  if (connection.kind === "openapi") {
    parts.push(`spec ${shortHost(connection.specUrl)}`)
    if (connection.baseUrl !== undefined) parts.push(`base ${connection.baseUrl}`)
  } else if (connection.kind === "graphql") {
    parts.push(`endpoint ${connection.endpoint}`)
  } else if (connection.kind === "mcp") {
    if (connection.transport === "http" && connection.url !== undefined) {
      parts.push(`url ${connection.url}`)
    } else if (connection.command !== undefined) {
      parts.push(`command ${connection.command}`)
    }
  } else if (connection.kind === "http") {
    parts.push(`base ${connection.baseUrl}`)
  } else if (connection.kind === "cli") {
    parts.push("local CLI")
  }
  return parts.join(" · ")
}

function shortHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function isHttpRequestTool(tool: HttpRequestTool | CliTool): tool is HttpRequestTool {
  return "method" in tool && "path" in tool
}

function isCliTool(tool: HttpRequestTool | CliTool): tool is CliTool {
  return "argv" in tool
}
