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
export type { ConfigError, PathsError } from "./errors/index.js"
export { getLogger, type Logger, setLogger } from "./logging/index.js"
export { ensureHome, getPaths, type JunctionPaths } from "./paths/index.js"
export { err, ok, type Result, ResultAsync } from "./result/index.js"
export const VERSION = "0.0.0"

// ---------------------------------------------------------------------------
// Data model — entity schemas, types, ID generators, convention helpers
// ---------------------------------------------------------------------------

// ID generators — ids/ is the sole generator; see ids/index.ts for the swap-point comment
export { newCredentialId, newPlatformId, newProfileId } from "./ids/index.js"
export type { Credential, OAuthMeta } from "./schema/credential.js"
// Credential
export { CredentialKind, CredentialSchema, OAuthMetaSchema } from "./schema/credential.js"
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
export type { SourceRef } from "./schema/source-ref.js"
// SourceRef
export { SourceRefSchema } from "./schema/source-ref.js"
