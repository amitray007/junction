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
//   - cli:       none (connection carries its own credentialEnvVar)
// Full CLI auth-flag parity (query/cookie apiKey, basic) is deferred to a future
// increment; this is a bearer-first subset, not the complete CLI surface (slice B).
//
// CLI assembly (inc 26 wave 3): the web form sends a structured CliConnectionInput
// (tools with a raw `commandLine` string + declared args + policy), NOT pre-built
// argv. This module is the ONE authoritative place that tokenizes commandLine into
// argv (via the client-safe lib/cli-command.ts tokenizer) and runs
// CliConnectionSchema.parse as the final authority before the descriptor reaches
// addCliPlatform/validatePolicy/the sandbox. Never trust a client-sent argv array.

import type { CliConnection, Platform } from "@junction/core"
import { CliConnectionSchema } from "@junction/core"
import {
  addCliPlatform,
  addGraphQlPlatform,
  addMcpPlatform,
  addOpenApiPlatform,
  refreshOpenApiPlatform,
} from "@junction/platform-orchestration"
import { errAsync, type ResultAsync } from "neverthrow"
import { tokenizeCommandLine } from "../lib/cli-command.js"
import { withRepos } from "./shared.server.js"

// Structural shape of a Zod error's issues — avoids a direct `zod` type import
// (web has no zod dep; zod is core's boundary validator). Matches what
// CliConnectionSchema.safeParse(...).error exposes: an `issues` array of
// { path, message }. Read structurally so the web package stays zod-free.
type ZodIssueLike = { path: PropertyKey[]; message: string }
type ZodErrorLike = { issues: ZodIssueLike[] }

// ---------------------------------------------------------------------------
// Input shapes — mirror the discriminated validator output in
// platform-mutations.functions.ts exactly.
// ---------------------------------------------------------------------------

export type SimpleAuthInput =
  | { scheme: "none" }
  | { scheme: "bearer" }
  | { scheme: "apiKey"; name: string }

/** One declared arg slot on a CLI tool — mirrors core's CliArgSchema shape. */
export interface CliToolArgInput {
  name: string
  description?: string
  type: "string" | "number" | "boolean" | "enum" | "path"
  required: boolean
  enum?: string[]
  pattern?: string
  maxLength?: number
}

/** One CLI tool — the raw commandLine is tokenized server-side (authoritative). */
export interface CliToolInput {
  name: string
  description?: string
  /** Raw "Command" input text, e.g. "/opt/homebrew/bin/rg --json $pattern". */
  commandLine: string
  args: CliToolArgInput[]
  policy: {
    cwd: string
    readPaths: string[]
    writePaths: string[]
    network: { mode: "denied" } | { mode: "allow"; hosts: string[] }
    timeoutMs: number
    envAllow: Record<string, string>
  }
  /**
   * The guided form's JSON escape hatch: when set, this parsed tool object
   * (already-built argv + args + policy, the pre-guided-form descriptor shape)
   * is used VERBATIM instead of `commandLine`/`args`/`policy` above — for a
   * tool whose argv can't round-trip through the command-line builder (see
   * lib/cli-command.ts `isReversible`). Still re-validated by
   * CliConnectionSchema.parse below; never trusted beyond that.
   */
  advancedTool?: unknown
}

export interface CliConnectionInput {
  tools: CliToolInput[]
  credentialEnvVar?: string
}

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
      /** Static env vars for the child MCP server — passed straight through to addMcpPlatform. */
      env?: Record<string, string>
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
      connection: CliConnectionInput
    }

/** Update = add's per-kind shape plus the existing platform's id. */
export type UpdatePlatformInput = AddPlatformInput

export type PlatformMetaResult =
  | { ok: true; platform: { id: string; kind: string; displayName: string; baseUrl?: string } }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

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

export function dbErrorMessage(kind: string): string {
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

/** Map a ZodError's issues to a flat field-name → message record for the UI. */
function zodFieldErrors(error: ZodErrorLike): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_root"
    // First message per field wins — enough for inline field-level display.
    if (!(key in out)) out[key] = issue.message
  }
  return out
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
// CLI assembly — the ONE authoritative client-input → CliConnection transform.
// ---------------------------------------------------------------------------

/**
 * Assemble+validate a CliConnection from the web's structured CliConnectionInput.
 * Re-tokenizes each tool's raw commandLine server-side (never trusts a client
 * argv) and maps policy.network → allowNet, then runs CliConnectionSchema.parse
 * as the final authority. Returns either the validated CliConnection or a
 * {message, fieldErrors} pair derived from the ZodError.
 */
function assembleCliConnection(
  input: CliConnectionInput,
):
  | { ok: true; connection: CliConnection }
  | { ok: false; message: string; fieldErrors: Record<string, string> } {
  const rawTools = input.tools.map((tool) =>
    // The JSON escape hatch: use the operator's raw tool object verbatim
    // (CliConnectionSchema.parse below is still the final authority).
    tool.advancedTool !== undefined
      ? tool.advancedTool
      : {
          name: tool.name,
          description: tool.description,
          argv: tokenizeCommandLine(tool.commandLine),
          args: tool.args.map((a) => ({
            name: a.name,
            description: a.description,
            type: a.type,
            required: a.required,
            enum: a.enum,
            pattern: a.pattern,
            maxLength: a.maxLength,
          })),
          policy: {
            cwd: tool.policy.cwd,
            readPaths: tool.policy.readPaths,
            writePaths: tool.policy.writePaths,
            allowNet: tool.policy.network.mode === "allow" ? tool.policy.network.hosts : [],
            timeoutMs: tool.policy.timeoutMs,
            envAllow: tool.policy.envAllow,
          },
        },
  )

  const raw = {
    tools: rawTools,
    ...(input.credentialEnvVar ? { credentialEnvVar: input.credentialEnvVar } : {}),
  }

  const parsed = CliConnectionSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((i) => i.message).join(", "),
      fieldErrors: zodFieldErrors(parsed.error),
    }
  }
  return { ok: true, connection: parsed.data }
}

// ---------------------------------------------------------------------------
// Dispatch: add a platform by kind, upsert on success.
// ---------------------------------------------------------------------------

function addByKind(
  input: AddPlatformInput,
): ResultAsync<
  { platform: Platform; sandboxWarning?: string },
  { kind: string; fieldErrors?: Record<string, string>; [k: string]: unknown }
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
        env: input.env,
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
      const assembled = assembleCliConnection(input.connection)
      if (!assembled.ok) {
        return errAsync({
          kind: "invalid-descriptor",
          message: assembled.message,
          fieldErrors: assembled.fieldErrors,
        })
      }
      return addCliPlatform({
        id: input.id,
        displayName: input.displayName,
        descriptor: assembled.connection,
      }).map(({ platform, sandboxWarning }) => ({ platform, sandboxWarning }))
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
    const e = addResult.error
    return {
      ok: false,
      error: orchestrationErrorMessage(e),
      ...(e.fieldErrors ? { fieldErrors: e.fieldErrors as Record<string, string> } : {}),
    }
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
 * Update a platform's full connection — a rebuild, not a patch. Dispatches
 * through the SAME per-kind addByKind assembly used by add (openapi/graphql
 * re-fetch/re-introspect on every edit, matching add semantics exactly — this
 * is intentional: correctness over cleverness, no stale-field risk), then
 * upserts. `input` carries the existing platform's `id`, so the upsert
 * replaces the row in place (platforms.upsert is create-or-replace-by-id).
 *
 * No displayName-only fast path: the brief allows one as optional, but a
 * two-path implementation doubles the surface for the same bug class this
 * increment exists to fix (stale connection fields) for a marginal win (skip
 * a spec fetch on a pure rename) — the full-rebuild path is simple, uniform,
 * and honest. If spec-refetch-on-rename proves too slow/flaky in practice,
 * add the fast path as a follow-up with its own test, not silently here.
 */
export async function mutateUpdatePlatform(
  input: UpdatePlatformInput,
): Promise<PlatformMetaResult> {
  // Edit must not silently CREATE: upsert alone would insert a brand-new row for an
  // unknown id. Verify the platform exists first, so editing a nonexistent id is a
  // clean not-found rather than an accidental add.
  const existing = await withRepos(async (repos) => repos.platforms.get(input.id))
  if (existing.isErr()) {
    return { ok: false, error: dbErrorMessage(existing.error.kind) }
  }

  const addResult = await addByKind(input)
  if (addResult.isErr()) {
    const e = addResult.error
    return {
      ok: false,
      error: orchestrationErrorMessage(e),
      ...(e.fieldErrors ? { fieldErrors: e.fieldErrors as Record<string, string> } : {}),
    }
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

// ---------------------------------------------------------------------------
// getPlatformDetail — metadata-only DTO for pre-filling the Edit dialog.
// ---------------------------------------------------------------------------

export interface PlatformDetail {
  id: string
  kind: string
  displayName: string
  // mcp
  transport?: "http" | "stdio"
  url?: string
  hasAuthHeader?: boolean
  authHeaderName?: string
  command?: string
  args?: string[]
  hasTokenEnvVar?: boolean
  tokenEnvVarName?: string
  /** Static env vars declared on an mcp-stdio connection (non-secret; pre-fills the env-var list). */
  env?: Record<string, string>
  // openapi
  specUrl?: string
  baseUrl?: string
  authScheme?: "none" | "bearer" | "apiKey"
  authHeaderOrName?: string
  // graphql
  endpoint?: string
  // cli
  cliTools?: Array<{
    name: string
    description?: string
    commandLine: string
    args: CliToolArgInput[]
    policy: {
      cwd: string
      readPaths: string[]
      writePaths: string[]
      network: { mode: "denied" } | { mode: "allow"; hosts: string[] }
      timeoutMs: number
      envAllow: Record<string, string>
    }
    reversible: boolean
    /** Only present when !reversible — the raw tool JSON for the per-tool JSON escape hatch. */
    rawJson?: string
  }>
  cliCredentialEnvVar?: string
}

export type PlatformDetailResult =
  | { ok: true; detail: PlatformDetail }
  | { ok: false; error: string }

/**
 * Fetch a single platform's connection details for pre-filling the Edit dialog.
 * CRITICAL: metadata-only — explicitly maps only the fields the guided forms
 * need. Never spreads the raw core Platform (a future core field addition must
 * not leak through this DTO by accident). No secretRef/secret ever appear here
 * — the platform row itself never stores a secret (secrets live in the
 * separate credential store).
 */
export async function getPlatformDetail(id: string): Promise<PlatformDetailResult> {
  return withRepos(async (repos) => {
    const result = await repos.platforms.get(id)
    if (result.isErr()) {
      return { ok: false as const, error: dbErrorMessage(result.error.kind) }
    }
    return { ok: true as const, detail: toPlatformDetail(result.value) }
  })
}

function toPlatformDetail(p: Platform): PlatformDetail {
  const base: PlatformDetail = { id: String(p.id), kind: p.kind, displayName: p.displayName }

  if (p.kind === "mcp" && p.connection) {
    if (p.connection.transport === "http") {
      return {
        ...base,
        transport: "http",
        url: p.connection.url,
        hasAuthHeader: p.connection.auth !== undefined,
        authHeaderName: p.connection.auth?.header,
      }
    }
    return {
      ...base,
      transport: "stdio",
      command: p.connection.command,
      args: p.connection.args,
      hasTokenEnvVar: p.connection.tokenEnvVar !== undefined,
      tokenEnvVarName: p.connection.tokenEnvVar,
      ...(p.connection.env ? { env: p.connection.env } : {}),
    }
  }

  if (p.kind === "openapi" && p.openapi) {
    const auth = p.openapi.auth
    return {
      ...base,
      specUrl: p.openapi.spec.from === "url" ? p.openapi.spec.url : undefined,
      baseUrl: p.openapi.baseUrl,
      authScheme: auth === undefined ? "none" : auth.scheme === "apiKey" ? "apiKey" : "bearer",
      authHeaderOrName:
        auth?.scheme === "apiKey" ? auth.name : auth?.scheme === "bearer" ? auth.header : undefined,
    }
  }

  if (p.kind === "graphql" && p.graphql) {
    const auth = p.graphql.auth
    return {
      ...base,
      endpoint: p.graphql.endpoint,
      authScheme: auth === undefined ? "none" : auth.scheme === "apiKey" ? "apiKey" : "bearer",
      authHeaderOrName:
        auth?.scheme === "apiKey" ? auth.name : auth?.scheme === "bearer" ? auth.header : undefined,
    }
  }

  if (p.kind === "cli" && p.cli) {
    return {
      ...base,
      cliTools: p.cli.tools.map((tool) => {
        const reversible = toolIsReversible(tool)
        return {
          name: tool.name,
          description: tool.description,
          commandLine: reversible ? argvToCommandLineLocal(tool.argv) : "",
          args: tool.args.map((a) => ({
            name: a.name,
            description: a.description,
            type: a.type,
            required: a.required,
            enum: a.enum,
            pattern: a.pattern,
            maxLength: a.maxLength,
          })),
          policy: {
            cwd: tool.policy.cwd,
            readPaths: tool.policy.readPaths,
            writePaths: tool.policy.writePaths,
            network:
              tool.policy.allowNet.length > 0
                ? { mode: "allow" as const, hosts: tool.policy.allowNet }
                : { mode: "denied" as const },
            timeoutMs: tool.policy.timeoutMs,
            envAllow: tool.policy.envAllow ?? {},
          },
          reversible,
          ...(reversible ? {} : { rawJson: JSON.stringify(tool, null, 2) }),
        }
      }),
      cliCredentialEnvVar: p.cli.credentialEnvVar,
    }
  }

  return base
}

// Local re-implementations of the lib/cli-command.ts helpers against the REAL
// core CliTool/CliArgvSegment shape (structurally identical to the local type
// lib/cli-command.ts declares) — reuse the same pure functions by importing them,
// since core's CliArgvSegment is structurally assignable to the lib's local type.
import { argvToCommandLine, isReversible } from "../lib/cli-command.js"

function argvToCommandLineLocal(argv: CliConnection["tools"][number]["argv"]): string {
  return argvToCommandLine(argv)
}

function toolIsReversible(tool: CliConnection["tools"][number]): boolean {
  return isReversible({ argv: tool.argv, args: tool.args })
}
