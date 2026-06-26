// SPDX-License-Identifier: AGPL-3.0-only
// `junction debug` — source-agnostic debug utilities (non-production).
//
// Subcommands:
//   probe — connect to any source (MCP or OpenAPI) and list its tools.
//   call  — invoke a single tool against any source and print the result.
//
// SECURITY:
//   The resolved secret (bearer token / API key) is passed only into buildProvider
//   → transport/injectAuth and NEVER written to stdout, stderr, --json output, or logs.
//   Probe prints tool names and counts only. Call prints upstream content + isError —
//   the same bytes mcp serve would forward; no secret, no request URL, ever.

import type { UpstreamError } from "@junction/core"
import { getPaths, namespaceToolName, ToolNamespaceSchema } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportCredentialError, reportDbError } from "../format.js"
import { buildProvider, resolveCredentialSecret } from "../providers.js"

// ---------------------------------------------------------------------------
// UpstreamError formatter (exhaustive — compile error on new kind)
// ---------------------------------------------------------------------------

function formatUpstreamError(e: UpstreamError): string {
  switch (e.kind) {
    case "binary-not-found":
      return `stdio binary not found: "${e.command}" — install it or check the command path`
    case "connect-failed":
      return `connect failed: ${String(e.cause)}`
    case "auth-failed":
      return e.cause !== undefined
        ? `authentication failed: ${String(e.cause)}`
        : "authentication failed (check the credential token)"
    case "upstream-unavailable":
      return `upstream unavailable: ${String(e.cause)}`
    case "tool-not-found":
      return `tool not found: "${e.name}"`
    case "call-failed":
      return `tool call failed: ${String(e.cause)}`
    case "namespace-too-long":
      return `namespaced tool name exceeds 64 chars: "${e.name}"`
    case "invalid-tool-name":
      return `upstream tool name contains MCP-illegal characters: "${e.name}"`
    case "timed-out":
      return `upstream timed out after ${e.ms}ms`
    case "unsupported-source-kind":
      return `platform kind "${e.platformKind}" is not yet supported`
    case "spec-parse-failed":
      return `openapi spec parse failed: ${String(e.cause)}`
    case "spec-fetch-failed":
      return `openapi spec fetch failed: ${String(e.cause)}`
    case "invalid-args":
      return `invalid tool arguments: ${e.reason}`
    case "response-too-large":
      return `upstream response exceeded ${e.limit} byte limit`
    case "too-many-tools":
      return `spec has too many operations (${e.count}); cap is ${e.cap}`
    default: {
      // Exhaustiveness guard: compile error if a new UpstreamError kind is added without
      // a corresponding case here (docs/rules/typescript.md — switch + never).
      const _: never = e
      return `unknown upstream error: ${String((_ as UpstreamError).kind)}`
    }
  }
}

function reportUpstreamError(e: UpstreamError, json: boolean): void {
  const msg = formatUpstreamError(e)
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  } else {
    consola.error(msg)
  }
  process.exitCode = 1
}

// ---------------------------------------------------------------------------
// Namespace derivation for the probe
// ---------------------------------------------------------------------------

/**
 * Derive a valid ToolNamespace from platformId + credentialProfileName.
 *
 * Sanitizes both parts (lowercase, consecutive non-alphanumeric → single "_",
 * leading/trailing "_" stripped), joins with "_", and falls back to "probe"
 * if the result is not a valid ToolNamespaceSchema string.
 *
 * Example: platformId="github", profileName="work" → "github_work"
 */
function deriveProbeNamespace(platformId: string, profileName: string): string {
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "x"
  const ns = `${sanitize(platformId)}_${sanitize(profileName)}`
  return ToolNamespaceSchema.safeParse(ns).success ? ns : "probe"
}

// ---------------------------------------------------------------------------
// Shared probe logic (the probe subcommand calls this)
// ---------------------------------------------------------------------------

interface ProbeArgs {
  platform: string
  credential?: string
  json: boolean
}

async function runProbe(args: ProbeArgs): Promise<void> {
  const { json } = args

  const repos = await openDb(json)
  if (!repos) return

  const platformResult = await repos.platforms.get(args.platform)
  if (platformResult.isErr()) {
    reportDbError(platformResult.error, json)
    return
  }
  const platform = platformResult.value

  const paths = getPaths()

  // ── Resolve credential + secret (skipped for public/no-auth platforms) ──
  const secretResult = await resolveCredentialSecret(repos, paths, args.credential)
  if (secretResult.isErr()) {
    if (secretResult.error.kind === "db") reportDbError(secretResult.error.error, json)
    else reportCredentialError(secretResult.error.error, json)
    return
  }
  const { secret, account } = secretResult.value

  // ── Derive namespace ────────────────────────────────────────────────────
  const toolNamespace = deriveProbeNamespace(String(platform.id), account)

  // ── Build provider + list tools ─────────────────────────────────────────
  // secret flows only into buildProvider → transport/injectAuth. NEVER logged.
  const providerResult = await buildProvider(platform, secret, paths)
  if (providerResult.isErr()) {
    reportUpstreamError(providerResult.error, json)
    return
  }
  const provider = providerResult.value

  try {
    const toolsResult = await provider.listTools()
    if (toolsResult.isErr()) {
      reportUpstreamError(toolsResult.error, json)
      return
    }

    // Apply namespacing + ≤64 guard — same rules as core proxy but for display.
    const rawTools = toolsResult.value
    const tools: Array<{ raw: string; namespaced: string }> = []
    let skippedCount = 0
    for (const t of rawTools) {
      const nameResult = namespaceToolName(toolNamespace, t.name)
      if (nameResult.isErr()) {
        skippedCount++
        continue
      }
      tools.push({ raw: t.name, namespaced: nameResult.value })
    }

    // Output: both raw and namespaced names + counts. NEVER the secret.
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          namespace: toolNamespace,
          count: tools.length,
          skippedCount,
          tools,
        })}\n`,
      )
    } else {
      consola.info(`Namespace: ${toolNamespace}`)
      consola.info(`Tools (${tools.length}):`)
      for (const t of tools) {
        process.stdout.write(`  ${t.namespaced}  (raw: ${t.raw})\n`)
      }
      if (skippedCount > 0) {
        consola.warn(
          `${skippedCount} tool(s) skipped (namespaced name exceeds 64 chars or contains MCP-illegal characters)`,
        )
      }
    }
  } finally {
    // Always close the provider — leaked connection/timer is the inc-11 hang gotcha.
    await provider.close()
  }
}

// ---------------------------------------------------------------------------
// Args for the probe subcommand
// ---------------------------------------------------------------------------

const PROBE_ARGS = {
  platform: {
    type: "string" as const,
    description: "Platform ID",
    required: true as const,
  },
  credential: {
    type: "string" as const,
    description: "Credential ID (optional — omit for public/no-auth platforms)",
  },
  json: JSON_ARG,
}

// ---------------------------------------------------------------------------
// probe subcommand
// ---------------------------------------------------------------------------

const probeCommand = defineCommand({
  meta: {
    name: "probe",
    description:
      "Connect to a platform's upstream source (MCP or OpenAPI) and print the tool list. Debug use only.",
  },
  args: PROBE_ARGS,
  async run({ args }) {
    await runProbe({
      platform: args.platform,
      credential: args.credential,
      json: args.json ?? false,
    })
  },
})

// ---------------------------------------------------------------------------
// call subcommand
// ---------------------------------------------------------------------------

const callCommand = defineCommand({
  meta: {
    name: "call",
    description:
      "Invoke a single tool against a platform source (MCP or OpenAPI) and print the result. Debug use only.",
  },
  args: {
    platform: {
      type: "string",
      description: "Platform ID",
      required: true,
    },
    credential: {
      type: "string",
      description: "Credential ID (optional — omit for public/no-auth platforms)",
    },
    tool: {
      type: "string",
      description: "Raw (un-namespaced) upstream tool name to invoke",
      required: true,
    },
    args: {
      type: "string",
      description: 'Tool arguments as a JSON object string (default: "{}")',
      default: "{}",
    },
    json: JSON_ARG,
  },
  async run({ args: cmdArgs }) {
    const json = cmdArgs.json ?? false

    // ── Parse --args as a JSON object ──────────────────────────────────────
    let parsedArgs: Record<string, unknown>
    try {
      const raw = JSON.parse(cmdArgs.args ?? "{}") as unknown
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        reportUpstreamError(
          { kind: "invalid-args", reason: "--args must be a JSON object, e.g. '{}'" },
          json,
        )
        return
      }
      parsedArgs = raw as Record<string, unknown>
    } catch (cause) {
      reportUpstreamError({ kind: "invalid-args", reason: `invalid JSON: ${String(cause)}` }, json)
      return
    }

    // ── Open DB + resolve platform ──────────────────────────────────────────
    const repos = await openDb(json)
    if (!repos) return

    const platformResult = await repos.platforms.get(cmdArgs.platform)
    if (platformResult.isErr()) {
      reportDbError(platformResult.error, json)
      return
    }
    const platform = platformResult.value

    const paths = getPaths()

    // ── Resolve credential + secret ─────────────────────────────────────────
    const secretResult = await resolveCredentialSecret(repos, paths, cmdArgs.credential)
    if (secretResult.isErr()) {
      if (secretResult.error.kind === "db") reportDbError(secretResult.error.error, json)
      else reportCredentialError(secretResult.error.error, json)
      return
    }
    const { secret } = secretResult.value

    // ── Build provider + call tool ──────────────────────────────────────────
    // secret flows only into buildProvider → transport/injectAuth. NEVER logged.
    const providerResult = await buildProvider(platform, secret, paths)
    if (providerResult.isErr()) {
      reportUpstreamError(providerResult.error, json)
      return
    }
    const provider = providerResult.value

    try {
      const callResult = await provider.callTool(cmdArgs.tool, parsedArgs)
      if (callResult.isErr()) {
        reportUpstreamError(callResult.error, json)
        return
      }

      const { content, isError } = callResult.value

      // Output: upstream content + isError. NEVER the secret or request URL.
      // (OpenAPI provider already returns "status\nbody" with no URL — inc-15 guarantee.)
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, content, isError: isError ?? false })}\n`,
        )
      } else {
        if (isError === true) {
          consola.error("Tool returned an error:")
        }
        process.stdout.write(`${JSON.stringify(content, null, 2)}\n`)
      }
    } finally {
      // Always close the provider — leaked connection/timer is the inc-11 hang gotcha.
      await provider.close()
    }
  },
})

// ---------------------------------------------------------------------------
// debug namespace
// ---------------------------------------------------------------------------

export const debugCommand = defineCommand({
  meta: {
    name: "debug",
    description: "Debug utilities (non-production).",
  },
  subCommands: {
    probe: probeCommand,
    call: callCommand,
  },
})
