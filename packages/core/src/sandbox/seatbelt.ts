// SPDX-License-Identifier: AGPL-3.0-only
// macOS Seatbelt (sandbox-exec) backend.
//
// THE GOTCHA (empirically verified): a naive "deny all reads" profile SIGABRTs every binary
// (exit 134) — dyld + the binary loader need broad file-read* through /. The fix:
//   (allow file-read*)                          <- broad: dyld/binaries can load
//   (deny file-read* (subpath <CREDENTIAL_DIR>) <- explicit confidentiality boundary
//   (allow file-write* (subpath <WORKSPACE>))   <- write only inside workspace
// Never flip to deny-first-then-allow-read — it breaks every binary.
//
// REALPATH GOTCHA (macOS): os.tmpdir() returns /var/folders/... but the kernel sees
// /private/var/folders/... (a symlink). Seatbelt matches on the real path, so all paths
// in the profile must be realpath-resolved before use.

import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { err, ok, ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"
import { isSpawnErr, spawnSandboxed } from "./exec.js"
import { getAlwaysDeniedPaths } from "./policy.js"
import type { SandboxPolicy, SandboxResult } from "./sandbox.js"

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

let commandBackendCache: "seatbelt" | "none" | undefined

export async function probeCommandBackend(): Promise<"seatbelt" | "bubblewrap" | "none"> {
  if (process.platform !== "darwin") return "none"
  if (commandBackendCache !== undefined) return commandBackendCache

  try {
    await access(SANDBOX_EXEC)
    commandBackendCache = "seatbelt"
  } catch {
    commandBackendCache = "none"
  }
  return commandBackendCache
}

async function resolvePaths(paths: readonly string[]): Promise<string[]> {
  return Promise.all(paths.map((p) => realpath(p).catch(() => p)))
}

async function generateProfile(policy: SandboxPolicy): Promise<string> {
  const alwaysDenied = getAlwaysDeniedPaths()
  // Resolve all write paths to real paths (macOS symlink issue).
  const realWritePaths = await resolvePaths(policy.writePaths)

  const denyLines = alwaysDenied.map((p) => `(deny file-read* (subpath "${p}"))`).join("\n")
  const writeLines = realWritePaths.map((p) => `(allow file-write* (subpath "${p}"))`).join("\n")

  const netLines =
    policy.allowNet.length === 0
      ? "(deny network*)"
      : [
          "(deny network*)",
          ...policy.allowNet.map((h) => `(allow network* (remote ip "${h}"))`),
        ].join("\n")

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    netLines,
    denyLines,
    writeLines,
  ]
    .filter(Boolean)
    .join("\n")
}

export function runWithSeatbelt(
  argv: readonly string[],
  policy: SandboxPolicy,
): ResultAsync<SandboxResult, SandboxError> {
  return new ResultAsync(
    (async () => {
      const profile = await generateProfile(policy)
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "jx-sb-"))
      const realTmpDir = await realpath(tmpDir)
      const profilePath = path.join(realTmpDir, "profile.sb")

      try {
        await writeFile(profilePath, profile, { mode: 0o600 })

        const sandboxArgv = [SANDBOX_EXEC, "-f", profilePath, "--", ...argv]
        const result = await spawnSandboxed(sandboxArgv, {
          env: { ...policy.env },
          cwd: policy.cwd,
          timeoutMs: policy.timeoutMs,
          stdin: policy.stdin,
        })

        if (isSpawnErr(result)) return err<SandboxResult, SandboxError>(result._err)
        return ok<SandboxResult, SandboxError>(result)
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    })(),
  )
}
