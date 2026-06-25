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

/**
 * Realpath each path, falling back to (realpath(parent) + leaf) when the path
 * itself does not exist yet (so a not-yet-created credential file under a
 * symlinked prefix is still resolved to its real location), then to the literal.
 */
async function resolvePathsRobust(paths: readonly string[]): Promise<string[]> {
  return Promise.all(
    paths.map(async (p) => {
      try {
        return await realpath(p)
      } catch {
        try {
          const real = await realpath(path.dirname(p))
          return path.join(real, path.basename(p))
        } catch {
          return p
        }
      }
    }),
  )
}

/**
 * Seatbelt cannot enforce per-host egress. Reject any allowNet entry whose host
 * portion is not `*`/empty → policy-invalid (fail closed). Port-only ("*:443",
 * "443") is accepted; the profile widens it to "*:port".
 */
function validateSeatbeltNet(policy: SandboxPolicy): SandboxError | null {
  for (const entry of policy.allowNet) {
    const host = entry.includes(":") ? entry.slice(0, entry.lastIndexOf(":")) : ""
    if (host !== "" && host !== "*") {
      return {
        kind: "policy-invalid",
        reason: `seatbelt cannot scope egress to host "${host}" — use a Deno-tier backend for per-host allowlisting, or pass a port-only entry ("*:${entry.slice(entry.lastIndexOf(":") + 1)}")`,
      }
    }
  }
  return null
}

async function generateProfile(policy: SandboxPolicy): Promise<string> {
  const alwaysDenied = getAlwaysDeniedPaths()
  // Resolve all write paths to real paths (macOS symlink issue).
  const realWritePaths = await resolvePaths(policy.writePaths)

  // CONFIDENTIALITY BOUNDARY — must cover BOTH the logical path and its realpath.
  // The kernel matches deny-subpath on the REAL path; if JUNCTION_HOME is under a
  // symlinked prefix (e.g. /tmp → /private/tmp on macOS), a logical-only deny line
  // is silently bypassed by reading the file via its real path. Emit both, deduped.
  // (resolvePaths falls back to the logical path when realpath fails, e.g. the file
  //  does not exist yet — so the deny line still appears.)
  const realDenied = await resolvePathsRobust(alwaysDenied)
  const deniedPaths = [...new Set([...alwaysDenied, ...realDenied])]
  const denyLines = deniedPaths.map((p) => `(deny file-read* (subpath "${p}"))`).join("\n")
  const writeLines = realWritePaths.map((p) => `(allow file-write* (subpath "${p}"))`).join("\n")

  // Seatbelt CANNOT do per-host egress filtering — the kernel grammar only accepts
  // `*` or `localhost` as the host in a network address. A hostname/IP makes the WHOLE
  // profile fail to compile (sandbox-exec exits 65), silently breaking every run. So the
  // command tier supports only port-scoped allows ("*:port" or a bare port → "*:port").
  // Host-scoped allowlisting is a Deno-tier / microVM-tier capability; callers needing it
  // are rejected at validateSeatbeltNet() with policy-invalid (fail closed, honest).
  const netLines =
    policy.allowNet.length === 0
      ? "(deny network*)"
      : [
          "(deny network*)",
          ...policy.allowNet.map((entry) => {
            const port = entry.includes(":") ? entry.slice(entry.lastIndexOf(":") + 1) : entry
            return `(allow network* (remote ip "*:${port}"))`
          }),
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
      const netErr = validateSeatbeltNet(policy)
      if (netErr) return err<SandboxResult, SandboxError>(netErr)

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
