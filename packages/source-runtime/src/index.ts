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

export { buildProvider } from "./build-provider.js"
export type { ResolveCredentialError } from "./resolve-credential.js"
export { resolveCredentialSecret } from "./resolve-credential.js"
export type { ProviderResolution } from "./resolve-provider.js"
export { makeResolveProvider } from "./resolve-provider.js"
