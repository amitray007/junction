// SPDX-License-Identifier: AGPL-3.0-only

import { chmod, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import envPaths from "env-paths"
import { ResultAsync } from "neverthrow"
import type { PathsError } from "../errors/index.js"

export type JunctionPaths = {
  home: string
  configFile: string
  cacheDir: string
  dbFile: string
  credentialsFile: string
  masterKeyFile: string
}

export function resolveHome(): string {
  const override = process.env.JUNCTION_HOME?.trim()
  if (override) return path.resolve(override)
  return path.join(os.homedir(), ".junction")
}

export function getPaths(): JunctionPaths {
  const home = resolveHome()
  return {
    home,
    configFile: path.join(home, "config.json"),
    cacheDir: envPaths("junction").cache,
    dbFile: path.join(home, "junction.db"),
    credentialsFile: path.join(home, "credentials.enc.json"),
    masterKeyFile: path.join(home, "master.key"),
  }
}

export function ensureHome(): ResultAsync<JunctionPaths, PathsError> {
  const home = resolveHome()
  return ResultAsync.fromPromise(
    mkdir(home, { recursive: true })
      .then(() => chmod(home, 0o700))
      .then(() => getPaths()),
    (cause) => ({ kind: "home-unresolvable" as const, cause }),
  )
}
