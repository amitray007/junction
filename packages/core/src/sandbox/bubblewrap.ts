// SPDX-License-Identifier: AGPL-3.0-only
// Linux bubblewrap (bwrap) backend.
// Network OFF = --unshare-all (do NOT add --share-net).
// --clearenv + per-key --setenv for explicit env allowlist.
// Probe userns at runtime; if it fails → "none" (refuse, not raw exec).

import type { ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"
import { isSpawnErr, runSandboxed, spawnSandboxed } from "./exec.js"
import type { SandboxPolicy, SandboxResult } from "./sandbox.js"

const BWRAP = "bwrap"

let commandBackendCache: "bubblewrap" | "none" | undefined

async function probeUserns(): Promise<boolean> {
  // Probe must exec a binary that exists under a BOUND path. On merged-usr
  // distros (Ubuntu noble) /bin is a symlink to /usr/bin, so binding only /usr
  // and exec'ing "/bin/true" fails with "No such file or directory" even though
  // the user namespace itself was created fine — a false negative. Use the real
  // /usr/bin/true and also bind /bin so the merged-usr symlink resolves.
  const result = await spawnSandboxed(
    [BWRAP, "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/bin", "/bin", "--", "/usr/bin/true"],
    { env: {}, cwd: "/", timeoutMs: 5000 },
  )
  return !isSpawnErr(result) && result.exitCode === 0
}

export async function probeCommandBackend(): Promise<"bubblewrap" | "none"> {
  if (process.platform !== "linux") return "none"
  if (commandBackendCache !== undefined) return commandBackendCache

  const ok_ = await probeUserns().catch(() => false)
  commandBackendCache = ok_ ? "bubblewrap" : "none"
  return commandBackendCache
}

function buildBwrapArgv(argv: readonly string[], policy: SandboxPolicy): string[] {
  const args: string[] = [
    BWRAP,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
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

  // Explicit env via --setenv.
  args.push("--setenv", "PATH", "/usr/bin:/bin")
  for (const [k, v] of Object.entries(policy.env)) {
    args.push("--setenv", k, v)
  }

  // Network: --unshare-all already covers net; no --share-net added.

  args.push("--", ...argv)
  return args
}

export function runWithBubblewrap(
  argv: readonly string[],
  policy: SandboxPolicy,
): ResultAsync<SandboxResult, SandboxError> {
  // env is {} — bwrap re-injects the allowlist via --clearenv + --setenv.
  return runSandboxed(buildBwrapArgv(argv, policy), policy, {})
}
