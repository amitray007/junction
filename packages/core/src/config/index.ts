// SPDX-License-Identifier: AGPL-3.0-only
// Config load/save with Zod validation and atomic locked writes.
//
// Locking strategy: we lock the HOME DIRECTORY (not config.json) with a
// custom lockfilePath so the lock target always exists (ensureHome guarantees
// it). Locking config.json directly would fail on first write because
// proper-lockfile's realpath:true (the default) requires the locked file to
// exist — which it doesn't before the first saveConfig.

import { readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { err, ok, ResultAsync } from "neverthrow"
import { z } from "zod"
import type { ConfigError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"

export const ConfigSchema = z.object({ version: z.literal(1) })

export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: Config = { version: 1 }

export function loadConfig(paths: JunctionPaths): ResultAsync<Config, ConfigError> {
  return new ResultAsync(
    readFile(paths.configFile, "utf-8")
      .then((raw) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return err<Config, ConfigError>({ kind: "invalid", issues: ["invalid JSON"] })
        }
        const result = ConfigSchema.safeParse(parsed)
        if (!result.success) {
          return err<Config, ConfigError>({
            kind: "invalid",
            issues: result.error.issues.map((i) => i.message),
          })
        }
        return ok<Config, ConfigError>(result.data)
      })
      .catch((cause: unknown) => {
        if (isNodeError(cause) && cause.code === "ENOENT") {
          return ok<Config, ConfigError>(DEFAULT_CONFIG)
        }
        return err<Config, ConfigError>({ kind: "read-failed", cause })
      }),
  )
}

export function saveConfig(paths: JunctionPaths, config: Config): ResultAsync<void, ConfigError> {
  return new ResultAsync(
    (async () => {
      const validation = ConfigSchema.safeParse(config)
      if (!validation.success) {
        return err<void, ConfigError>({ kind: "write-failed", cause: new Error("invalid config") })
      }
      // Lazy-import proper-lockfile to keep module import-light
      const { lock } = await import("proper-lockfile")
      const lockfilePath = path.join(paths.home, ".config.lock")
      let release: (() => Promise<void>) | undefined
      try {
        release = await lock(paths.home, { lockfilePath })
        const tmp = path.join(paths.home, `.config.${Date.now()}.tmp`)
        await writeFile(tmp, JSON.stringify(config, null, 2), "utf-8")
        await rename(tmp, paths.configFile)
        return ok<void, ConfigError>(undefined)
      } catch (cause: unknown) {
        if (isNodeError(cause) && cause.code === "ELOCKED") {
          return err<void, ConfigError>({ kind: "lock-failed", cause })
        }
        return err<void, ConfigError>({ kind: "write-failed", cause })
      } finally {
        if (release) await release().catch(() => {})
      }
    })(),
  )
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}
