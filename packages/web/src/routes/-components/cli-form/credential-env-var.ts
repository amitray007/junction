// SPDX-License-Identifier: AGPL-3.0-only
// credentialEnvVar client-side validation — shared by cli-connection-form.tsx
// (declared mode) and full-access-panel.tsx. Lives in its own module so both
// consumers import DOWN into it rather than the panel importing back UP into
// its parent form (which produced a cli-connection-form ↔ full-access-panel
// circular dependency — depcruise no-circular error).
//
// This is a client component path (no .server.ts) so it cannot import
// @junction/core (would pull better-sqlite3/keyring into the client bundle —
// docs/rules/web.md "server-only-core boundary"). The denylist predicate is
// deliberately duplicated here, mirroring sandbox/env-denylist.ts's
// isJunctionReservedEnvKey / isInterpreterDenylistedEnvKey. Keep in lock-step.

const INTERPRETER_ENV_DENYLIST = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "NODE_OPTIONS",
])
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

function isDenylistedCredentialEnvVar(name: string): boolean {
  if (name.startsWith("JUNCTION_")) return true
  const upper = name.toUpperCase()
  return INTERPRETER_ENV_DENYLIST.has(upper) || upper.startsWith("DYLD_")
}

/** Validate a credentialEnvVar value — mirrors CliConnectionSchema's format + denylist. */
export function credentialEnvVarError(name: string): string | undefined {
  if (name === "") return undefined
  if (!ENV_NAME_RE.test(name)) {
    return "Must be a valid env-var name (A-Z, 0-9, _; starts with A-Z or _)"
  }
  if (isDenylistedCredentialEnvVar(name)) {
    return "Reserved name — JUNCTION_-prefixed and dynamic-linker/interpreter names (LD_PRELOAD, DYLD_*, NODE_OPTIONS) are not allowed"
  }
  return undefined
}

// A credential NAME slug — mirrors core's CredentialNameSchema (^[a-z0-9][a-z0-9-]*$).
// Duplicated here (not imported) for the same server-only-core reason as above:
// this is a client component path and must not pull @junction/core into the
// bundle. Keep in lock-step with core/schema/credential.ts CredentialNameSchema.
const CREDENTIAL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Validate the inline "Create new credential" NAME field (full-access panel).
 * Returns an inline field error so an invalid slug is caught BEFORE submit —
 * otherwise addCredentialFn's validator throws a 400 that the panel's outer
 * catch turns into a misleading "install failed" toast even though the platform
 * installed fine (inc 43 web-review should-fix). Empty is not flagged here — the
 * submit path requires a name only when mode === "new" (handled at submit).
 */
export function credentialNameError(name: string): string | undefined {
  if (name === "") return undefined
  if (!CREDENTIAL_NAME_RE.test(name)) {
    return "A lowercase slug — letters, digits, hyphens; must start with a letter or digit (e.g. github-work)"
  }
  return undefined
}
