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
// DISPATCH BY KIND (increment 14):
//   resolveProvider switches on platform.kind:
//     "mcp"     → build McpToolProvider via mcp/client
//     other     → unsupported-source-kind error (skipped per-source gracefully)
//   Future kinds (openapi/graphql) plug in here without touching the proxy.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createCredentialStore,
  createProfileProxy,
  createRepositories,
  deriveMcpEndpointPath,
  err,
  getDatabase,
  getPaths,
  ok,
  type Profile,
  ProfileIdSchema,
  type Result,
  ResultAsync,
  type SourceRef,
  type ToolProvider,
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
    // Lazy imports: mcp/server, mcp/client, and openapi-client are only loaded when
    // this command runs. This avoids paying the import cost for every other CLI command.
    const [{ serveStdio, safeUpstreamMessage }, { createMcpProvider }] = await Promise.all([
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

    // ── Build resolveProvider (injected into the proxy) ───────────────────
    //
    // SECURITY: resolveProvider writes stderr notes for skipped sources but NEVER
    // leaks secret values. The secret is returned in the ToolProvider's transport
    // and flows only to the upstream; it is never logged or serialized.
    //
    // DISPATCH BY KIND: switches on platform.kind so future source types plug in
    // without touching the proxy. unsupported-source-kind → skipped per-source.

    type ProviderResolution = {
      provider: ToolProvider
      toolNamespace: string
      toolFilter?: import("@junction/core").ToolFilter | undefined
    }

    const resolveProvider = (
      sourceRef: SourceRef,
    ): ResultAsync<ProviderResolution, UpstreamError> => {
      const work = async (): Promise<Result<ProviderResolution, UpstreamError>> => {
        // Resolve the platform.
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

        // ── Dispatch by kind — unsupported kinds are cleanly skipped ──────
        if (platform.kind !== "mcp" && platform.kind !== "openapi") {
          process.stderr.write(
            `junction mcp serve: source "${sourceRef.toolNamespace}": platform kind "${platform.kind}" not yet supported — skipping\n`,
          )
          return err({
            kind: "unsupported-source-kind" as const,
            platformKind: platform.kind,
          } satisfies UpstreamError)
        }

        // ── Resolve credential (skip entirely when no credentialId — public source) ──────
        let secret: string | null = null
        if (sourceRef.credentialId === undefined) {
          // No credential attached — public/no-auth source. secret stays null.
          // Warn on stderr if the platform declares auth (informative, not blocking).
          const authDeclared =
            (platform.kind === "mcp" &&
              platform.connection !== undefined &&
              (platform.connection.transport === "http"
                ? platform.connection.auth !== undefined
                : platform.connection.tokenEnvVar !== undefined)) ||
            (platform.kind === "openapi" &&
              platform.openapi !== undefined &&
              platform.openapi.auth !== undefined)
          if (authDeclared) {
            process.stderr.write(
              `junction mcp serve: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" declares auth but no credential is attached — calls may be unauthorized\n`,
            )
          }
        } else {
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
        }

        // ── MCP provider ────────────────────────────────────────────────────
        if (platform.kind === "mcp") {
          if (platform.connection === undefined) {
            process.stderr.write(
              `junction mcp serve: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" has no connection descriptor — skipping\n`,
            )
            return err({
              kind: "connect-failed" as const,
              cause: "platform has no connection descriptor",
            } satisfies UpstreamError)
          }

          const providerResult = await createMcpProvider(platform.connection, secret)
          if (providerResult.isErr()) {
            process.stderr.write(
              `junction mcp serve: source "${sourceRef.toolNamespace}": connection failed — skipping\n`,
            )
            return err(providerResult.error)
          }

          return ok({
            provider: providerResult.value,
            toolNamespace: sourceRef.toolNamespace,
            toolFilter: sourceRef.toolFilter,
          })
        }

        // ── OpenAPI provider ────────────────────────────────────────────────
        if (platform.openapi === undefined) {
          process.stderr.write(
            `junction mcp serve: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" has no openapi descriptor — skipping\n`,
          )
          return err({
            kind: "connect-failed" as const,
            cause: "platform has no openapi descriptor",
          } satisfies UpstreamError)
        }

        // Load the cached dereferenced spec (written by `platform add`)
        const cacheFile = join(paths.home, "openapi", `${platform.id}.json`)
        let cachedSchema: Record<string, unknown>
        try {
          const text = await readFile(cacheFile, "utf8")
          cachedSchema = JSON.parse(text) as Record<string, unknown>
        } catch (cause) {
          process.stderr.write(
            `junction mcp serve: source "${sourceRef.toolNamespace}": cached spec not found at ${cacheFile} — skipping\n`,
          )
          return err({ kind: "connect-failed" as const, cause } satisfies UpstreamError)
        }

        // Use the cached schema inline so we never re-fetch the spec URL at serve-time
        const { createOpenApiProvider } = await import("@junction/openapi-client")
        const openapiConnection = {
          ...platform.openapi,
          spec: { from: "inline" as const, document: cachedSchema },
        }
        const openapiProvider = createOpenApiProvider(openapiConnection, secret)

        return ok({
          provider: openapiProvider,
          toolNamespace: sourceRef.toolNamespace,
          toolFilter: sourceRef.toolFilter,
        })
      }
      return new ResultAsync(work())
    }

    // ── Build the profile proxy (core) ────────────────────────────────────
    const proxy = createProfileProxy(profile.sources, resolveProvider)

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
