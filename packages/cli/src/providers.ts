// SPDX-License-Identifier: AGPL-3.0-only
// CLI provider-building primitives — buildProvider (dispatch-by-kind) + resolveCredentialSecret.
// Composition root: wires @junction/mcp-client / @junction/openapi-client together.
// Lives in cli (app layer); lazy-imports the provider libs to avoid paying startup cost.
//
// buildProvider: does NOT write stderr — it returns the error; callers report it in
// whatever format is appropriate (mcp serve → per-source skipping note;
// debug → reportUpstreamError).
//
// SECRET DISCIPLINE: the secret flows only into the provider transport; it is
// NEVER logged, serialized, or returned in any output.

import { readFile } from "node:fs/promises"
import type { CredentialError, DbError } from "@junction/core"
import {
  type CredentialStore,
  createCredentialStore,
  err,
  type JunctionPaths,
  ok,
  openapiSpecCacheFile,
  type Platform,
  type Repositories,
  type Result,
  ResultAsync,
  type SourceRef,
  type ToolFilter,
  type ToolProvider,
  type UpstreamError,
} from "@junction/core"
import type { McpServerHandlers } from "@junction/mcp-server"

// ---------------------------------------------------------------------------
// ResolveCredentialError — discriminated union for credential resolution failures
// ---------------------------------------------------------------------------

/** Error returned by resolveCredentialSecret — wraps the underlying error kind. */
export type ResolveCredentialError =
  | { kind: "db"; error: DbError }
  | { kind: "credential"; error: CredentialError }

// ---------------------------------------------------------------------------
// resolveCredentialSecret
// ---------------------------------------------------------------------------

/**
 * Resolve a credential's plaintext secret and account name from the store.
 *
 * Absent or empty credentialId → {secret:null, account:"public"} with NO store touch.
 * Present credentialId → looks up the credential in the DB, opens the credential
 * store, and reads the secret by its secretRef.
 *
 * SECRET DISCIPLINE: the returned secret is never logged or serialized by this
 * module. The caller passes it directly to buildProvider and nothing else.
 */
export function resolveCredentialSecret(
  repos: Repositories,
  paths: JunctionPaths,
  credentialId?: string,
): ResultAsync<{ secret: string | null; account: string }, ResolveCredentialError> {
  if (credentialId === undefined || credentialId === "") {
    return new ResultAsync(
      Promise.resolve(ok({ secret: null as string | null, account: "public" })),
    )
  }

  const work = async (): Promise<
    Result<{ secret: string | null; account: string }, ResolveCredentialError>
  > => {
    const credResult = await repos.credentials.get(credentialId)
    if (credResult.isErr()) {
      return err({ kind: "db" as const, error: credResult.error })
    }
    const credential = credResult.value

    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      return err({ kind: "credential" as const, error: storeResult.error })
    }
    const store = storeResult.value

    const secretResult = await store.get(credential.secretRef)
    if (secretResult.isErr()) {
      return err({ kind: "credential" as const, error: secretResult.error })
    }

    return ok({ secret: secretResult.value, account: credential.profileName })
  }

  return new ResultAsync(work())
}

// ---------------------------------------------------------------------------
// buildProvider
// ---------------------------------------------------------------------------

/**
 * Build a ToolProvider for a platform, dispatching by platform.kind.
 *
 * Lazy-imports @junction/mcp-client / @junction/openapi-client inside the
 * kind branches — this is the composition-root that wires app-layer libs
 * together; the lazy pattern avoids paying the import cost for unrelated CLI
 * commands (mirroring the pattern in mcp.ts).
 *
 * Normalizes the MCP / OpenAPI asymmetry:
 *   MCP:     createMcpProvider returns ResultAsync<ToolProvider> (eager connect).
 *   OpenAPI: createOpenApiProvider returns ToolProvider (synchronous) → wrapped in okAsync().
 * Both are normalized to ResultAsync<ToolProvider, UpstreamError>.
 *
 * @param platform - Platform row from the DB (kind + connection / openapi descriptors).
 * @param secret   - Resolved plaintext credential, or null for public/no-auth sources.
 * @param paths    - Junction paths (home dir); used to locate the cached OpenAPI spec.
 */
export function buildProvider(
  platform: Platform,
  secret: string | null,
  paths: JunctionPaths,
): ResultAsync<ToolProvider, UpstreamError> {
  const work = async (): Promise<Result<ToolProvider, UpstreamError>> => {
    if (platform.kind === "mcp") {
      if (platform.connection === undefined) {
        return err({
          kind: "connect-failed" as const,
          cause: "platform has no connection descriptor",
        } satisfies UpstreamError)
      }
      const { createMcpProvider } = await import("@junction/mcp-client")
      // createMcpProvider returns ResultAsync<ToolProvider>; awaiting gives Result<ToolProvider>.
      return createMcpProvider(platform.connection, secret)
    }

    if (platform.kind === "openapi") {
      if (platform.openapi === undefined) {
        return err({
          kind: "connect-failed" as const,
          cause: "platform has no openapi descriptor",
        } satisfies UpstreamError)
      }

      // Load the cached dereferenced spec (written by `platform add`).
      // async readFile — no readFileSync (docs/rules/typescript.md + boundary guard).
      const cacheFile = openapiSpecCacheFile(paths, platform.id)
      let cachedSchema: Record<string, unknown>
      try {
        const text = await readFile(cacheFile, "utf8")
        cachedSchema = JSON.parse(text) as Record<string, unknown>
      } catch (cause) {
        return err({ kind: "connect-failed" as const, cause } satisfies UpstreamError)
      }

      // Use the cached schema inline so we never re-fetch the spec URL at serve/debug time.
      const { createOpenApiProvider } = await import("@junction/openapi-client")
      const openapiConnection = {
        ...platform.openapi,
        spec: { from: "inline" as const, document: cachedSchema },
      }
      // createOpenApiProvider returns ToolProvider (synchronous) — normalize to ResultAsync.
      return ok(createOpenApiProvider(openapiConnection, secret))
    }

    if (platform.kind === "graphql") {
      if (platform.graphql === undefined) {
        return err({
          kind: "connect-failed" as const,
          cause: "platform has no graphql descriptor",
        } satisfies UpstreamError)
      }
      const { createGraphQlProvider } = await import("@junction/graphql-client")
      // createGraphQlProvider returns ToolProvider (synchronous) — normalize to ResultAsync.
      return ok(createGraphQlProvider(platform.graphql, secret))
    }

    if (platform.kind === "cli") {
      if (platform.cli === undefined) {
        return err({
          kind: "connect-failed" as const,
          cause: "platform has no cli descriptor",
        } satisfies UpstreamError)
      }
      // createCliProvider is in core (no separate package). Import lazily to
      // match the pattern for other kinds; core is already loaded so no extra cost.
      const { createCliProvider } = await import("@junction/core")
      return ok(createCliProvider(platform.cli, secret))
    }

    return err({
      kind: "unsupported-source-kind" as const,
      platformKind: platform.kind,
    } satisfies UpstreamError)
  }

  return new ResultAsync(work())
}

// ---------------------------------------------------------------------------
// makeResolveProvider — shared source-ref → provider resolver
// ---------------------------------------------------------------------------

/** Resolved provider + the routing info the profile proxy needs to wire it in. */
export type ProviderResolution = {
  provider: ToolProvider
  toolNamespace: string
  toolFilter?: ToolFilter | undefined
}

/**
 * Build a `resolveProvider` closure (injected into `createProfileProxy` /
 * per-profile proxies) that resolves a SourceRef → ToolProvider.
 *
 * Shared between `junction mcp serve` (stdio) and `junction serve` (HTTP) —
 * both build the identical resolution pipeline (platform lookup → kind check
 * → auth-declared-but-no-credential warn → resolveCredentialSecret →
 * buildProvider); they differ only in the log prefix and log sink (stdio
 * serve writes stderr directly to keep stdout pure for the MCP channel; HTTP
 * serve logs via consola). `opts.logPrefix` and `opts.log` parameterize that
 * difference so the resolution logic itself isn't duplicated.
 *
 * DISPATCH BY KIND: switches on platform.kind so future source types plug in
 * without touching the proxy. unsupported-source-kind → skipped per-source.
 *
 * SECURITY: this closure writes log notes for skipped sources but NEVER logs
 * secret values. The secret is fetched per-call and flows only into the
 * ToolProvider's transport; it is never logged, serialized, or returned.
 */
export function makeResolveProvider(
  repos: Repositories,
  store: CredentialStore | null,
  paths: JunctionPaths,
  opts: { logPrefix: string; log?: (msg: string) => void },
): (sourceRef: SourceRef) => ResultAsync<ProviderResolution, UpstreamError> {
  const log = opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const { logPrefix } = opts

  return (sourceRef: SourceRef): ResultAsync<ProviderResolution, UpstreamError> => {
    const work = async (): Promise<Result<ProviderResolution, UpstreamError>> => {
      // Resolve the platform.
      const platformResult = await repos.platforms.get(sourceRef.platformId)
      if (platformResult.isErr()) {
        log(
          `${logPrefix}: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" not found — skipping`,
        )
        return err({
          kind: "connect-failed" as const,
          cause: platformResult.error,
        } satisfies UpstreamError)
      }
      const platform = platformResult.value

      // ── Dispatch by kind — unsupported kinds are cleanly skipped ──────
      if (platform.kind !== "mcp" && platform.kind !== "openapi") {
        log(
          `${logPrefix}: source "${sourceRef.toolNamespace}": platform kind "${platform.kind}" not yet supported — skipping`,
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
        // Warn on the log if the platform declares auth (informative, not blocking).
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
          log(
            `${logPrefix}: source "${sourceRef.toolNamespace}": platform "${sourceRef.platformId}" declares auth but no credential is attached — calls may be unauthorized`,
          )
        }
      } else {
        const credResult = await repos.credentials.get(sourceRef.credentialId)
        if (credResult.isErr()) {
          log(
            `${logPrefix}: source "${sourceRef.toolNamespace}": credential "${sourceRef.credentialId}" not found — skipping`,
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
            log(
              `${logPrefix}: source "${sourceRef.toolNamespace}": credential store read failed — skipping`,
            )
            return err({
              kind: "connect-failed" as const,
              cause: secretResult.error,
            } satisfies UpstreamError)
          }
          secret = secretResult.value
        }
      }

      // ── Build the provider via the shared primitive (buildProvider above) ─────
      // buildProvider dispatches by kind (mcp/openapi/else), lazy-imports the
      // right lib, and normalises the MCP/OpenAPI async asymmetry. It never
      // logs — we log the per-source skipping note on error here.
      const providerResult = await buildProvider(platform, secret, paths)
      if (providerResult.isErr()) {
        // buildProvider returns the cause (e.g. missing connection/openapi descriptor,
        // ENOENT on the cached spec path); surface it so the skip is diagnosable.
        const cause =
          "cause" in providerResult.error ? String(providerResult.error.cause ?? "") : ""
        log(
          `${logPrefix}: source "${sourceRef.toolNamespace}": connection failed — skipping${cause ? ` (${cause})` : ""}`,
        )
        return err(providerResult.error)
      }

      return ok({
        provider: providerResult.value,
        toolNamespace: sourceRef.toolNamespace,
        toolFilter: sourceRef.toolFilter,
      })
    }
    return new ResultAsync(work())
  }
}

// ---------------------------------------------------------------------------
// adaptToMcpHandlers — ResultAsync proxy → Promise-based McpServerHandlers
// ---------------------------------------------------------------------------

/**
 * Adapt a core proxy (ProfileProxy or ScopedProxy — both ResultAsync-based)
 * to McpServerHandlers (Promise-based), the shape createMcpServer / serveStdio
 * / serveHttp expect.
 *
 * Shared between `junction mcp serve` (wraps a single ProfileProxy) and
 * `junction serve` (wraps a ScopedProxy over multiple profiles) — both need
 * the identical Result→Promise unwrap plus the safe-error-message mapping on
 * callTool. `safeUpstreamMessage` is lazy-imported (mirrors the mcp-server
 * import pattern already used at each call site) so cli commands that never
 * hit this path don't pay for it.
 *
 * SECURITY: callTool's error path renders via safeUpstreamMessage — NO
 * secret value is ever placed in the response.
 */
export function adaptToMcpHandlers(proxy: {
  listTools: () => ResultAsync<
    Array<{ name: string; description?: string; inputSchema: object }>,
    UpstreamError
  >
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => ResultAsync<{ content: unknown; isError?: boolean }, UpstreamError>
}): McpServerHandlers {
  return {
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
        const { safeUpstreamMessage } = await import("@junction/mcp-server")
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
}
