// SPDX-License-Identifier: AGPL-3.0-only
// Human-vs-JSON render helpers for CLI output.

import {
  type Config,
  type ConfigError,
  type ConfigState,
  type CredentialError,
  type DbError,
  type JunctionPaths,
  loadConfigState,
  type PathsError,
} from "@junction/core"
import { consola } from "consola"

export type StatusData = {
  home: string
  configFile: string
  cacheDir: string
  initialized: boolean
  config: Config | null
  credentialStore: string
  sandbox: string
}

/**
 * Renders status as an aligned human-readable text block (via consola-friendly string).
 */
export function formatStatusHuman(data: StatusData): string {
  const lines: string[] = [
    `  home             ${data.home}`,
    `  configFile       ${data.configFile}`,
    `  cacheDir         ${data.cacheDir}`,
    `  initialized      ${data.initialized}`,
    `  credential store ${data.credentialStore}`,
    `  sandbox          ${data.sandbox}`,
  ]
  if (data.config !== null) {
    lines.push(`  version          ${data.config.version}`)
  }
  return lines.join("\n")
}

/**
 * Renders status as a pure JSON document (single line, pipeable).
 */
export function formatStatusJson(data: StatusData): string {
  return JSON.stringify({
    home: data.home,
    configFile: data.configFile,
    cacheDir: data.cacheDir,
    initialized: data.initialized,
    config: data.config,
    credentialStore: data.credentialStore,
    sandbox: data.sandbox,
  })
}

/**
 * Renders init result as a pure JSON document.
 */
export function formatInitJson(result: { ok: boolean; home: string; created: boolean }): string {
  return JSON.stringify(result)
}

/**
 * Renders a ConfigError as a human-readable string.
 * Exhaustive — TypeScript narrows e to never after all cases; adding a new
 * error kind to ConfigError becomes a compile error here.
 */
export function formatConfigError(e: ConfigError): string {
  switch (e.kind) {
    case "invalid":
      return `invalid config: ${e.issues.join(", ")}`
    case "lock-failed":
      return `config lock failed: ${String(e.cause)}`
    case "read-failed":
      return `config read failed: ${String(e.cause)}`
    case "write-failed":
      return `config write failed: ${String(e.cause)}`
  }
}

/**
 * Renders a PathsError as a human-readable string.
 */
export function formatPathsError(e: PathsError): string {
  return `failed to resolve home: ${String(e.cause)}`
}

/**
 * Loads config state, rendering the error path uniformly for both commands.
 * On a read/parse failure it emits the JSON error line (or a consola error),
 * sets `process.exitCode = 1`, and returns `null` so the caller can `return`.
 * process.exit is intentionally avoided — it truncates async stdout on a pipe.
 */
export async function loadConfigStateOrFail(
  paths: JunctionPaths,
  json: boolean,
): Promise<ConfigState | null> {
  const stateResult = await loadConfigState(paths)
  if (stateResult.isErr()) {
    const e = stateResult.error
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: formatConfigError(e) })}\n`)
    } else {
      consola.error(`Failed to read config: ${formatConfigError(e)}`)
    }
    process.exitCode = 1
    return null
  }
  return stateResult.value
}

/**
 * Renders a DbError as a human-readable string.
 * Exhaustive — TypeScript narrows e to never after all cases; adding a new
 * error kind to DbError becomes a compile error here (docs/rules/typescript.md).
 */
export function formatDbError(e: DbError): string {
  switch (e.kind) {
    case "not-found":
      return `not found: ${e.entity} ${e.id}`
    case "migration-failed":
      return `database migration failed: ${String(e.cause)}`
    case "constraint-violation":
      return `constraint violation (check that referenced platform/credential/profile exists): ${String(e.cause)}`
    case "duplicate-namespace":
      return `duplicate tool namespace "${e.namespace}" — already used by another source in this profile`
    case "query-failed":
      return `query failed: ${String(e.cause)}`
  }
}

/**
 * Renders a CredentialError as a human-readable string.
 * Exhaustive — all CredentialError kinds handled.
 */
export function formatCredentialError(e: CredentialError): string {
  switch (e.kind) {
    case "store-unavailable":
      return `credential store unavailable: ${String(e.cause)}`
    case "decrypt-failed":
      return `credential decryption failed: ${String(e.cause)}`
    case "key-unavailable":
      return `encryption key unavailable: ${String(e.cause)}`
    case "io-failed":
      return `credential store I/O failed: ${String(e.cause)}`
  }
}

/** Report a DbError: write JSON or log + set exitCode=1. */
export function reportDbError(e: DbError, json: boolean): void {
  const msg = formatDbError(e)
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  } else {
    consola.error(msg)
  }
  process.exitCode = 1
}

/** Report a CredentialError: write JSON or log + set exitCode=1. */
export function reportCredentialError(e: CredentialError, json: boolean): void {
  const msg = formatCredentialError(e)
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  } else {
    consola.error(msg)
  }
  process.exitCode = 1
}

export type { JunctionPaths }
