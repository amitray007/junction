// SPDX-License-Identifier: AGPL-3.0-only
// Human-vs-JSON render helpers for CLI output.

import type { Config, ConfigError, JunctionPaths, PathsError } from "@junction/core"

export type StatusData = {
  home: string
  configFile: string
  cacheDir: string
  initialized: boolean
  config: Config | null
}

/**
 * Renders status as an aligned human-readable text block (via consola-friendly string).
 */
export function formatStatusHuman(data: StatusData): string {
  const lines: string[] = [
    `  home        ${data.home}`,
    `  configFile  ${data.configFile}`,
    `  cacheDir    ${data.cacheDir}`,
    `  initialized ${data.initialized}`,
  ]
  if (data.config !== null) {
    lines.push(`  version     ${data.config.version}`)
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
  if (e.kind === "invalid") return `invalid config: ${e.issues.join(", ")}`
  if (e.kind === "lock-failed") return `config lock failed: ${String(e.cause)}`
  if (e.kind === "read-failed") return `config read failed: ${String(e.cause)}`
  if (e.kind === "write-failed") return `config write failed: ${String(e.cause)}`
  const _exhaustive: never = e
  return String(_exhaustive)
}

/**
 * Renders a PathsError as a human-readable string.
 */
export function formatPathsError(e: PathsError): string {
  return `failed to resolve home: ${String(e.cause)}`
}

export type { JunctionPaths }
