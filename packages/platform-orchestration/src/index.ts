// SPDX-License-Identifier: AGPL-3.0-only
// @junction/platform-orchestration public API — narrow barrel.
// Extracts the platform add/refresh assembly shared by the cli and web apps.
// Persistence stays with the caller: add* returns the assembled Platform (the
// caller upserts it); refresh* takes the already-loaded platform and returns
// the updated Platform for the caller to upsert.

export type { AuthInput } from "./auth.js"
export { buildPlatformAuth, deriveAuthFromSpec } from "./auth.js"
export type { AddCliPlatformInput, AddCliPlatformResult } from "./cli.js"
export { addCliPlatform } from "./cli.js"
export type { PlatformOrchestrationError } from "./errors.js"
export type { AddGraphQlPlatformInput, AddGraphQlPlatformResult } from "./graphql.js"
export { addGraphQlPlatform } from "./graphql.js"
export type { AddMcpPlatformInput } from "./mcp.js"
export { addMcpPlatform } from "./mcp.js"
export type { AddOpenApiPlatformInput, AddOpenApiPlatformResult } from "./openapi.js"
export { addOpenApiPlatform } from "./openapi.js"
export type { RefreshOpenApiPlatformInput, RefreshOpenApiPlatformResult } from "./refresh.js"
export { refreshOpenApiPlatform } from "./refresh.js"
