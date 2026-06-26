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
import { join } from "node:path"
import type { CredentialError, DbError } from "@junction/core"
import {
  createCredentialStore,
  err,
  type JunctionPaths,
  ok,
  type Platform,
  type Repositories,
  type Result,
  ResultAsync,
  type ToolProvider,
  type UpstreamError,
} from "@junction/core"

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
      const cacheFile = join(paths.home, "openapi", `${platform.id}.json`)
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

    return err({
      kind: "unsupported-source-kind" as const,
      platformKind: platform.kind,
    } satisfies UpstreamError)
  }

  return new ResultAsync(work())
}
