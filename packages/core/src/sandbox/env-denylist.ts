// SPDX-License-Identifier: AGPL-3.0-only
// Shared dynamic-linker/interpreter env-var denylist — the ONE class of env
// key name that is dangerous regardless of which surface injects it (a
// sandboxed CLI child via validatePolicy, or the UNSANDBOXED stdio-MCP child
// via McpConnectionSchema's stdio env refine). Hoisted here (inc 41 Fable
// ruling) so both consumers share one list instead of two copies that could
// drift.
//
// Lives in sandbox/ (not schema/) so sandbox.ts can import it without
// crossing the core dependency direction (sandbox/ must NOT import from
// schema/; schema/ already imports FROM sandbox/, e.g. hasUnsafePathChars —
// this file preserves that one-way edge).

/**
 * Env-var names that hijack the dynamic linker or an interpreter runtime —
 * LD_PRELOAD-class code injection. Checked case-insensitively by callers;
 * DYLD_* is matched by prefix separately (see isInterpreterDenylistedEnvKey).
 */
export const INTERPRETER_ENV_DENYLIST = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "NODE_OPTIONS",
])

/**
 * True if `key` matches the dynamic-linker/interpreter denylist class —
 * either an exact name in INTERPRETER_ENV_DENYLIST or a DYLD_* prefix.
 * Case-insensitive (the class of attack does not care about env-var casing
 * on case-sensitive platforms).
 */
export function isInterpreterDenylistedEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return INTERPRETER_ENV_DENYLIST.has(upper) || upper.startsWith("DYLD_")
}

/**
 * Junction's own reserved env-var namespace. Any JUNCTION_-prefixed name is
 * reserved for junction internals (JUNCTION_MASTER_KEY, JUNCTION_MASTER_KEY_FILE,
 * JUNCTION_HOME, and any future JUNCTION_* var) — no third-party CLI or MCP
 * server legitimately needs a JUNCTION_-prefixed credential/config env var.
 */
export function isJunctionReservedEnvKey(key: string): boolean {
  return key.startsWith("JUNCTION_")
}
