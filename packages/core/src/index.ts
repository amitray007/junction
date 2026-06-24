// SPDX-License-Identifier: AGPL-3.0-only

/** Junction core — public API. */

export {
  type Config,
  ConfigSchema,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
} from "./config/index.js"
export type { ConfigError, PathsError } from "./errors/index.js"
export { getLogger, type Logger, setLogger } from "./logging/index.js"
export { ensureHome, getPaths, type JunctionPaths } from "./paths/index.js"
export { err, ok, type Result, ResultAsync } from "./result/index.js"
export const VERSION = "0.0.0"
