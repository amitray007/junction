// SPDX-License-Identifier: AGPL-3.0-only
// Shared async spawn helper for sandbox backends. NO fs.*Sync — async only.

import { spawn } from "node:child_process"
import { err, ok, ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"
import type { SandboxPolicy, SandboxResult } from "./sandbox.js"

/** Spawn argv[0] with argv.slice(1), collect stdout/stderr, enforce timeout→SIGKILL. */
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
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin)
      child.stdin.end()
    } else {
      child.stdin.end()
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
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
