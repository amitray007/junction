// SPDX-License-Identifier: AGPL-3.0-only
// `junction mcp serve` — serve a per-profile MCP endpoint over stdio.
//
// CRITICAL: this command's stdout IS the MCP channel. Nothing may be written
// to stdout except MCP JSON-RPC frames. Any human-readable output (resolver
// notes, proxy warnings, skipped-source notices) goes to stderr ONLY.
// Do NOT use consola (which writes to stdout) anywhere in this command.
//
// ARCHITECTURE — composition root (injection):
//   cli is the app layer that wires libs together. mcp/server NEVER imports
//   mcp/client; instead, the cli builds resolveProvider (from repos + store),
//   creates the ProfileProxy (core), adapts it to McpServerHandlers,
//   and passes those handlers to createMcpServer (mcp/server). The boundary:
//     mcp/server → core only
//     mcp/client → core only
//     cli → core + mcp/server + mcp/client   (app → libs)
//
// CREDENTIAL DISCIPLINE:
//   The secret is fetched per-call inside resolveProvider, passed to
//   createMcpProvider (which injects it into the transport), and NEVER placed
//   in any tool result, MCP response, error message, stderr note, or log.
//
// DISPATCH BY KIND (increment 14/17):
//   buildProvider (providers.ts) switches on platform.kind:
//     "mcp"     → build McpToolProvider via mcp/client (lazy-imported)
//     "openapi" → build OpenApiToolProvider via openapi-client (lazy-imported)
//     other     → unsupported-source-kind error (skipped per-source gracefully)
//   Future kinds (graphql) plug in there without touching the proxy or this file.

import {
  createCredentialStore,
  createProfileProxy,
  createRepositories,
  getDatabase,
  getPaths,
  type Profile,
  ProfileIdSchema,
} from "@junction/core"
import { makeResolveProvider } from "@junction/source-runtime"
import { defineCommand } from "citty"
import { adaptToMcpHandlers } from "../providers.js"

// ---------------------------------------------------------------------------
// Default (synthetic) profile — used when no DB is available
// ---------------------------------------------------------------------------

/** Synthetic default profile — used when no profile name is supplied or no profiles exist yet. */
function defaultProfile(): Profile {
  return {
    id: ProfileIdSchema.parse("default"),
    name: "default",
    sources: [],
  }
}

/** No-op handlers for a profile with no sources (empty tool list, all calls fail). */
function emptyHandlers() {
  return {
    listTools: () =>
      Promise.resolve({
        tools: [] as Array<{ name: string; description?: string; inputSchema: object }>,
      }),
    callTool: (_name: string, _args: Record<string, unknown>) =>
      Promise.resolve({
        isError: true as const,
        content: [{ type: "text" as const, text: "no tools available" }],
      }),
  }
}

// ---------------------------------------------------------------------------
// serve command
// ---------------------------------------------------------------------------

const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Serve a per-profile MCP endpoint over stdio.",
  },
  args: {
    profile: {
      type: "string",
      description: "Profile name to serve (defaults to 'default' if omitted or not found).",
      default: "",
    },
  },
  async run({ args }) {
    // Lazy import: mcp/server is only loaded when this command runs.
    // mcp/client and openapi-client are lazy-imported inside buildProvider (providers.ts).
    // safeUpstreamMessage is lazy-imported inside adaptToMcpHandlers (providers.ts).
    const { serveStdio } = await import("@junction/mcp-server")

    const profileName = args.profile

    // ── No profile name given: serve synthetic default immediately ──────────
    if (!profileName) {
      await serveStdio(defaultProfile(), emptyHandlers())
      return
    }

    // ── Load the named profile from DB ────────────────────────────────────
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) {
      process.stderr.write(
        `junction mcp serve: database error (${dbResult.error.kind}), serving synthetic default profile\n`,
      )
      await serveStdio(defaultProfile(), emptyHandlers())
      return
    }

    const db = dbResult.value
    const repos = createRepositories(db)
    const profileResult = await repos.profiles.getByName(profileName)

    if (profileResult.isErr()) {
      if (profileResult.error.kind === "not-found") {
        process.stderr.write(
          `junction mcp serve: profile "${profileName}" not found, serving synthetic default profile\n`,
        )
        await serveStdio(defaultProfile(), emptyHandlers())
        return
      }
      process.stderr.write(
        `junction mcp serve: failed to load profile "${profileName}" (${profileResult.error.kind})\n`,
      )
      process.exitCode = 1
      return
    }

    const profile = profileResult.value

    // ── Open the credential store ─────────────────────────────────────────
    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      // Store unavailable: serve the profile but with no credential resolution.
      // All sources will fail to resolve → proxy returns empty tools.
      process.stderr.write(
        `junction mcp serve: credential store unavailable (${storeResult.error.kind}), all sources will be skipped\n`,
      )
    }
    const store = storeResult.isOk() ? storeResult.value : null

    // ── Build resolveProvider (injected into the proxy) ───────────────────
    //
    // SECURITY: resolveProvider writes stderr notes for skipped sources but NEVER
    // leaks secret values. The secret is returned in the ToolProvider's transport
    // and flows only to the upstream; it is never logged or serialized.
    //
    // Shared with `junction serve` (commands/serve.ts) via providers.ts —
    // both build the identical resolution pipeline; only the log
    // prefix/sink differs (this command writes stderr directly to keep
    // stdout pure for the MCP channel — see the file-level note above).
    const resolveProvider = makeResolveProvider(repos, store, paths, {
      logPrefix: "junction mcp serve",
    })

    // ── Build the profile proxy (core) ────────────────────────────────────
    const proxy = createProfileProxy(profile.sources, resolveProvider)

    // ── Adapt proxy ResultAsync → Promise handlers for mcp/server ─────────
    // Shared with `junction serve` (commands/serve.ts) via providers.ts.
    const handlers = adaptToMcpHandlers(proxy)

    // ── Serve ─────────────────────────────────────────────────────────────
    await serveStdio(profile, handlers)
  },
})

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description: "MCP server commands.",
  },
  subCommands: {
    serve: serveCommand,
  },
})
