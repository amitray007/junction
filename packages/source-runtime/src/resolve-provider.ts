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
  type RefreshTokenFn,
  type Repositories,
  type Result,
  ResultAsync,
  refreshIfExpired,
  type SourceRef,
  type ToolFilter,
  type ToolProvider,
  type UpstreamError,
} from "@junction/core"
import { buildProvider, type ResolvedSecret } from "./build-provider.js"
import { oauthRefreshFn } from "./oauth-refresh-fn.js"
import { refreshIfExpiredSingleFlight } from "./refresh-singleflight.js"

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

      // ── Dispatch by kind — buildProvider (below) already handles all 5 kinds
      // (mcp/openapi/graphql/http/cli); this closure has no kind-specific logic
      // of its own beyond the authDeclared warn below, so there is nothing left
      // to gate here. "custom" is the one PlatformKind buildProvider itself
      // doesn't dispatch (falls through to its own unsupported-source-kind) —
      // that stays a clean skip, surfaced by buildProvider's own Err below,
      // not duplicated as a second check here.
      // ── Resolve credential (skip entirely when no credentialId — public source) ──────
      let secret: ResolvedSecret | null = null
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
            platform.openapi.auth !== undefined) ||
          (platform.kind === "graphql" &&
            platform.graphql !== undefined &&
            platform.graphql.auth !== undefined) ||
          (platform.kind === "http" &&
            platform.http !== undefined &&
            platform.http.auth !== undefined) ||
          (platform.kind === "cli" &&
            platform.cli !== undefined &&
            platform.cli.credentialEnvVar !== undefined)
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

        if (store !== null && credential.kind === "oauth2") {
          // OAuth credential: refresh-ahead (inc 29 slice A2) before ever
          // reading the store directly — refreshIfExpired owns the "current
          // token" read (unchanged when no refresh is due), the JIT
          // resolution of the refresh token / BYO client id+secret from the
          // store, and single-flights across concurrent resolves that share
          // this credentialId (the listTools fan-out race, F2).
          //
          // oauthRefreshFn (inc29-B) is the arctic-backed HTTP call —
          // core never makes it directly, keeping core HTTP-free.
          const refreshFn: RefreshTokenFn = oauthRefreshFn

          const refreshResult = await refreshIfExpiredSingleFlight(credential.id, () =>
            refreshIfExpired({ credential, store, repos, refreshFn, now: Date.now() }),
          )
          if (refreshResult.isErr()) {
            if (refreshResult.error.kind === "needs-reauth") {
              log(
                `${logPrefix}: source "${sourceRef.toolNamespace}": credential "${sourceRef.credentialId}" needs reconnect — skipping`,
              )
              return err({
                kind: "needs-reauth" as const,
                platformId: refreshResult.error.platformId,
                account: refreshResult.error.account,
              } satisfies UpstreamError)
            }
            // refresh-failed | not-oauth (defensive) — a transient refresh
            // failure surfaces as auth-failed, which is honest: the call
            // cannot proceed with a trustworthy token right now.
            // inc29: on-401 reactive refresh is a fast-follow (F1) — this is
            // the refresh-ahead path only.
            log(
              `${logPrefix}: source "${sourceRef.toolNamespace}": credential refresh failed — skipping`,
            )
            return err({
              kind: "auth-failed" as const,
              cause: refreshResult.error,
            } satisfies UpstreamError)
          }
          // A null accessToken means the store has no value for the
          // secretRef (a lost/cleared secret) — mirror the non-oauth2
          // else-branch below exactly: treat it as "no credential" (secret
          // = null), NEVER as a fake empty-string bearer token.
          secret =
            refreshResult.value.accessToken === null
              ? null
              : { kind: credential.kind, value: refreshResult.value.accessToken }
        } else if (store !== null) {
          // Resolve the plaintext secret from the store.
          // If store is null (store unavailable), secret is null (no auth).
          // A null VALUE from the store (lost/cleared secret) is treated the
          // same as "no credential" — never a fake auth attempt.
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
          secret =
            secretResult.value === null
              ? null
              : { kind: credential.kind, value: secretResult.value }
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
