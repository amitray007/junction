// SPDX-License-Identifier: AGPL-3.0-only
// Sandbox interface, policy types, policy validation, and the createSandbox() factory.

import path from "node:path"
import { err, ok, ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"
import { grantedPathExposesSecrets, hasUnsafePathChars, isPathWithin } from "./policy.js"

// Secret key patterns that must never appear in sandbox env.
const SECRET_DENYLIST_EXACT = new Set(["JUNCTION_MASTER_KEY", "JUNCTION_MASTER_KEY_FILE"])
const SECRET_DENYLIST_RE = [/_TOKEN$/, /_SECRET$/, /_KEY$/]

export interface SandboxPolicy {
  /** Absolute paths the child may read. */
  readPaths: readonly string[]
  /** Absolute paths the child may write (implies read). */
  writePaths: readonly string[]
  /** host[:port] allowlist; [] = network fully denied. */
  allowNet: readonly string[]
  /** EXPLICIT env allowlist — NEVER inherit process.env. */
  env: Readonly<Record<string, string>>
  /** Absolute path; must be within readPaths or writePaths. */
  cwd: string
  /** Hard SIGKILL ceiling in ms. */
  timeoutMs: number
  stdin?: string
}

export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /**
   * True when the combined stdout+stderr exceeded the output byte cap and the
   * child was SIGKILLed before it finished. The returned stdout/stderr are
   * truncated to whatever was collected before the cap was hit.
   * Added in inc 21 (exec.ts OOM hardening).
   */
  outputCapped?: boolean
}

export type SandboxCapabilities = {
  command: "seatbelt" | "bubblewrap" | "none"
  script: "deno" | "none"
}

export interface Sandbox {
  runCommand(
    argv: readonly string[],
    policy: SandboxPolicy,
  ): ResultAsync<SandboxResult, SandboxError>
  runScript(
    script: { file: string } | { code: string },
    policy: SandboxPolicy,
  ): ResultAsync<SandboxResult, SandboxError>
  capabilities(): SandboxCapabilities
}

/**
 * Strict allowNet entry shape: host[:port] where
 *   host ∈ { valid hostname/IPv4 chars [A-Za-z0-9._-]+, or "*", or "" }
 *   port (if present) ∈ numeric string or "*"
 * Returns null if valid, or an error reason string if not.
 */
function validateAllowNetEntry(entry: string): string | null {
  // Reject metachars that could widen Deno argv or SBPL. Use charCodeAt for control
  // chars (NUL=0, LF=10, CR=13) to avoid Biome noControlCharactersInRegex.
  if (/[",()'\s]/.test(entry)) {
    return `allowNet entry "${entry}" contains unsafe characters`
  }
  for (let i = 0; i < entry.length; i++) {
    const c = entry.charCodeAt(i)
    if (c === 0 || c === 10 || c === 13) {
      return `allowNet entry contains unsafe control characters`
    }
  }
  const colonIdx = entry.lastIndexOf(":")
  if (colonIdx === -1) {
    // Bare entry — treated as port-only (e.g. "443") or host-only.
    // Only "*" is a valid bare host; numeric bare values are port-only.
    const isPortOnly = /^\d+$/.test(entry)
    const isWildcard = entry === "*"
    if (!isPortOnly && !isWildcard) {
      // Bare hostname — reject (not a safe allowNet shape).
      return `allowNet entry "${entry}" is a bare hostname without port; use "*:port" for port-scoped allows`
    }
    return null
  }
  const host = entry.slice(0, colonIdx)
  const port = entry.slice(colonIdx + 1)
  // Host must be empty, "*", or valid hostname/IPv4 chars only.
  if (host !== "" && host !== "*" && !/^[A-Za-z0-9._-]+$/.test(host)) {
    return `allowNet entry "${entry}" has invalid host portion "${host}"`
  }
  // Port must be numeric or "*".
  if (port !== "*" && !/^\d+$/.test(port)) {
    return `allowNet entry "${entry}" has invalid port portion "${port}"`
  }
  return null
}

/** Validate a SandboxPolicy; returns a policy-invalid SandboxError or null. */
export async function validatePolicy(policy: SandboxPolicy): Promise<SandboxError | null> {
  for (const key of Object.keys(policy.env)) {
    if (SECRET_DENYLIST_EXACT.has(key)) {
      return { kind: "policy-invalid", reason: `env key "${key}" matches secret denylist` }
    }
    for (const re of SECRET_DENYLIST_RE) {
      if (re.test(key)) {
        return { kind: "policy-invalid", reason: `env key "${key}" matches secret denylist` }
      }
    }
  }

  const grantedPaths = [...policy.readPaths, ...policy.writePaths]
  for (const p of grantedPaths) {
    if (!path.isAbsolute(p)) {
      return { kind: "policy-invalid", reason: `path not absolute: ${p}` }
    }
    // Reject SBPL/argv metachar injection in paths (FIX 1).
    if (hasUnsafePathChars(p)) {
      return {
        kind: "policy-invalid",
        reason: `path contains unsafe characters (SBPL/argv injection risk): ${p}`,
      }
    }
  }

  if (!path.isAbsolute(policy.cwd)) {
    return { kind: "policy-invalid", reason: `cwd not absolute: ${policy.cwd}` }
  }
  // Reject SBPL/argv metachar injection in cwd (FIX 1).
  if (hasUnsafePathChars(policy.cwd)) {
    return {
      kind: "policy-invalid",
      reason: `cwd contains unsafe characters (SBPL/argv injection risk): ${policy.cwd}`,
    }
  }

  // cwd must live within a granted read/write path (documented invariant).
  if (!grantedPaths.some((p) => isPathWithin(policy.cwd, p))) {
    return { kind: "policy-invalid", reason: `cwd not within any read/write path: ${policy.cwd}` }
  }

  // Central allowNet validation (FIX 2): strict shape check before any backend sees it.
  for (const entry of policy.allowNet) {
    const netErr = validateAllowNetEntry(entry)
    if (netErr) {
      return { kind: "policy-invalid", reason: netErr }
    }
  }

  // Structural defense (protects BOTH backends): refuse if a granted path is an
  // ancestor of a credential/secret dir — that would pull secrets into the sandbox.
  // bwrap has no deny primitive, so this containment check is its only guard.
  // Both sides realpath-resolved (FIX 3) so symlinked paths into the secret tree are caught.
  const exposure = await grantedPathExposesSecrets(grantedPaths)
  if (exposure.exposed) {
    return {
      kind: "policy-invalid",
      reason: `granted path "${exposure.grantedPath}" exposes secret path "${exposure.secretPath}"`,
    }
  }

  return null
}

let cachedCapabilities: SandboxCapabilities | undefined

export function _resetCapabilitiesCache(): void {
  cachedCapabilities = undefined
}

async function resolveCapabilities(): Promise<SandboxCapabilities> {
  if (cachedCapabilities !== undefined) return cachedCapabilities
  // Dynamic imports break the static import cycle: sandbox ↔ seatbelt/bubblewrap/deno.
  // Probe the platform-appropriate command backend:
  //   - macOS:  seatbelt (sandbox-exec at /usr/bin/sandbox-exec)
  //   - Linux:  bubblewrap (bwrap, resolved to absolute path at probe time)
  //   - other:  "none"
  const [
    { probeCommandBackend: probeSeatbelt },
    { probeCommandBackend: probeBwrap },
    { probeScriptBackend },
  ] = await Promise.all([import("./seatbelt.js"), import("./bubblewrap.js"), import("./deno.js")])
  const [seatbeltResult, bwrapResult, script] = await Promise.all([
    probeSeatbelt(),
    probeBwrap(),
    probeScriptBackend(),
  ])
  // Prefer seatbelt on darwin (it returns "seatbelt" there and "none" elsewhere);
  // fall back to bwrap on Linux (it returns "bubblewrap" or "none").
  const command: SandboxCapabilities["command"] =
    seatbeltResult !== "none" ? seatbeltResult : bwrapResult !== "none" ? bwrapResult : "none"
  cachedCapabilities = { command, script }
  return cachedCapabilities
}

/** A pre-resolved Err result — the sandbox refuses without spawning. */
function refuse(e: SandboxError): ResultAsync<SandboxResult, SandboxError> {
  return new ResultAsync(Promise.resolve(err<SandboxResult, SandboxError>(e)))
}

export function createSandbox(): ResultAsync<Sandbox, SandboxError> {
  return new ResultAsync(
    resolveCapabilities().then(async (caps) => {
      const [seatbeltMod, bwrapMod, denoMod] = await Promise.all([
        import("./seatbelt.js"),
        import("./bubblewrap.js"),
        import("./deno.js"),
      ])

      const sandbox: Sandbox = {
        capabilities: () => caps,

        runCommand(argv, policy) {
          return ResultAsync.fromPromise(validatePolicy(policy), (e) => e as SandboxError).andThen(
            (validErr) => {
              if (validErr) return refuse(validErr)
              if (caps.command === "seatbelt") return seatbeltMod.runWithSeatbelt(argv, policy)
              if (caps.command === "bubblewrap") return bwrapMod.runWithBubblewrap(argv, policy)
              return refuse({ kind: "unsupported-platform", platform: process.platform })
            },
          )
        },

        runScript(script, policy) {
          return ResultAsync.fromPromise(validatePolicy(policy), (e) => e as SandboxError).andThen(
            (validErr) => {
              if (validErr) return refuse(validErr)
              if (caps.script === "deno") return denoMod.runWithDeno(script, policy)
              return refuse({ kind: "runtime-unavailable", runtime: "deno" })
            },
          )
        },
      }

      return ok<Sandbox, SandboxError>(sandbox)
    }),
  )
}
