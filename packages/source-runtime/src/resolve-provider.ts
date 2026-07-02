// SPDX-License-Identifier: AGPL-3.0-only
// makeResolveProvider — shared source-ref → provider resolver.
// Composition root: builds the resolveProvider closure injected into
// createProfileProxy / per-profile proxies (core).
//
// SECURITY: this closure writes log notes for skipped sources but NEVER logs
// secret values. The secret is fetched per-call and flows only into the
// ToolProvider's transport; it is never logged, serialized, or returned.

import {
  type CredentialStore,
  err,
  type JunctionPaths,
  ok,
  type Repositories,
  type Result,
  ResultAsync,
  type SourceRef,
  type ToolFilter,
  type ToolProvider,
  type UpstreamError,
} from "@junction/core"
import { buildProvider } from "./build-provider.js"

// ---------------------------------------------------------------------------
// ProviderResolution
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
