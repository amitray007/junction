// SPDX-License-Identifier: AGPL-3.0-only
// `junction debug mcp-probe` — connect to an upstream MCP source in isolation
// and print the namespaced tool list. Debug-only; clearly non-production.
//
// SECURITY: the resolved secret (bearer token) is passed directly to
// connectSource and NEVER written to stdout, stderr, --json output, or logs.
// The probe prints only tool names and counts — no credential values, ever.

import type { UpstreamError } from "@junction/core"
import {
  createCredentialStore,
  getPaths,
  namespaceToolName,
  ToolNamespaceSchema,
} from "@junction/core"
import { connectSource } from "@junction/mcp-client"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportCredentialError, reportDbError } from "../format.js"

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
// mcp-probe subcommand
// ---------------------------------------------------------------------------

const mcpProbeCommand = defineCommand({
  meta: {
    name: "mcp-probe",
    description:
      "Connect to a platform's upstream MCP source and print the namespaced tool list. Debug use only.",
  },
  args: {
    platform: {
      type: "string",
      description: "Platform ID",
      required: true,
    },
    credential: {
      type: "string",
      description: "Credential ID",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false

    // ── 1. Open DB ────────────────────────────────────────────────────────
    const repos = await openDb(json)
    if (!repos) return

    // ── 2. Load platform ──────────────────────────────────────────────────
    const platformResult = await repos.platforms.get(args.platform)
    if (platformResult.isErr()) {
      reportDbError(platformResult.error, json)
      return
    }
    const platform = platformResult.value

    if (!platform.connection) {
      const msg = `platform "${args.platform}" has no MCP connection configured`
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }

    // ── 3. Load credential ────────────────────────────────────────────────
    const credResult = await repos.credentials.get(args.credential)
    if (credResult.isErr()) {
      reportDbError(credResult.error, json)
      return
    }
    const credential = credResult.value

    // ── 4. Resolve secret ─────────────────────────────────────────────────
    const paths = getPaths()
    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      reportCredentialError(storeResult.error, json)
      return
    }
    const store = storeResult.value

    const secretResult = await store.get(credential.secretRef)
    if (secretResult.isErr()) {
      reportCredentialError(secretResult.error, json)
      return
    }
    const secret = secretResult.value // string | null — SECRET handled below

    // ── 5. Derive namespace ───────────────────────────────────────────────
    const toolNamespace = deriveProbeNamespace(String(platform.id), credential.profileName)

    // ── 6. Connect + list tools ───────────────────────────────────────────
    // connectSource injects `secret` only into the transport. We NEVER log or
    // output the secret — below this point it is referenced only by connectSource.
    // (increment 14: connectSource no longer takes toolNamespace — returns raw names)
    const sessionResult = await connectSource(platform.connection, secret)
    if (sessionResult.isErr()) {
      reportUpstreamError(sessionResult.error, json)
      return
    }
    const session = sessionResult.value

    try {
      const toolsResult = await session.listTools()
      if (toolsResult.isErr()) {
        reportUpstreamError(toolsResult.error, json)
        return
      }

      // Apply namespacing + ≤64 guard (increment 14: moved from session to here for probe).
      // The core proxy does this automatically; the probe applies it manually.
      const rawTools = toolsResult.value
      const namespacedTools: Array<{ name: string }> = []
      let skippedCount = 0
      for (const t of rawTools) {
        const nameResult = namespaceToolName(toolNamespace, t.name)
        if (nameResult.isErr()) {
          skippedCount++
          continue
        }
        namespacedTools.push({ name: nameResult.value })
      }

      // Output: namespaced tool names + count. NEVER the token.
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, namespace: toolNamespace, count: namespacedTools.length, skippedCount, tools: namespacedTools.map((t) => t.name) })}\n`,
        )
      } else {
        consola.info(`Namespace: ${toolNamespace}`)
        consola.info(`Tools (${namespacedTools.length}):`)
        for (const t of namespacedTools) {
          process.stdout.write(`  ${t.name}\n`)
        }
        if (skippedCount > 0) {
          consola.warn(`${skippedCount} tool(s) skipped (namespaced name exceeds MCP limits)`)
        }
      }
    } finally {
      await session.close()
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
    "mcp-probe": mcpProbeCommand,
  },
})
