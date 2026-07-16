// SPDX-License-Identifier: AGPL-3.0-only
// Tests for binary discovery (increment 41.4). Uses a temp dir + a fake PATH
// (process.env.PATH is set/restored per test) rather than touching the real
// filesystem's PATH — discovery must never depend on what's actually installed
// on the machine running the tests.

import {
  chmod,
  realpath as fsRealpath,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { okAsync } from "../../result/index.js"
import type {
  Sandbox,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxResult,
} from "../../sandbox/index.js"
import { discoverBinary } from "./discover.js"

let tmpDir: string
let originalPath: string | undefined

beforeEach(async () => {
  // Resolve to the realpath immediately — on macOS os.tmpdir() (/tmp) is a
  // symlink to /private/tmp, so comparing discoverBinary's realpath output
  // (which resolves symlinks) against a non-realpath'd tmpDir would spuriously
  // fail. Normalizing here keeps every downstream path.join(tmpDir, ...)
  // comparison exact.
  const created = await mkdtemp(path.join(os.tmpdir(), "junction-discover-test-"))
  tmpDir = await fsRealpath(created)
  originalPath = process.env.PATH
})

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await rm(tmpDir, { recursive: true, force: true })
})

/** Create an executable fake binary file at `dir/name`. */
async function makeExecutable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, "#!/bin/sh\necho fake\n")
  await chmod(file, 0o755)
  return file
}

/** Create a non-executable file at `dir/name`. */
async function makeNonExecutable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, "not executable")
  await chmod(file, 0o644)
  return file
}

describe("discoverBinary", () => {
  it("rejects an invalid name (slashes) without touching the filesystem", async () => {
    const result = await discoverBinary("../etc/passwd")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-name")
  })

  it("rejects an invalid name (shell metacharacters)", async () => {
    const result = await discoverBinary("gh; rm -rf /")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("invalid-name")
  })

  it("rejects a name starting with a dash", async () => {
    const result = await discoverBinary("--version")
    expect(result.isErr()).toBe(true)
  })

  it("returns Ok([]) when nothing is found — not an error", async () => {
    process.env.PATH = tmpDir
    const result = await discoverBinary("definitely-not-a-real-binary-xyz")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual([])
  })

  it("finds a binary on PATH and marks source:'path'", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeExecutable(binDir, "mytool")
    process.env.PATH = binDir

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.source).toBe("path")
    expect(result.value[0]?.name).toBe("mytool")
    expect(result.value[0]?.realpath).toBe(path.join(binDir, "mytool"))
  })

  it("filters out non-executable files", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeNonExecutable(binDir, "mytool")
    process.env.PATH = binDir

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual([])
  })

  it("orders PATH hits before common-dir hits, and PATH hits in PATH order", async () => {
    const binDir1 = path.join(tmpDir, "bin1")
    const binDir2 = path.join(tmpDir, "bin2")
    await makeExecutable(binDir1, "mytool")
    await makeExecutable(binDir2, "mytool")
    process.env.PATH = [binDir1, binDir2].join(path.delimiter)

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toHaveLength(2)
    expect(result.value[0]?.path).toBe(path.join(binDir1, "mytool"))
    expect(result.value[0]?.source).toBe("path")
    expect(result.value[1]?.path).toBe(path.join(binDir2, "mytool"))
    expect(result.value[1]?.source).toBe("path")
  })

  it("recommendation is the FIRST entry (PATH order), not highest version", async () => {
    const binDir1 = path.join(tmpDir, "bin1")
    const binDir2 = path.join(tmpDir, "bin2")
    await makeExecutable(binDir1, "mytool")
    await makeExecutable(binDir2, "mytool")
    process.env.PATH = [binDir1, binDir2].join(path.delimiter)

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    // No sandbox passed → no version probes; the FIRST candidate (PATH order)
    // is still the recommendation regardless of any version data.
    expect(result.value[0]?.path).toBe(path.join(binDir1, "mytool"))
  })

  it("dedupes by realpath — a symlink resolving to an already-seen binary is dropped", async () => {
    const binDir1 = path.join(tmpDir, "bin1")
    const binDir2 = path.join(tmpDir, "bin2")
    const real = await makeExecutable(binDir1, "mytool")
    await mkdir(binDir2, { recursive: true })
    await symlink(real, path.join(binDir2, "mytool"))
    process.env.PATH = [binDir1, binDir2].join(path.delimiter)

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.path).toBe(path.join(binDir1, "mytool"))
  })

  it("does not crash on a PATH entry that doesn't exist", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeExecutable(binDir, "mytool")
    const nonexistentDir = path.join(tmpDir, "does-not-exist")
    process.env.PATH = [nonexistentDir, binDir].join(path.delimiter)

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toHaveLength(1)
  })

  it("skips blank PATH entries", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeExecutable(binDir, "mytool")
    process.env.PATH = `${binDir}${path.delimiter}${path.delimiter}`

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Version probing — sandboxed, best-effort, never blocks discovery
// ---------------------------------------------------------------------------

function fakeSandboxReturning(stdout: string): Sandbox {
  const caps: SandboxCapabilities = { command: "seatbelt", script: "none" }
  return {
    capabilities: () => caps,
    runCommand: (_argv: readonly string[], _policy: SandboxPolicy) =>
      okAsync<SandboxResult, never>({
        stdout,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }) as ReturnType<Sandbox["runCommand"]>,
    runScript: (_script, _policy) =>
      okAsync<SandboxResult, never>({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }) as ReturnType<Sandbox["runScript"]>,
  }
}

function failingSandbox(): Sandbox {
  const caps: SandboxCapabilities = { command: "seatbelt", script: "none" }
  return {
    capabilities: () => caps,
    runCommand: () =>
      okAsync<SandboxResult, never>({
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
        timedOut: false,
      }) as ReturnType<Sandbox["runCommand"]>,
    runScript: (_script, _policy) =>
      okAsync<SandboxResult, never>({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }) as ReturnType<Sandbox["runScript"]>,
  }
}

describe("discoverBinary — version probing (sandboxed)", () => {
  it("omits version when no sandbox is provided", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeExecutable(binDir, "mytool")
    process.env.PATH = binDir

    const result = await discoverBinary("mytool")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value[0]?.version).toBeUndefined()
  })

  it("parses a version token from the sandboxed probe output", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeExecutable(binDir, "mytool")
    process.env.PATH = binDir

    const sandbox = fakeSandboxReturning("mytool version 2.95.0\n(built from source)\n")
    const result = await discoverBinary("mytool", sandbox)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value[0]?.version).toBe("2.95.0")
  })

  it("omits version on an unparseable probe result — never blocks discovery", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeExecutable(binDir, "mytool")
    process.env.PATH = binDir

    const sandbox = fakeSandboxReturning("no version info here")
    const result = await discoverBinary("mytool", sandbox)
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value[0]?.version).toBeUndefined()
  })

  it("omits version when the sandboxed probe itself fails — discovery still succeeds", async () => {
    const binDir = path.join(tmpDir, "bin1")
    await makeExecutable(binDir, "mytool")
    process.env.PATH = binDir

    const result = await discoverBinary("mytool", failingSandbox())
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.version).toBeUndefined()
    }
  })
})
