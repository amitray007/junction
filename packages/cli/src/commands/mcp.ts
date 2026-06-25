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
//   mcp/client; instead, the cli builds resolveSource (from repos + store),
//   creates the ProfileProxy (mcp/client), adapts it to McpServerHandlers,
//   and passes those handlers to createMcpServer (mcp/server). The boundary:
//     mcp/server → core only
//     mcp/client → core only
//     cli → core + mcp/server + mcp/client   (app → libs)
//
// CREDENTIAL DISCIPLINE:
//   The secret is fetched per-call inside resolveSource, injected only into
//   connectSource (which puts it in the transport), and NEVER placed in any
//   tool result, MCP response, error message, stderr note, or log.

import {
  createCredentialStore,
  createRepositories,
  deriveMcpEndpointPath,
  err,
  getDatabase,
  getPaths,
  type McpConnection,
  ok,
  type Profile,
  ProfileIdSchema,
  type Result,
  ResultAsync,
  type SourceRef,
  type ToolFilter,
  type UpstreamError,
} from "@junction/core"
import { defineCommand } from "citty"

// ---------------------------------------------------------------------------
// Default (synthetic) profile — used when no DB is available
// ---------------------------------------------------------------------------

/** Synthetic default profile — used when no profile name is supplied or no profiles exist yet. */
function defaultProfile(): Profile {
  return {
    id: ProfileIdSchema.parse("default"),
    name: "default",
    sources: [],
    mcpEndpointPath: deriveMcpEndpointPath("default"),
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
    // Lazy imports: mcp/server and mcp/client are only loaded when this command runs.
    // This avoids paying the import cost for every other CLI command.
    const [{ serveStdio, safeUpstreamMessage }, { createProfileProxy }] = await Promise.all([
      import("@junction/mcp-server"),
      import("@junction/mcp-client"),
    ])

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

    // ── Build resolveSource (injected into the proxy) ─────────────────────
    //
    // SECURITY: resolveSource writes stderr notes for skipped sources but NEVER
    // leaks secret values. The secret is returned in the Ok value and flows only
    // to connectSource (into the transport); it is never logged or serialized.
    type ResolvedSourceShape = {
      connection: McpConnection
      secret: string | null
      toolNamespace: string
      toolFilter?: ToolFilter | undefined
    }

    const resolveSource = (
      sourceRef: SourceRef,
    ): ResultAsync<ResolvedSourceShape, UpstreamError> => {
      const work = async (): Promise<Result<ResolvedSourceShape, UpstreamError>> => {
        // Resolve the platform and its connection descriptor.
        const platformResult = await repos.platforms.get(sourceRef.platformId)
        if (platformResult.isErr()) {
          process.stderr.write(
            `junction mcp serve: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" not found — skipping\n`,
          )
          return err({
            kind: "connect-failed" as const,
            cause: platformResult.error,
          } satisfies UpstreamError)
        }
        const platform = platformResult.value
        if (platform.connection === undefined) {
          process.stderr.write(
            `junction mcp serve: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" has no connection descriptor — skipping\n`,
          )
          return err({
            kind: "connect-failed" as const,
            cause: "platform has no connection descriptor",
          } satisfies UpstreamError)
        }

        // Resolve the credential's secretRef.
        const credResult = await repos.credentials.get(sourceRef.credentialId)
        if (credResult.isErr()) {
          process.stderr.write(
            `junction mcp serve: source "${sourceRef.toolNamespace}": credential "${sourceRef.credentialId}" not found — skipping\n`,
          )
          return err({
            kind: "connect-failed" as const,
            cause: credResult.error,
          } satisfies UpstreamError)
        }
        const credential = credResult.value

        // Resolve the plaintext secret from the store.
        // If store is null (store unavailable), secret is null (no auth).
        let secret: string | null = null
        if (store !== null) {
          const secretResult = await store.get(credential.secretRef)
          if (secretResult.isErr()) {
            process.stderr.write(
              `junction mcp serve: source "${sourceRef.toolNamespace}": credential store read failed — skipping\n`,
            )
            return err({
              kind: "connect-failed" as const,
              cause: secretResult.error,
            } satisfies UpstreamError)
          }
          secret = secretResult.value
        }

        return ok({
          connection: platform.connection,
          secret,
          toolNamespace: sourceRef.toolNamespace,
          toolFilter: sourceRef.toolFilter,
        })
      }
      return new ResultAsync(work())
    }

    // ── Build the profile proxy (mcp/client) ──────────────────────────────
    const proxy = createProfileProxy(profile.sources, resolveSource)

    // ── Adapt proxy ResultAsync → Promise handlers for mcp/server ─────────
    const handlers = {
      async listTools() {
        const result = await proxy.listTools()
        // listTools always Ok (per-source resilience); if somehow Err, return empty.
        if (result.isErr())
          return { tools: [] as Array<{ name: string; description?: string; inputSchema: object }> }
        return { tools: result.value }
      },
      async callTool(name: string, callArgs: Record<string, unknown>) {
        const result = await proxy.callTool(name, callArgs)
        if (result.isErr()) {
          // Map to a safe MCP error response — NO secret in the message.
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: safeUpstreamMessage(result.error) }],
          }
        }
        // Forward the upstream result. Content comes from the upstream MCP server
        // (data, not secrets). isError reflects whether the upstream flagged an error.
        return {
          content: result.value.content as Array<{ type: "text"; text: string }>,
          isError: result.value.isError,
        }
      },
    }

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
