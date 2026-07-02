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

export type StatusCounts = {
  platforms: number
  credentials: number
  profiles: number
}

export type StatusData = {
  home: string
  configFile: string
  cacheDir: string
  initialized: boolean
  config: Config | null
  credentialStore: string
  sandbox: string
  counts?: StatusCounts
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
  if (data.counts !== undefined) {
    const { platforms, credentials, profiles } = data.counts
    lines.push(
      `  sources          ${platforms} platform${platforms !== 1 ? "s" : ""} · ${credentials} credential${credentials !== 1 ? "s" : ""} · ${profiles} profile${profiles !== 1 ? "s" : ""}`,
    )
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
    ...(data.counts !== undefined ? { counts: data.counts } : {}),
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
    case "in-use":
      return `resource is in use by one or more sources — remove those sources first`
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
    case "invalid-input":
      return `invalid input: ${e.reason}`
  }
}

/**
 * Report an in-use error with a caller-supplied message (entity-specific wording).
 * Extracted from the remove-credential / remove-platform pair to share the
 * json / human branching + exitCode without duplicating the structure.
 */
/**
 * Report an error message in the appropriate format and set exitCode=1.
 * The shared primitive behind every command's json/human error branch —
 * `if (json) write {ok:false,error} else consola.error; exitCode=1`.
 */
export function reportError(json: boolean, msg: string): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  else consola.error(msg)
  process.exitCode = 1
}

/** @deprecated name — a thin alias of reportError; kept for existing call sites. */
export function reportInUseError(json: boolean, msg: string): void {
  reportError(json, msg)
}

/**
 * Write a successful removal result in the appropriate format.
 * Extracted from remove-credential / remove-platform to share the
 * json/human branching without duplicating the ok:true + consola pattern.
 * @param label - Entity label for the human message (e.g. "Credential", "Platform").
 */
export function reportIdRemoved(json: boolean, id: string, label: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, id })}\n`)
  } else {
    consola.success(`${label} "${id}" removed`)
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
