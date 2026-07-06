// SPDX-License-Identifier: AGPL-3.0-only
// @junction/source-runtime public API — narrow barrel.
// Provider-building + source resolution primitives shared by the cli and web
// apps: buildProvider (dispatch-by-kind), resolveCredentialSecret (credential
// store lookup), makeResolveProvider (SourceRef → provider resolver injected
// into createProfileProxy). Extracted from cli/src/providers.ts (increment 28)
// — the same precedent as @junction/platform-orchestration.
//
// adaptToMcpHandlers is NOT here — it bridges a proxy to the MCP-server
// handler shape, a serving concern that stays in cli (see method file 28,
// "Boundary note — why adaptToMcpHandlers stays in cli").

export type { ResolvedSecret } from "./build-provider.js"
export { buildProvider, toResolvedSecret } from "./build-provider.js"
// Catalog-driven one-click connect (increment 30.11) — the verify-gated
// executor that runs a core build-recipe ConnectPlan through the SAME
// validated add/verify/persist path the manual /credentials + /platforms
// flows use, adding only a pre-write collision guard + verify-before-commit.
export type {
  ConfirmThenAddArgs,
  ConnectError,
  ConnectResult,
  VerifyThenAddArgs,
} from "./connect-from-catalog.js"
export { confirmThenAdd, verifyThenAdd } from "./connect-from-catalog.js"
export { formatUpstreamError } from "./format-error.js"
// OAuth connect flows (increment 29, slice B) — the arctic/fetch-touching
// composition the CLI (D) and web (C) build `junction connect` / "Connect" on.
export type {
  BuildAuthorizeUrlArgs,
  BuildAuthorizeUrlResult,
  DeviceAuthorizeArgs,
  DeviceAuthorizeResult,
  DevicePollArgs,
  ExchangeCodeArgs,
  OAuthConnectError,
  PersistOAuthTokensArgs,
  PersistOAuthTokensUpdateArgs,
} from "./oauth-connect.js"
export {
  buildAuthorizeUrl,
  deviceAuthorize,
  devicePoll,
  exchangeCode,
  persistOAuthTokens,
} from "./oauth-connect.js"
// The arctic-backed RefreshTokenFn (increment 29, slice B) — the injected
// provider refresh HTTP call core's refreshIfExpired orchestrates.
export { oauthRefreshFn } from "./oauth-refresh-fn.js"
export { refreshIfExpiredSingleFlight } from "./refresh-singleflight.js"
export type { ResolveCredentialError } from "./resolve-credential.js"
export { resolveCredentialSecret } from "./resolve-credential.js"
export type { ProviderResolution } from "./resolve-provider.js"
export { makeResolveProvider } from "./resolve-provider.js"
export type { VerifyOptions, VerifyOutcome } from "./verify-credential.js"
export { verifyCredential } from "./verify-credential.js"
