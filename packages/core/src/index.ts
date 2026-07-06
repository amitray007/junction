// SPDX-License-Identifier: AGPL-3.0-only

/** Junction core — public API. */

export {
  type Config,
  ConfigSchema,
  type ConfigState,
  DEFAULT_CONFIG,
  DEFAULT_MCP_PORT,
  DEFAULT_WEB_PORT,
  getMcpHost,
  getMcpPort,
  isValidMcpHost,
  isValidMcpPort,
  loadConfig,
  loadConfigState,
  OAUTH_CALLBACK_URI,
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
export { err, errAsync, ok, okAsync, type Result, ResultAsync } from "./result/index.js"
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
// Catalog-driven connect (increment 30.11) — interprets a surface's
// declarative build recipe into a concrete connect plan. Pure; no I/O.
export type {
  ConnectChoice,
  ConnectCredentialKind,
  ConnectPlan,
  ConnectPlanPreview,
  DescriptorPlatformInput,
  FlattenedAuth,
  FlattenedGraphQlInput,
  FlattenedMcpInput,
  FlattenedOpenApiInput,
  FlattenedPlatformInput,
  PlatformInput,
  RecipeError,
} from "./apps/build-recipe.js"
export { planConnect, resolvePlatformId, toConnectPlanPreview } from "./apps/build-recipe.js"
export { getCatalogEntry, listCatalogEntries } from "./apps/catalog/index.js"
// ---------------------------------------------------------------------------
// App catalog + grouping — pure data + pure functions (inc 30; no HTTP)
// ---------------------------------------------------------------------------
export type { AppAuth, AppDefinition } from "./apps/catalog.js"
export { getApp, listApps } from "./apps/catalog.js"
export type {
  AppCatalogEntry,
  AppHelp,
  AppSurface,
  AppSurfaceConnection,
  BuildRecipe,
  VerifyHint,
} from "./apps/catalog-schema.js"
export {
  AppCatalogEntrySchema,
  AppHelpSchema,
  AppSurfaceConnectionSchema,
  AppSurfaceSchema,
  BuildRecipeSchema,
  VerifyHintSchema,
} from "./apps/catalog-schema.js"
export type { AppGroup, Connection } from "./apps/group.js"
export { appIdForConnection, groupByApp } from "./apps/group.js"
export { intersectSurfaces } from "./apps/surface-connections.js"
// ---------------------------------------------------------------------------
// Browser — generic "open a URL" util (extracted from cli's `web` command;
// shared by web, the OAuth connect flow, and the OAuth device-code flow)
// ---------------------------------------------------------------------------
export { openInBrowser } from "./browser/open-browser.js"
// ---------------------------------------------------------------------------
// Credential store — encrypted-at-rest secret management
// ---------------------------------------------------------------------------
export {
  type AddCredentialInput,
  addCredential,
  type CredentialStore,
  compatibleCredentialKinds,
  createCredentialStore,
  isKindAccepted,
  type RenameCredentialInput,
  type RotateCredentialInput,
  removeCredential,
  renameCredential,
  rotateCredential,
} from "./credentials/index.js"
// Database + repositories
export { type Db, getDatabase } from "./db/index.js"
export type { ApiKeyError, CredentialError, DbError, SandboxError } from "./errors/index.js"
// ID generators — ids/ is the sole generator; see ids/index.ts for the swap-point comment
export { newApiKeyId, newCredentialId, newPlatformId, newProfileId } from "./ids/index.js"
// ---------------------------------------------------------------------------
// OAuth provider catalog — pure data + pure functions (inc 29; no HTTP)
// ---------------------------------------------------------------------------
export {
  buildAuthorizationParams,
  getProvider,
  listProviders,
  type NormalizedTokens,
  normalizeTokenResponse,
  type OAuthProvider,
  resolveScopeString,
} from "./oauth/catalog.js"
export {
  DEFAULT_REFRESH_BUFFER_MS,
  MAX_EXPIRES_IN_SECONDS,
  type RefreshError,
  type RefreshIfExpiredArgs,
  type RefreshResult,
  type RefreshTokenFn,
  refreshIfExpired,
  shouldRefresh,
  toExpiresAt,
} from "./oauth/refresh.js"
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
  CliSecret,
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
export type { Credential, CredentialVerifyResult, OAuthMeta } from "./schema/credential.js"
// Credential
export {
  CredentialKind,
  CredentialSchema,
  CredentialVerifyResult as CredentialVerifyResultSchema,
  OAuthMetaSchema,
} from "./schema/credential.js"
export type { GraphQlConnection } from "./schema/graphql-connection.js"
// GraphQlConnection — generic GraphQL source descriptor
export { GraphQlConnectionSchema } from "./schema/graphql-connection.js"
export type { HttpConnection, HttpParam, HttpRequestTool } from "./schema/http-connection.js"
// HttpConnection — user-authored REST request-tool source descriptor
export {
  HttpConnectionSchema,
  HttpParamSchema,
  HttpRequestToolSchema,
} from "./schema/http-connection.js"
export type { McpConnection, McpHttpAuth } from "./schema/mcp-connection.js"
// McpConnection — generic MCP transport descriptor (http | stdio)
export { McpConnectionSchema, McpHttpAuthSchema } from "./schema/mcp-connection.js"
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
// ---------------------------------------------------------------------------
// Sources — ToolProvider interface, naming helpers, profile proxy, providers
// ---------------------------------------------------------------------------
// Shared agent-arg string validation primitive (inc 30.7) — reused by every
// source provider that validates agent-supplied strings (cli, http-client).
export { rejectControlCharacters } from "./sources/arg-validation.js"
// CLI provider — sandboxed code-execution source (inc 21)
export { createCliProvider } from "./sources/cli/provider.js"
export { namespaceToolName, splitNamespacedName } from "./sources/naming.js"
export type { ProviderTool, ToolProvider, ToolResult } from "./sources/provider.js"
export type { ProfileProxy, ResolveProviderFn } from "./sources/proxy.js"
export { createProfileProxy } from "./sources/proxy.js"
export type { ScopedProxy, ScopedProxyEntry } from "./sources/scoped-proxy.js"
export { createScopedProxy } from "./sources/scoped-proxy.js"
