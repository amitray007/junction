// SPDX-License-Identifier: AGPL-3.0-only
// Sandbox interface, policy types, policy validation, and the createSandbox() factory.

import path from "node:path"
import { err, ok, ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"

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

/** Validate a SandboxPolicy; returns a policy-invalid SandboxError or null. */
export function validatePolicy(policy: SandboxPolicy): SandboxError | null {
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

  for (const p of [...policy.readPaths, ...policy.writePaths]) {
    if (!path.isAbsolute(p)) {
      return { kind: "policy-invalid", reason: `path not absolute: ${p}` }
    }
  }

  if (!path.isAbsolute(policy.cwd)) {
    return { kind: "policy-invalid", reason: `cwd not absolute: ${policy.cwd}` }
  }

  return null
}

let cachedCapabilities: SandboxCapabilities | undefined

export function _resetCapabilitiesCache(): void {
  cachedCapabilities = undefined
}

async function resolveCapabilities(): Promise<SandboxCapabilities> {
  if (cachedCapabilities !== undefined) return cachedCapabilities
  // Dynamic imports break the static import cycle: sandbox ↔ seatbelt/deno.
  const [{ probeCommandBackend }, { probeScriptBackend }] = await Promise.all([
    import("./seatbelt.js"),
    import("./deno.js"),
  ])
  const [command, script] = await Promise.all([probeCommandBackend(), probeScriptBackend()])
  cachedCapabilities = { command, script }
  return cachedCapabilities
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
          const validErr = validatePolicy(policy)
          if (validErr)
            return new ResultAsync(Promise.resolve(err<SandboxResult, SandboxError>(validErr)))

          if (caps.command === "seatbelt") return seatbeltMod.runWithSeatbelt(argv, policy)
          if (caps.command === "bubblewrap") return bwrapMod.runWithBubblewrap(argv, policy)

          return new ResultAsync(
            Promise.resolve(
              err<SandboxResult, SandboxError>({
                kind: "unsupported-platform",
                platform: process.platform,
              }),
            ),
          )
        },

        runScript(script, policy) {
          const validErr = validatePolicy(policy)
          if (validErr)
            return new ResultAsync(Promise.resolve(err<SandboxResult, SandboxError>(validErr)))

          if (caps.script === "deno") return denoMod.runWithDeno(script, policy)

          return new ResultAsync(
            Promise.resolve(
              err<SandboxResult, SandboxError>({ kind: "runtime-unavailable", runtime: "deno" }),
            ),
          )
        },
      }

      return ok<Sandbox, SandboxError>(sandbox)
    }),
  )
}
