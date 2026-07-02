// SPDX-License-Identifier: AGPL-3.0-only
// Schema module barrel — curated named re-exports of the schema public surface.
// NO export * — per docs/principles/modularity.md §5 (narrow, curated barrels).

export type { Credential, OAuthMeta } from "./credential.js"
// Credential
export { CredentialKind, CredentialSchema, OAuthMetaSchema } from "./credential.js"
export type { McpConnection } from "./mcp-connection.js"
// McpConnection — generic MCP transport descriptor (http | stdio)
export { McpConnectionSchema } from "./mcp-connection.js"
export type { Platform } from "./platform.js"
// Platform
export { PlatformKind, PlatformSchema } from "./platform.js"
export type { ApiKeyId, ApiKeyLabel, CredentialId, PlatformId, ProfileId } from "./primitives.js"
// Primitives: branded ID schemas + types + convention schemas + helpers
export {
  ApiKeyIdSchema,
  ApiKeyLabelSchema,
  CredentialIdSchema,
  namespacedTool,
  PlatformIdSchema,
  ProfileIdSchema,
  ProfileNameSchema,
  ToolNamespaceSchema,
} from "./primitives.js"
export type { Profile } from "./profile.js"
// Profile
export { ProfileSchema } from "./profile.js"
export type { SourceRef, ToolFilter } from "./source-ref.js"
// SourceRef + ToolFilter
export { SourceRefSchema, ToolFilterSchema } from "./source-ref.js"
