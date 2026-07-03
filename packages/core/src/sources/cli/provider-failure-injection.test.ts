// SPDX-License-Identifier: AGPL-3.0-only
// Failure-injection tests for prepareCredential's kind "file" mechanics
// (increment 28.9 slice D hardening, GAP-1).
//
// prepareCredential is NOT exported (internal to provider.ts) — these tests
// drive it indirectly through createCliProvider().callTool(), mocking
// node:fs/promises so writeFile (and, separately, mkdtemp) reject. Kept in a
// SEPARATE file from provider.test.ts: vi.mock("node:fs/promises") is
// file-scoped and hoisted, and provider.test.ts's other suites rely on the
// REAL fs for their mkdtemp/writeFile/rm-based assertions — mixing the two
// in one file would mean every other test in that file runs against a
// partially-mocked fs module.
//
// Both scenarios must prove:
//   (1) the call fails with a clean UpstreamError (never an uncaught throw)
//   (2) cause is the documented sentinel string
//   (3) no temp dir is left behind (cleanup ran despite the injected failure)

import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CliConnection, CliSecret, CliTool } from "../../schema/cli-connection.js"

const actualFsPromises =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")

let writeFileShouldFail = false
let mkdtempShouldFail = false

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...actual,
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => {
      if (writeFileShouldFail) return Promise.reject(new Error("injected writeFile failure"))
      return actual.writeFile(...args)
    }),
    mkdtemp: vi.fn((...args: Parameters<typeof actual.mkdtemp>) => {
      if (mkdtempShouldFail) return Promise.reject(new Error("injected mkdtemp failure"))
      return actual.mkdtemp(...args)
    }),
  }
})

// Imported AFTER the mock is registered (vi.mock is hoisted regardless, but
// keeping the dynamic import here makes the ordering explicit for readers).
const { createCliProvider } = await import("./provider.js")
const { getPaths } = await import("../../paths/index.js")

function noopTool(): CliTool {
  return {
    name: "noop",
    argv: [{ kind: "literal", value: "/bin/echo" }],
    args: [],
    policy: {
      cwd: "/tmp",
      readPaths: ["/tmp"],
      writePaths: [],
      allowNet: [],
      timeoutMs: 2000,
      envAllow: {},
    },
  }
}

function fileConnection(): CliConnection {
  return { tools: [noopTool()], credentialEnvVar: "CRED_FILE_VAR" }
}

describe("prepareCredential — failure injection (GAP-1)", () => {
  let tempHome: string
  let prevJunctionHome: string | undefined

  beforeEach(async () => {
    tempHome = await actualFsPromises.mkdtemp(path.join(os.tmpdir(), "jx-fail-inject-home-"))
    prevJunctionHome = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = tempHome
    writeFileShouldFail = false
    mkdtempShouldFail = false
  })

  afterEach(async () => {
    if (prevJunctionHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevJunctionHome
    await actualFsPromises.rm(tempHome, { recursive: true, force: true })
  })

  /** cred-* dirs currently under paths.runtimeDir (empty if it doesn't exist). */
  async function credDirs(runtimeDir: string): Promise<string[]> {
    const entries = await actualFsPromises.readdir(runtimeDir).catch(() => [] as string[])
    return entries.filter((f) => f.startsWith("cred-"))
  }

  it("writeFile failure → clean Err with cause 'temp-file-write-failed', AND the temp dir is removed", async () => {
    const paths = getPaths()
    writeFileShouldFail = true

    const secret: CliSecret = { kind: "file", value: "some-secret-content" }
    const provider = createCliProvider(fileConnection(), secret, paths)
    const result = await provider.callTool("noop", {})

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("call-failed")
    expect((result.error as { cause: unknown }).cause).toBe("temp-file-write-failed")

    // mkdtemp succeeded (real fs) before the injected writeFile failure — the
    // resulting dir must have been rm'd in prepareCredential's own catch, not
    // left orphaned under runtimeDir.
    const after = await credDirs(paths.runtimeDir)
    expect(after.length).toBe(0)
  })

  it("mkdtemp failure → clean Err with cause 'temp-dir-create-failed', no orphan dir", async () => {
    const paths = getPaths()
    mkdtempShouldFail = true

    const secret: CliSecret = { kind: "file", value: "some-secret-content" }
    const provider = createCliProvider(fileConnection(), secret, paths)
    const result = await provider.callTool("noop", {})

    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("call-failed")
    expect((result.error as { cause: unknown }).cause).toBe("temp-dir-create-failed")

    // mkdtemp never succeeded — runtimeDir may exist (ensureRuntimeDir ran) but
    // must contain no cred-* leaf at all.
    const after = await credDirs(paths.runtimeDir)
    expect(after.length).toBe(0)
  })
})
