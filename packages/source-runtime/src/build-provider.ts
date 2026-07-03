// SPDX-License-Identifier: AGPL-3.0-only
// buildProvider — dispatch-by-kind provider construction.
// Composition root: wires @junction/mcp-client / @junction/openapi-client /
// @junction/graphql-client / @junction/core (createCliProvider) together.
// Lazy-imports the provider libs to avoid paying startup cost for callers
// that never build a provider of that kind.
//
// buildProvider: does NOT write stderr — it returns the error; callers report it in
// whatever format is appropriate (mcp serve → per-source skipping note;
// debug → reportUpstreamError).
//
// SECRET DISCIPLINE: the secret flows only into the provider transport; it is
// NEVER logged, serialized, or returned in any output.

import { readFile } from "node:fs/promises"
import {
  type CredentialKind,
  err,
  type JunctionPaths,
  ok,
  openapiSpecCacheFile,
  type Platform,
  type Result,
  ResultAsync,
  type ToolProvider,
  type UpstreamError,
} from "@junction/core"

// ---------------------------------------------------------------------------
// ResolvedSecret — the kind-tagged secret buildProvider accepts
// ---------------------------------------------------------------------------

/**
 * The secret buildProvider accepts, tagged with the credential row's kind.
 *
 * Only the "cli" branch consults `kind` (to decide env-injection vs file-
 * materialization, via CliSecret in core) — mcp/openapi/graphql read only
 * `.value` and are BYTE-IDENTICAL to their pre-28.9 behaviour; they never see
 * `kind`, so a future credential kind can't silently change their behaviour.
 */
export type ResolvedSecret = { kind: CredentialKind; value: string }

/**
 * Adapt resolveCredentialSecret's `{secret, kind}` shape to the `ResolvedSecret
 * | null` buildProvider expects. Shared by every direct buildProvider caller
 * (debug probe/call) so the null-check-then-wrap isn't duplicated at each
 * call site (@junction/source-runtime is already their shared import).
 */
export function toResolvedSecret(
  secret: string | null,
  kind: CredentialKind,
): ResolvedSecret | null {
  return secret === null ? null : { kind, value: secret }
}

// ---------------------------------------------------------------------------
// buildProvider
// ---------------------------------------------------------------------------

/**
 * Build a ToolProvider for a platform, dispatching by platform.kind.
 *
 * Lazy-imports @junction/mcp-client / @junction/openapi-client inside the
 * kind branches — this is the composition-root that wires app-layer libs
 * together; the lazy pattern avoids paying the import cost for unrelated
 * callers (mirroring the pattern in mcp.ts).
 *
 * Normalizes the MCP / OpenAPI asymmetry:
 *   MCP:     createMcpProvider returns ResultAsync<ToolProvider> (eager connect).
 *   OpenAPI: createOpenApiProvider returns ToolProvider (synchronous) → wrapped in okAsync().
 * Both are normalized to ResultAsync<ToolProvider, UpstreamError>.
 *
 * @param platform - Platform row from the DB (kind + connection / openapi descriptors).
 * @param secret   - Resolved credential, kind-tagged, or null for public/no-auth
 *                   sources. The mcp/openapi/graphql branches read ONLY
 *                   `secret.value` (byte-identical to pre-28.9 — they never see
 *                   `kind`). Only the "cli" branch consults `kind`, to build the
 *                   CliSecret createCliProvider needs for the file-kind mechanics
 *                   (increment 28.9 slice D) — every OTHER stored kind
 *                   (bearer/api-key/oauth2) folds to CliSecret's "env" there,
 *                   preserving legacy behaviour for historical cli credentials
 *                   (which were all labeled "bearer" before this increment).
 * @param paths    - Junction paths (home dir); used to locate the cached OpenAPI
 *                   spec AND (cli branch) passed through to createCliProvider,
 *                   which uses `paths.runtimeDir` for kind "file" credential
 *                   materialization (increment 28.9 slice D hardening) — a
 *                   junction-private 0700 dir INSIDE the junction home, never
 *                   the shared OS tmpdir.
 */
export function buildProvider(
  platform: Platform,
  secret: ResolvedSecret | null,
  paths: JunctionPaths,
): ResultAsync<ToolProvider, UpstreamError> {
  const secretValue = secret?.value ?? null

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
      return createMcpProvider(platform.connection, secretValue)
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
      return ok(createOpenApiProvider(openapiConnection, secretValue))
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
      return ok(createGraphQlProvider(platform.graphql, secretValue))
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
      // Fold the stored CredentialKind down to CliSecret's "env" | "file":
      // kind "file" materializes to a temp file; every other stored kind
      // (env/bearer/api-key/oauth2) injects the value directly via "env" —
      // this is the legacy back-compat path (every historical cli credential
      // was labeled "bearer").
      const cliSecret =
        secret === null
          ? null
          : {
              kind: secret.kind === "file" ? ("file" as const) : ("env" as const),
              value: secret.value,
            }
      return ok(createCliProvider(platform.cli, cliSecret, paths))
    }

    return err({
      kind: "unsupported-source-kind" as const,
      platformKind: platform.kind,
    } satisfies UpstreamError)
  }

  return new ResultAsync(work())
}
