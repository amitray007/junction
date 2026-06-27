// SPDX-License-Identifier: AGPL-3.0-only
// Linux bubblewrap (bwrap) backend.
// Network OFF = --unshare-all (do NOT add --share-net).
// --clearenv + per-key --setenv for explicit env allowlist.
// Probe userns at runtime; if it fails → "none" (refuse, not raw exec).
//
// The bwrap binary is resolved to an ABSOLUTE path at probe time (via `which`)
// so that spawning with an explicit scrubbed env (no PATH) still works. This
// mirrors how deno.ts resolves denoBinPath. Child env isolation is unaffected —
// bwrap's own --clearenv + --setenv controls the sandboxed child; we only need
// the absolute path so the HOST process can find and exec the bwrap wrapper.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"
import { isSpawnErr, runSandboxed, spawnSandboxed } from "./exec.js"
import type { SandboxPolicy, SandboxResult } from "./sandbox.js"

const execFileAsync = promisify(execFile)

let commandBackendCache: "bubblewrap" | "none" | undefined
/** Absolute path to the bwrap binary, resolved once at probe time. */
let bwrapBinPath: string | undefined

async function probeUserns(): Promise<boolean> {
  // Probe must exec a binary that exists under a BOUND path. On merged-usr
  // distros (Ubuntu noble) /bin is a symlink to /usr/bin, so binding only /usr
  // and exec'ing "/bin/true" fails with "No such file or directory" even though
  // the user namespace itself was created fine — a false negative. Bind the same
  // minimal system paths the real sandbox does (/usr, /bin, and the /lib + /lib64
  // loader paths) so the dynamically-linked /usr/bin/true can find its loader —
  // otherwise exec fails with ENOENT ("No such file or directory") even though
  // userns works. Must mirror buildBwrapArgv's system bindings.
  //
  // Use the resolved absolute bwrapBinPath so Node can spawn the binary even when
  // the child env has no PATH. bwrapBinPath is set by probeCommandBackend before
  // calling this function.
  const bwrap = bwrapBinPath
  if (!bwrap) return false
  const result = await spawnSandboxed(
    [
      bwrap,
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--",
      "/usr/bin/true",
    ],
    { env: {}, cwd: "/", timeoutMs: 5000 },
  )
  return !isSpawnErr(result) && result.exitCode === 0
}

export async function probeCommandBackend(): Promise<"bubblewrap" | "none"> {
  if (process.platform !== "linux") return "none"
  if (commandBackendCache !== undefined) return commandBackendCache

  try {
    // Resolve the full binary path using the HOST process.env PATH (same pattern
    // as deno.ts's probeScriptBackend). We then use the absolute path for all
    // subsequent spawns so the child env (env: {}) never needs a PATH variable.
    const { stdout: whichOut } = await execFileAsync("which", ["bwrap"], { timeout: 5000 })
    const binPath = whichOut.trim()
    if (!binPath) {
      commandBackendCache = "none"
      return commandBackendCache
    }
    bwrapBinPath = binPath
  } catch {
    commandBackendCache = "none"
    return commandBackendCache
  }

  const ok_ = await probeUserns().catch(() => false)
  commandBackendCache = ok_ ? "bubblewrap" : "none"
  return commandBackendCache
}

export function buildBwrapArgv(argv: readonly string[], policy: SandboxPolicy): string[] {
  // bwrapBinPath is always set by probeCommandBackend before runWithBubblewrap is
  // ever reachable — probeCommandBackend sets it or returns "none" (which blocks
  // the bubblewrap code path entirely). The fallback to "bwrap" is unreachable in
  // normal operation but satisfies TypeScript's type checker.
  const bwrap = bwrapBinPath ?? "bwrap"
  const args: string[] = [
    bwrap,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    // NOTE: no --clearenv. The child env is controlled by the explicit `env:` we
    // pass to spawn() in runWithBubblewrap (Node's `env` REPLACES the environment —
    // no process.env inheritance), so bwrap forwards exactly that scrubbed allowlist.
    // We deliberately do NOT use `--setenv KEY VALUE`, which would place the
    // credential VALUE in bwrap's argv → readable via /proc/<pid>/cmdline and `ps`.
    // Minimal system bindings so binaries can load.
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ]

  for (const p of policy.readPaths) {
    args.push("--ro-bind", p, p)
  }
  for (const p of policy.writePaths) {
    args.push("--bind", p, p)
  }

  args.push("--chdir", policy.cwd)

  // Env is forwarded via the spawn `env:` allowlist (see runWithBubblewrap) — NOT
  // via --setenv, so no value (incl. a credential) lands in argv. PATH is non-secret
  // and supplied through the same env map.

  // Network: --unshare-all already covers net; no --share-net added.

  args.push("--", ...argv)
  return args
}

/** Env the bwrap child receives — the policy allowlist plus a non-secret PATH. */
export function buildBwrapEnv(policy: SandboxPolicy): Record<string, string> {
  return { PATH: "/usr/bin:/bin", ...policy.env }
}

export function runWithBubblewrap(
  argv: readonly string[],
  policy: SandboxPolicy,
): ResultAsync<SandboxResult, SandboxError> {
  // Spawn bwrap with an EXPLICIT env (Node replaces, never inherits process.env);
  // with no --clearenv, bwrap forwards exactly this scrubbed allowlist to the child.
  // Credential values reach the child via the environment, never via argv.
  return runSandboxed(buildBwrapArgv(argv, policy), policy, buildBwrapEnv(policy))
}
