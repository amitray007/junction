// SPDX-License-Identifier: AGPL-3.0-only
// Shared async spawn helper for sandbox backends. NO fs.*Sync — async only.

import { spawn } from "node:child_process"
import { err, ok, ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"
import type { SandboxPolicy, SandboxResult } from "./sandbox.js"

/**
 * Hard ceiling on combined stdout+stderr bytes collected per spawn.
 * When exceeded the child is SIGKILLed (same mechanism as the timeout) and the
 * result is returned with truncated output and outputCapped:true.
 * Mirrors RESPONSE_BYTE_CAP in openapi-client/http.ts (1 MB).
 */
export const SPAWN_OUTPUT_BYTE_CAP = 1_048_576 // 1 MB

/** Spawn argv[0] with argv.slice(1), collect stdout/stderr, enforce timeout→SIGKILL.
 *  Also enforces an output byte cap — a flood no longer OOMs junction.
 */
export async function spawnSandboxed(
  argv: readonly string[],
  opts: {
    env: Record<string, string>
    cwd: string
    timeoutMs: number
    stdin?: string
  },
): Promise<SandboxResult | { _err: SandboxError }> {
  const [cmd, ...args] = argv
  if (!cmd) return { _err: { kind: "spawn-failed", cause: new Error("empty argv") } }

  return new Promise<SandboxResult | { _err: SandboxError }>((resolve) => {
    let timedOut = false
    let outputCapped = false
    let outBytes = 0
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      shell: false,
      // detached: true so sandbox-exec/bwrap and all their grandchildren form a
      // process group — on timeout we SIGKILL the entire group, not just the wrapper.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    // Shared SIGKILL helper — mirrors the timeout path exactly so both code paths
    // kill the full process group, not just the sandbox wrapper.
    function killGroup(): void {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          // Process group may have already exited; fall back to killing the wrapper.
          child.kill("SIGKILL")
        }
      } else {
        child.kill("SIGKILL")
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (outputCapped) return
      outBytes += chunk.length
      if (outBytes > SPAWN_OUTPUT_BYTE_CAP) {
        outputCapped = true
        killGroup()
        // Do not push this chunk — output is truncated to what was collected before the cap.
        return
      }
      stdoutChunks.push(chunk)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      if (outputCapped) return
      outBytes += chunk.length
      if (outBytes > SPAWN_OUTPUT_BYTE_CAP) {
        outputCapped = true
        killGroup()
        return
      }
      stderrChunks.push(chunk)
    })

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin)
      child.stdin.end()
    } else {
      child.stdin.end()
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, opts.timeoutMs)

    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ _err: { kind: "spawn-failed", cause: err } })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ _err: { kind: "timed-out", timeoutMs: opts.timeoutMs } })
        return
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? 1,
        timedOut: false,
        outputCapped,
      })
    })
  })
}

export function isSpawnErr(r: SandboxResult | { _err: SandboxError }): r is { _err: SandboxError } {
  return "_err" in r
}

/**
 * Spawn `argv` under the policy's cwd/timeout/stdin with an EXPLICIT env, and
 * lift the outcome into a `ResultAsync<SandboxResult, SandboxError>`. Every
 * backend funnels through here so the spawn-and-wrap boilerplate (and the
 * policy→spawn-opts mapping) lives in exactly one place (DRY primitive).
 *
 * `env` is always passed explicitly by the caller (built from policy.env only,
 * plus any backend-required keys like Deno's HOME) — this helper NEVER reads
 * process.env, preserving the no-secret-leak invariant.
 */
export function runSandboxed(
  argv: readonly string[],
  policy: SandboxPolicy,
  env: Record<string, string>,
): ResultAsync<SandboxResult, SandboxError> {
  return new ResultAsync(
    spawnSandboxed(argv, {
      env,
      cwd: policy.cwd,
      timeoutMs: policy.timeoutMs,
      stdin: policy.stdin,
    }).then((result) =>
      isSpawnErr(result)
        ? err<SandboxResult, SandboxError>(result._err)
        : ok<SandboxResult, SandboxError>(result),
    ),
  )
}
