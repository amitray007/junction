// SPDX-License-Identifier: AGPL-3.0-only
// Config load/save with Zod validation and atomic locked writes.
//
// Locking strategy: we lock the HOME DIRECTORY (not config.json) with a
// custom lockfilePath so the lock target always exists (ensureHome guarantees
// it). Locking config.json directly would fail on first write because
// proper-lockfile's realpath:true (the default) requires the locked file to
// exist — which it doesn't before the first saveConfig.

import { randomUUID } from "node:crypto"
import { readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import { z } from "zod"
import type { ConfigError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"

export const ConfigSchema = z.object({ version: z.literal(1) })

export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: Config = { version: 1 }

/** Internal: parse raw JSON string into a validated Config. Not exported. */
function parseConfigRaw(raw: string): Result<Config, ConfigError> {
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
}

export function loadConfig(paths: JunctionPaths): ResultAsync<Config, ConfigError> {
  return new ResultAsync(
    readFile(paths.configFile, "utf-8")
      .then((raw) => parseConfigRaw(raw))
      .catch((cause: unknown) => {
        if (isNodeError(cause) && cause.code === "ENOENT") {
          return ok<Config, ConfigError>(DEFAULT_CONFIG)
        }
        return err<Config, ConfigError>({ kind: "read-failed", cause })
      }),
  )
}

export type ConfigState = { initialized: false } | { initialized: true; config: Config }

export function loadConfigState(paths: JunctionPaths): ResultAsync<ConfigState, ConfigError> {
  return new ResultAsync(
    readFile(paths.configFile, "utf-8")
      .then((raw) => {
        const parsed = parseConfigRaw(raw)
        if (parsed.isErr()) return err<ConfigState, ConfigError>(parsed.error)
        return ok<ConfigState, ConfigError>({ initialized: true, config: parsed.value })
      })
      .catch((cause: unknown) => {
        if (isNodeError(cause) && cause.code === "ENOENT") {
          return ok<ConfigState, ConfigError>({ initialized: false })
        }
        return err<ConfigState, ConfigError>({ kind: "read-failed", cause })
      }),
  )
}

export function saveConfig(paths: JunctionPaths, config: Config): ResultAsync<void, ConfigError> {
  return new ResultAsync(
    (async () => {
      const validation = ConfigSchema.safeParse(config)
      if (!validation.success) {
        return err<void, ConfigError>({
          kind: "invalid",
          issues: validation.error.issues.map((i) => i.message),
        })
      }
      // Lazy-import proper-lockfile to keep module import-light
      const { lock } = await import("proper-lockfile")
      const lockfilePath = path.join(paths.home, ".config.lock")
      let release: (() => Promise<void>) | undefined
      // Unique temp name: Date.now() collides under same-millisecond concurrency,
      // which would race two renames onto config.json. randomUUID is collision-free.
      const tmp = path.join(paths.home, `.config.${randomUUID()}.tmp`)
      try {
        release = await lock(paths.home, { lockfilePath })
        await writeFile(tmp, JSON.stringify(config, null, 2), "utf-8")
        await rename(tmp, paths.configFile)
        return ok<void, ConfigError>(undefined)
      } catch (cause: unknown) {
        // Best-effort cleanup: a failed rename leaves the temp file behind.
        await unlink(tmp).catch(() => {})
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
