// SPDX-License-Identifier: AGPL-3.0-only

/** Junction core — public API. */

export {
  type Config,
  ConfigSchema,
  type ConfigState,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigState,
  saveConfig,
} from "./config/index.js"
export type { ConfigError, PathsError, UpstreamError } from "./errors/index.js"
export { getLogger, type Logger, setLogger } from "./logging/index.js"
export { ensureHome, getPaths, type JunctionPaths } from "./paths/index.js"
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
export { createSandbox } from "./sandbox/index.js"

// ---------------------------------------------------------------------------
// Data model — entity schemas, types, ID generators, convention helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Credential store — encrypted-at-rest secret management
// ---------------------------------------------------------------------------
export {
  type AddCredentialInput,
  addCredential,
  type CredentialStore,
  createCredentialStore,
  removeCredential,
} from "./credentials/index.js"
// Database + repositories
export { type Db, getDatabase } from "./db/index.js"
export type { CredentialError, DbError, SandboxError } from "./errors/index.js"
// ID generators — ids/ is the sole generator; see ids/index.ts for the swap-point comment
export { newCredentialId, newPlatformId, newProfileId } from "./ids/index.js"
export { createRepositories, type Repositories } from "./repositories/index.js"
export type { Credential, OAuthMeta } from "./schema/credential.js"
// Credential
export { CredentialKind, CredentialSchema, OAuthMetaSchema } from "./schema/credential.js"
export type { McpConnection } from "./schema/mcp-connection.js"
// McpConnection — generic MCP transport descriptor (http | stdio)
export { McpConnectionSchema } from "./schema/mcp-connection.js"
export type { Platform } from "./schema/platform.js"
// Platform
export { PlatformKind, PlatformSchema } from "./schema/platform.js"
export type { CredentialId, PlatformId, ProfileId } from "./schema/primitives.js"
// Branded ID schemas + types
// Convention helpers (load-bearing: renaming breaks agent prompts)
export {
  CredentialIdSchema,
  deriveMcpEndpointPath,
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

// ---------------------------------------------------------------------------
// Sources — ToolProvider interface, naming helpers, profile proxy
// ---------------------------------------------------------------------------
export { namespaceToolName, splitNamespacedName } from "./sources/naming.js"
export type { ProviderTool, ToolProvider, ToolResult } from "./sources/provider.js"
export type { ProfileProxy, ResolveProviderFn } from "./sources/proxy.js"
export { createProfileProxy } from "./sources/proxy.js"
