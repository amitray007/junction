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
import { err, errAsync, ok, type Result, ResultAsync } from "neverthrow"
import { z } from "zod"
import type { ConfigError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"

export const ConfigSchema = z.object({
  version: z.literal(1),
  // mcpHost is optional — old {version:1} configs still parse (Zod strips unknown
  // keys by default; adding an optional field is backward-compatible; no version bump).
  mcpHost: z.string().optional(),
  // mcpPort is optional (increment 27) — same backward-compatible pattern as
  // mcpHost: old configs without it still parse; no version bump required.
  mcpPort: z.number().int().min(1).max(65535).optional(),
})

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

// ---------------------------------------------------------------------------
// MCP host resolver, validator, and setter
// ---------------------------------------------------------------------------

/**
 * Resolve the MCP host for this Junction instance.
 *
 * Precedence (first wins):
 *   1. `config.mcpHost` — an explicit value the user saved via `setMcpHost`.
 *   2. `JUNCTION_MCP_HOST` env var — a deployment-level override without editing config.
 *   3. `undefined` — no host configured; Connect-an-Agent shows the placeholder.
 *
 * Config overrides env so that a user who saves a host in Settings can always
 * override an operator-provided environment default.
 */
export function getMcpHost(paths: JunctionPaths): ResultAsync<string | undefined, ConfigError> {
  // Treat an empty/whitespace mcpHost as absent — fall through to env var.
  // This prevents `{version:1, mcpHost:""}` (a valid parse per the schema) from
  // short-circuiting the JUNCTION_MCP_HOST env fallback via the `??` operator.
  return loadConfig(paths).map((c) => {
    const stored = c.mcpHost?.trim()
    return stored !== undefined && stored !== ""
      ? stored
      : (process.env.JUNCTION_MCP_HOST ?? undefined)
  })
}

/**
 * Validate an MCP host string.
 *
 * Rules (permissive — rejects obvious garbage, not a strict RFC parser):
 *   - Must be non-empty after trimming.
 *   - Must not contain whitespace, control characters, or a scheme (`://`).
 *   - Allows: `hostname`, `hostname:port`, dotted names, `localhost`, IPv4.
 *   - Allows bracketed IPv6: `[::1]`, `[::1]:8080`, `[2001:db8::1]:443`.
 *   - Rejects bare (unbracketed) IPv6 like `::1` — ambiguous with host:port.
 *   - Port (if present) must be digits only.
 *
 * Does NOT require `https://` — the caller supplies the scheme when building the URL.
 * Does NOT fully RFC-validate the IPv6 literal — bracket presence + optional digit port
 * is sufficient for the self-hosted use case.
 */
export function isValidMcpHost(host: string): boolean {
  const trimmed = host.trim()
  if (trimmed.length === 0) return false
  // Reject whitespace anywhere (spaces, tabs, newlines).
  if (/\s/.test(trimmed)) return false
  // Reject control characters (U+0000–U+001F, U+007F) via char-code scan — avoids a
  // control-char regex, which Biome's noControlCharactersInRegex auto-fix mangles.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return false
  }
  // Reject anything that already contains a scheme (user confusion guard).
  if (trimmed.includes("://")) return false

  // Bracketed IPv6: `[<literal>]` or `[<literal>]:<port>`
  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]")
    if (closingBracket === -1) return false // unclosed bracket
    const afterBracket = trimmed.slice(closingBracket + 1)
    // Nothing after bracket → bare `[::1]` is valid.
    if (afterBracket === "") return true
    // `:port` after bracket → port must be digits only.
    if (afterBracket.startsWith(":")) {
      const port = afterBracket.slice(1)
      return /^\d+$/.test(port)
    }
    return false // unexpected suffix after `]`
  }

  // Non-bracketed: `hostname` or `hostname:port`.
  // Must be at least one non-colon character (not just ":8080").
  const colonIdx = trimmed.indexOf(":")
  const hostname = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx)
  if (hostname.length === 0) return false
  // Port, if present, must be digits only.
  if (colonIdx !== -1) {
    const port = trimmed.slice(colonIdx + 1)
    if (!/^\d+$/.test(port)) return false
  }
  return true
}

/**
 * Persist `mcpHost` into the config (load → merge → save, locked + atomic).
 *
 * - Pass a non-empty string to set the host.
 * - Pass `undefined` or `""` to clear it (the key is REMOVED from the saved JSON
 *   so the file stays clean; storing `undefined`/`""` is avoided).
 * - Rejects invalid host strings with `{ kind: "invalid" }` before any I/O.
 */
export function setMcpHost(
  paths: JunctionPaths,
  host: string | undefined,
): ResultAsync<void, ConfigError> {
  // Treat empty-string as "clear".
  const trimmed = typeof host === "string" ? host.trim() : undefined
  const clearing = trimmed === undefined || trimmed === ""

  if (!clearing && !isValidMcpHost(trimmed as string)) {
    // errAsync propagates the error through the ResultAsync — NOT
    // fromSafePromise(Promise.resolve(err(...))), which wraps the err Result as
    // an OK *value* (isOk() === true), silently passing invalid hosts.
    return errAsync<void, ConfigError>({
      kind: "invalid",
      issues: [`"${trimmed}" is not a valid host (hostname or hostname:port expected)`],
    })
  }

  return loadConfig(paths).andThen((current) => {
    // Build the merged config. When clearing, drop ONLY mcpHost (via destructure)
    // so any other future config keys survive — don't reconstruct from version alone.
    const { mcpHost: _omitted, ...rest } = current
    const updated: Config = clearing ? rest : { ...current, mcpHost: trimmed as string }
    return saveConfig(paths, updated)
  })
}

// ---------------------------------------------------------------------------
// MCP port resolver, validator, and setter (increment 27)
// ---------------------------------------------------------------------------

/** Default port for `junction serve`'s HTTP MCP endpoint. Web is 4321 — adjacent, memorable. */
export const DEFAULT_MCP_PORT = 4322

/**
 * Resolve the MCP port for this junction instance.
 *
 * Precedence (first wins; the `--port` CLI flag sits ABOVE this, in the cli layer):
 *   1. `config.mcpPort` — an explicit value the user saved via `setMcpPort`.
 *   2. `JUNCTION_MCP_PORT` env var — a deployment-level override without editing config.
 *   3. `4322` (DEFAULT_MCP_PORT).
 *
 * Config overrides env, mirroring `getMcpHost`.
 */
export function getMcpPort(paths: JunctionPaths): ResultAsync<number, ConfigError> {
  return loadConfig(paths).map((c) => {
    if (c.mcpPort !== undefined) return c.mcpPort
    const envPort = process.env.JUNCTION_MCP_PORT?.trim()
    if (envPort !== undefined && envPort !== "" && isValidMcpPort(Number(envPort))) {
      return Number(envPort)
    }
    return DEFAULT_MCP_PORT
  })
}

/** Validate an MCP port number: integer in [1, 65535]. */
export function isValidMcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * Persist `mcpPort` into the config (load → merge → save, locked + atomic).
 *
 * - Pass a valid port number (1–65535) to set it.
 * - Pass `undefined` to clear it (the key is REMOVED from the saved JSON so
 *   the file stays clean).
 * - Rejects invalid port numbers with `{ kind: "invalid" }` before any I/O.
 */
export function setMcpPort(
  paths: JunctionPaths,
  port: number | undefined,
): ResultAsync<void, ConfigError> {
  const clearing = port === undefined

  if (!clearing && !isValidMcpPort(port)) {
    return errAsync<void, ConfigError>({
      kind: "invalid",
      issues: [`"${port}" is not a valid port (expected an integer 1-65535)`],
    })
  }

  return loadConfig(paths).andThen((current) => {
    // Build the merged config. When clearing, drop ONLY mcpPort (via destructure)
    // so any other future config keys survive — don't reconstruct from version alone.
    const { mcpPort: _omitted, ...rest } = current
    const updated: Config = clearing ? rest : { ...current, mcpPort: port }
    return saveConfig(paths, updated)
  })
}
