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
  /**
   * Append-only JSONL audit log (increment 31) — one structured line per
   * `tool_call`. Never a secret/arg-value artifact; safe to keep indefinitely
   * (rotation/retention deferred, see docs/futures/revisit-when.md).
   */
  auditLogFile: string
  /**
   * Junction-private runtime scratch dir (`<home>/run`) for ephemeral,
   * per-call artifacts that must NEVER live in the shared OS tmpdir —
   * e.g. kind "file" credential materialization (increment 28.9 slice D).
   * `os.tmpdir()` is world-writable-parent (`/tmp` on Linux) and same-uid
   * siblings can be granted `readPaths` overlapping it; this dir lives
   * inside `~/.junction` (already 0700) so only an operator grant of the
   * junction home itself — which `grantedPathExposesSecrets` blocks —
   * could expose it. Created lazily at 0700 by `ensureRuntimeDir`.
   */
  runtimeDir: string
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
    auditLogFile: path.join(home, "audit.log"),
    runtimeDir: path.join(home, "run"),
  }
}

/**
 * Path to a cached, dereferenced OpenAPI spec for a platform.
 * Single source of truth for the `<home>/openapi/<id>.json` location — used by
 * `platform add`/`refresh` (write) and the provider builder (read).
 */
export function openapiSpecCacheFile(paths: JunctionPaths, platformId: string): string {
  return path.join(paths.home, "openapi", `${platformId}.json`)
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

/**
 * Lazily create `paths.runtimeDir` at 0700 — idempotent (safe to call before
 * every materialization). `mkdir`'s `mode` option is only honored on initial
 * creation (a no-op if the dir already exists), so an explicit `chmod` after
 * `mkdir` — mirroring `ensureHome` — guarantees 0700 on every call, not just
 * the first. Callers that materialize per-call artifacts under `runtimeDir`
 * (e.g. the CLI source's kind "file" credential mechanics) call this before
 * their own `mkdtemp`.
 */
export function ensureRuntimeDir(paths: JunctionPaths): ResultAsync<string, PathsError> {
  return ResultAsync.fromPromise(
    mkdir(paths.runtimeDir, { recursive: true })
      .then(() => chmod(paths.runtimeDir, 0o700))
      .then(() => paths.runtimeDir),
    (cause) => ({ kind: "home-unresolvable" as const, cause }),
  )
}
