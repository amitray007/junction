// SPDX-License-Identifier: AGPL-3.0-only

/** Junction core — public API. */

export {
  type Config,
  ConfigSchema,
  type ConfigState,
  DEFAULT_CONFIG,
  DEFAULT_MCP_PORT,
  getMcpHost,
  getMcpPort,
  isValidMcpHost,
  isValidMcpPort,
  loadConfig,
  loadConfigState,
  saveConfig,
  setMcpHost,
  setMcpPort,
} from "./config/index.js"
export type { ConfigError, PathsError, UpstreamError } from "./errors/index.js"
export { getLogger, type Logger, setLogger } from "./logging/index.js"
export {
  ensureHome,
  getPaths,
  type JunctionPaths,
  openapiSpecCacheFile,
} from "./paths/index.js"
export { err, ok, type Result, ResultAsync } from "./result/index.js"
export const VERSION = "0.0.0"

export type {
  Sandbox,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxResult,
} from "./sandbox/index.js"
// ---------------------------------------------------------------------------
// Sandbox — OS-level code-execution isolation (Seatbelt / bubblewrap / Deno)
// ---------------------------------------------------------------------------
export { createSandbox, validatePolicy } from "./sandbox/index.js"

// ---------------------------------------------------------------------------
// Data model — entity schemas, types, ID generators, convention helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// API keys — junction's own auth keys: mint/verify (increment 27)
// ---------------------------------------------------------------------------
export {
  type MintApiKeyInput,
  type MintedApiKey,
  mintApiKey,
  parseApiKeyToken,
  type ResolvedKey,
  sha256Hex,
  verifyApiKey,
} from "./api-keys/index.js"
// ---------------------------------------------------------------------------
// Credential store — encrypted-at-rest secret management
// ---------------------------------------------------------------------------
export {
  type AddCredentialInput,
  addCredential,
  type CredentialStore,
  createCredentialStore,
  type RotateCredentialInput,
  removeCredential,
  rotateCredential,
} from "./credentials/index.js"
// Database + repositories
export { type Db, getDatabase } from "./db/index.js"
export type { ApiKeyError, CredentialError, DbError, SandboxError } from "./errors/index.js"
// ID generators — ids/ is the sole generator; see ids/index.ts for the swap-point comment
export { newApiKeyId, newCredentialId, newPlatformId, newProfileId } from "./ids/index.js"
export type {
  ApiKeyRecord,
  ApiKeyScope,
  ApiKeysRepo,
  CreateApiKeyInput,
} from "./repositories/api-keys.js"
export { createRepositories, type Repositories } from "./repositories/index.js"
export type {
  CliArg,
  CliArgvSegment,
  CliConnection,
  CliPolicy,
  CliTool,
} from "./schema/cli-connection.js"
// CliConnection — sandboxed CLI source descriptor
export {
  CliArgSchema,
  CliArgvSegmentSchema,
  CliConnectionSchema,
  CliPolicySchema,
  CliToolSchema,
} from "./schema/cli-connection.js"
export type { Credential, OAuthMeta } from "./schema/credential.js"
// Credential
export { CredentialKind, CredentialSchema, OAuthMetaSchema } from "./schema/credential.js"
export type { GraphQlConnection } from "./schema/graphql-connection.js"
// GraphQlConnection — generic GraphQL source descriptor
export { GraphQlConnectionSchema } from "./schema/graphql-connection.js"
export type { McpConnection } from "./schema/mcp-connection.js"
// McpConnection — generic MCP transport descriptor (http | stdio)
export { McpConnectionSchema } from "./schema/mcp-connection.js"
export type {
  OpenApiAuth,
  OpenApiConnection,
  OpenApiSelect,
  SpecSource,
} from "./schema/openapi-connection.js"
// OpenApiConnection — generic OpenAPI/REST source descriptor
export {
  OpenApiAuthSchema,
  OpenApiConnectionSchema,
  OpenApiSelectSchema,
  SpecSourceSchema,
} from "./schema/openapi-connection.js"
export type { Platform } from "./schema/platform.js"
// Platform
export { PlatformKind, PlatformSchema } from "./schema/platform.js"
export type {
  ApiKeyId,
  ApiKeyLabel,
  CredentialId,
  PlatformId,
  ProfileId,
} from "./schema/primitives.js"
// Branded ID schemas + types
// Convention helpers (load-bearing: renaming breaks agent prompts)
export {
  ApiKeyIdSchema,
  ApiKeyLabelSchema,
  CredentialIdSchema,
  namespacedTool,
  PlatformIdSchema,
  ProfileIdSchema,
  ProfileNameSchema,
  ToolNamespaceSchema,
} from "./schema/primitives.js"
export type { Profile } from "./schema/profile.js"
// Profile
export { ProfileSchema } from "./schema/profile.js"
export type { SourceRef, ToolFilter } from "./schema/source-ref.js"
// SourceRef + ToolFilter
export { SourceRefSchema, ToolFilterSchema } from "./schema/source-ref.js"
// CLI provider — sandboxed code-execution source (inc 21)
export { createCliProvider } from "./sources/cli/provider.js"
// ---------------------------------------------------------------------------
// Sources — ToolProvider interface, naming helpers, profile proxy, providers
// ---------------------------------------------------------------------------
export { namespaceToolName, splitNamespacedName } from "./sources/naming.js"
export type { ProviderTool, ToolProvider, ToolResult } from "./sources/provider.js"
export type { ProfileProxy, ResolveProviderFn } from "./sources/proxy.js"
export { createProfileProxy } from "./sources/proxy.js"
export type { ScopedProxy, ScopedProxyEntry } from "./sources/scoped-proxy.js"
export { createScopedProxy } from "./sources/scoped-proxy.js"
