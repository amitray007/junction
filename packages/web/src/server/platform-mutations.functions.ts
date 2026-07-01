// SPDX-License-Identifier: AGPL-3.0-only
// Platform mutation server function wrappers — POST endpoints for platform write paths.
// Routes MUST NOT import @junction/core, @junction/platform-orchestration, or
// platform-mutations.server.ts directly.
//
// Pattern mirrors profile-mutations.functions.ts exactly:
//   validator (pure: trim, requireString, type checks) → handler (assertLocalHost → thin server helper).

import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost, requireString } from "./fn-guards.server.js"
import type {
  AddPlatformInput,
  CliConnectionInput,
  CliToolArgInput,
  CliToolInput,
  SimpleAuthInput,
  UpdatePlatformInput,
} from "./platform-mutations.server.js"
import {
  getPlatformDetail,
  mutateAddPlatform,
  mutateDeletePlatform,
  mutateRefreshPlatform,
  mutateUpdatePlatform,
} from "./platform-mutations.server.js"

// Re-export so route/component files can annotate form + pre-fill state without
// a direct import from platform-mutations.server.ts (server-only by convention —
// mirrors data.functions.ts's re-export of PlatformMeta/CredentialMeta/etc.).
export type {
  AddPlatformInput,
  CliConnectionInput,
  CliToolArgInput,
  CliToolInput,
  PlatformDetail,
  PlatformDetailResult,
} from "./platform-mutations.server.js"

// ---------------------------------------------------------------------------
// Validator helpers — pure, no I/O, no core.
// ---------------------------------------------------------------------------

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Shared pure validator for the id-only mutations (delete, refresh, detail). */
function validateIdOnly(raw: unknown): { id: string } {
  const d = raw as Record<string, unknown>
  return { id: requireString(d.id, "id") }
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === "string")
}

/** Validate an optional record<string,string> — used for stdio env + tool envAllow. */
function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function stringRecord(value: unknown): Record<string, string> {
  return optionalStringRecord(value) ?? {}
}

/** Validate the optional simple-auth sub-form shared by openapi/graphql/mcp-http. */
function validateAuth(raw: unknown): SimpleAuthInput | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const d = raw as Record<string, unknown>
  if (d.scheme === "bearer") return { scheme: "bearer" }
  if (d.scheme === "apiKey") {
    return { scheme: "apiKey", name: requireString(d.name, "auth.name") }
  }
  return { scheme: "none" }
}

// ---------------------------------------------------------------------------
// CLI validators — the web's structured intermediate (commandLine + args + policy).
// ---------------------------------------------------------------------------

function validateCliArg(raw: unknown, toolIndex: number, argIndex: number): CliToolArgInput {
  const d = raw as Record<string, unknown>
  const context = `tools[${toolIndex}].args[${argIndex}]`
  const type = d.type
  if (
    type !== "string" &&
    type !== "number" &&
    type !== "boolean" &&
    type !== "enum" &&
    type !== "path"
  ) {
    throw new Response(`Bad Request: ${context}.type is invalid`, { status: 400 })
  }
  return {
    name: requireString(d.name, `${context}.name`),
    description: optionalString(d.description),
    type,
    required: d.required === true,
    enum: optionalStringArray(d.enum),
    pattern: optionalString(d.pattern),
    maxLength: typeof d.maxLength === "number" ? d.maxLength : undefined,
  }
}

function validateNetwork(raw: unknown): { mode: "denied" } | { mode: "allow"; hosts: string[] } {
  const d = raw as Record<string, unknown> | undefined
  if (d?.mode === "allow") {
    return { mode: "allow", hosts: optionalStringArray(d.hosts) ?? [] }
  }
  return { mode: "denied" }
}

function validateCliTool(raw: unknown, toolIndex: number): CliToolInput {
  const d = raw as Record<string, unknown>
  const context = `tools[${toolIndex}]`
  const policyRaw = d.policy as Record<string, unknown> | undefined
  const argsRaw = Array.isArray(d.args) ? d.args : []
  return {
    name: requireString(d.name, `${context}.name`),
    description: optionalString(d.description),
    commandLine: requireString(d.commandLine, `${context}.commandLine`),
    args: argsRaw.map((a, i) => validateCliArg(a, toolIndex, i)),
    policy: {
      cwd: requireString(policyRaw?.cwd, `${context}.policy.cwd`),
      readPaths: optionalStringArray(policyRaw?.readPaths) ?? [],
      writePaths: optionalStringArray(policyRaw?.writePaths) ?? [],
      network: validateNetwork(policyRaw?.network),
      timeoutMs: typeof policyRaw?.timeoutMs === "number" ? policyRaw.timeoutMs : 15_000,
      envAllow: stringRecord(policyRaw?.envAllow),
    },
  }
}

function validateCliConnection(raw: unknown): CliConnectionInput {
  const d = raw as Record<string, unknown>
  const toolsRaw = Array.isArray(d.tools) ? d.tools : []
  if (toolsRaw.length === 0) {
    throw new Response("Bad Request: connection.tools must have at least one tool", {
      status: 400,
    })
  }
  return {
    tools: toolsRaw.map((t, i) => validateCliTool(t, i)),
    credentialEnvVar: optionalString(d.credentialEnvVar),
  }
}

// ---------------------------------------------------------------------------
// Per-kind platform input validator — shared by add + update (same shape).
// ---------------------------------------------------------------------------

function validatePlatformInput(raw: unknown): AddPlatformInput {
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
        env: optionalStringRecord(d.env),
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
        connection: validateCliConnection(d.connection),
      }
    default:
      throw new Response(`Bad Request: unknown platform kind "${String(d.kind)}"`, {
        status: 400,
      })
  }
}

function validateUpdatePlatformInput(raw: unknown): UpdatePlatformInput {
  return validatePlatformInput(raw)
}

// ---------------------------------------------------------------------------
// Server functions (POST — platform mutations; GET — platform detail read)
// ---------------------------------------------------------------------------

export const addPlatformFn = createServerFn({ method: "POST" })
  .validator(validatePlatformInput)
  .handler(async ({ data }) => {
    assertLocalHost()
    return mutateAddPlatform(data)
  })

export const updatePlatformFn = createServerFn({ method: "POST" })
  .validator(validateUpdatePlatformInput)
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

/** Fetch a platform's full connection detail — used to pre-fill the Edit dialog. */
export const getPlatformDetailFn = createServerFn({ method: "GET" })
  .validator(validateIdOnly)
  .handler(async ({ data }) => {
    assertLocalHost()
    return getPlatformDetail(data.id)
  })
