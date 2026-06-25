// SPDX-License-Identifier: AGPL-3.0-only
// Deno runtime backend for sandboxed JS/TS script execution.
// --deny-run and --deny-ffi are MANDATORY (the documented escape hatches).
// Write {code} to a temp .ts file in a writePath — never deno eval, never a shell string.
// Omitting an --allow-* flag entirely = zero capability (don't pass --allow-read with no path).
//
// We resolve the deno binary to its full absolute path at probe time so that spawning
// with an explicit scrubbed env (no PATH) still works.

import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { err, ResultAsync } from "neverthrow"
import type { SandboxError } from "../errors/index.js"
import { runSandboxed } from "./exec.js"
import type { SandboxPolicy, SandboxResult } from "./sandbox.js"

const execFileAsync = promisify(execFile)

let scriptBackendCache: "deno" | "none" | undefined
let denoBinPath: string | undefined

export async function probeScriptBackend(): Promise<"deno" | "none"> {
  if (scriptBackendCache !== undefined) return scriptBackendCache

  try {
    // Resolve the full binary path so we can spawn with a scrubbed env (no PATH).
    const { stdout: whichOut } = await execFileAsync("which", ["deno"], { timeout: 5000 })
    const binPath = whichOut.trim()
    if (!binPath) {
      scriptBackendCache = "none"
      return scriptBackendCache
    }
    const { stdout } = await execFileAsync(binPath, ["--version"], { timeout: 5000 })
    if (stdout.includes("deno")) {
      denoBinPath = binPath
      scriptBackendCache = "deno"
    } else {
      scriptBackendCache = "none"
    }
  } catch {
    scriptBackendCache = "none"
  }
  return scriptBackendCache
}

function buildDenoArgv(
  scriptFile: string,
  policy: SandboxPolicy,
  extraReadPaths: readonly string[] = [],
): string[] {
  const deno = denoBinPath ?? "deno"
  const args = [deno, "run", "--no-prompt"]

  // Deno needs read access to its own entry module. When {code} is written to a
  // temp dir, that dir is granted read here (not exposed to the script's own logic
  // beyond loading the module — it is a junction-controlled dir, not caller data).
  const readPaths = [...policy.readPaths, ...extraReadPaths]
  if (readPaths.length > 0) {
    args.push(`--allow-read=${readPaths.join(",")}`)
  }
  if (policy.writePaths.length > 0) {
    args.push(`--allow-write=${policy.writePaths.join(",")}`)
  }
  if (policy.allowNet.length > 0) {
    args.push(`--allow-net=${policy.allowNet.join(",")}`)
  }

  const envKeys = Object.keys(policy.env)
  if (envKeys.length > 0) {
    args.push(`--allow-env=${envKeys.join(",")}`)
  }

  // MANDATORY deny flags — the documented escape hatches.
  args.push("--deny-run", "--deny-ffi", "--deny-sys", "--deny-import")

  args.push(scriptFile)
  return args
}

export function runWithDeno(
  script: { file: string } | { code: string },
  policy: SandboxPolicy,
): ResultAsync<SandboxResult, SandboxError> {
  return new ResultAsync(
    (async () => {
      let tmpDir: string | undefined
      let scriptFile: string
      const extraReadPaths: string[] = []

      try {
        if ("code" in script) {
          // {code} must land inside a granted writePath so the script file is
          // covered by the policy (never a shared world dir like os.tmpdir()).
          const baseDir = policy.writePaths[0]
          if (baseDir === undefined) {
            return err<SandboxResult, SandboxError>({
              kind: "policy-invalid",
              reason: "runScript({code}) requires at least one writePath for the script file",
            })
          }
          tmpDir = await mkdtemp(path.join(baseDir, "jx-deno-"))
          scriptFile = path.join(tmpDir, "script.ts")
          await writeFile(scriptFile, script.code, { mode: 0o600 })
          // Grant read of the temp dir so Deno can load its own entry module.
          extraReadPaths.push(tmpDir)
        } else {
          scriptFile = script.file
        }

        const argv = buildDenoArgv(scriptFile, policy, extraReadPaths)
        // HOME is needed so Deno can locate its cache dir.
        return await runSandboxed(argv, policy, { ...policy.env, HOME: os.homedir() })
      } finally {
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true })
        }
      }
    })(),
  )
}
