// SPDX-License-Identifier: AGPL-3.0-only
// scripts/web-leakcheck.mjs self-test (increment 32.7 item 4) — proves the
// leak checker actually exits non-zero on a planted leak, not just that it
// exits zero on the real (clean) build. Node env, root vitest "unit" project.
//
// Spawns the real script as a child process against a fixture dir passed via
// the new --dir override, rather than importing its module-scope-executing
// logic in-process.

import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

const scriptPath = fileURLToPath(new URL("../../../../scripts/web-leakcheck.mjs", import.meta.url))

let tempRoot: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "junction-leakcheck-test-"))
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

async function runLeakcheck(
  dir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [scriptPath, "--dir", dir], {
      timeout: 10_000,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

describe("scripts/web-leakcheck.mjs — increment 32.7 item 4 self-test", () => {
  it("fixture A (leak + positive control): exits 1 and names the offending marker", async () => {
    await mkdir(path.join(tempRoot, "assets"), { recursive: true })
    await writeFile(
      path.join(tempRoot, "assets", "chunk.js"),
      `require("better-sqlite3"); const x = () => useLoaderData();`,
    )

    const result = await runLeakcheck(tempRoot)

    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain("better-sqlite3")
  })

  it("fixture B (clean, positive control only): exits 0", async () => {
    await mkdir(path.join(tempRoot, "assets"), { recursive: true })
    await writeFile(path.join(tempRoot, "assets", "chunk.js"), `const x = () => useLoaderData();`)

    const result = await runLeakcheck(tempRoot)

    expect(result.exitCode).toBe(0)
  })

  it("fixture C (vacuous — missing assets dir): exits 1 via the existence guard, not a vacuous pass", async () => {
    // tempRoot exists but has no assets/ subdir at all.
    const result = await runLeakcheck(tempRoot)

    expect(result.exitCode).toBe(1)
    // Pin the BRANCH, not just the exit code — a timeout-killed child also
    // maps to exit 1 in runLeakcheck, so assert the existence-guard message.
    expect(result.stdout + result.stderr).toContain("missing")
  })

  it("--dir flag with a MISSING value: exits 1 with an error (never silently scans the default dir)", async () => {
    try {
      await execFileAsync("node", [scriptPath, "--dir"], { timeout: 10_000 })
      expect.unreachable("leakcheck must fail on --dir without a value")
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string }
      expect(e.code).toBe(1)
      expect((e.stdout ?? "") + (e.stderr ?? "")).toContain("--dir")
    }
  })
})
