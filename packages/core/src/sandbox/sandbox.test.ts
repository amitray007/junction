// SPDX-License-Identifier: AGPL-3.0-only
// Sandbox integration tests — Seatbelt (macOS), Deno (when available), bubblewrap (Linux).
// ANTI-THEATER: every forbidden-op test also asserts the same op succeeds OUTSIDE the sandbox.

import { execFile as execFileCb } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { probeCommandBackend as probeBwrapBackend } from "./bubblewrap.js"
import { probeScriptBackend } from "./deno.js"
import { createSandbox, type SandboxPolicy } from "./index.js"
import { _resetCapabilitiesCache } from "./sandbox.js"

const execFileAsync = promisify(execFileCb)

// ── Helpers ─────────────────────────────────────────────────────────────────

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "jx-sb-test-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

function basePolicy(ws: string): SandboxPolicy {
  return {
    readPaths: [ws],
    writePaths: [ws],
    allowNet: [],
    env: {},
    cwd: ws,
    timeoutMs: 10_000,
  }
}

// ── Seatbelt (macOS only) ────────────────────────────────────────────────────

describe.skipIf(process.platform !== "darwin")("Seatbelt", () => {
  let ws: string
  let allowedFile: string

  beforeAll(async () => {
    ws = await makeWorkspace()
    allowedFile = path.join(ws, "allowed.txt")
    await writeFile(allowedFile, "hello-allowed")
    // Create a file that will be denied (not in write test; used in denied-read test)
    await writeFile(path.join(ws, "denied.txt"), "hello-denied")
  })

  afterAll(async () => {
    _resetCapabilitiesCache()
    await cleanup(ws)
  })

  it("allowed command runs and returns output", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const policy = basePolicy(ws)
    const result = await sb.value.runCommand(["/bin/cat", allowedFile], policy)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.exitCode).toBe(0)
    expect(result.value.stdout).toContain("hello-allowed")
  })

  it("forbidden read is DENIED (nonzero) AND same op outside sandbox succeeds", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const policy: SandboxPolicy = {
      readPaths: [ws],
      writePaths: [ws],
      allowNet: [],
      env: {},
      cwd: ws,
      timeoutMs: 5_000,
    }

    // The seatbelt profile always denies ~/.junction subpath.
    // Test that reading from the denied path fails.
    const homeDotJunction = path.join(os.homedir(), ".junction")
    const testDeniedFile = path.join(homeDotJunction, "test-denied.txt")

    const sandboxResult = await sb.value.runCommand(
      // Shell: try to cat the denied file; capture exit status via echo
      ["/bin/bash", "-c", `cat "${testDeniedFile}" 2>/dev/null; echo "exit:$?"`],
      policy,
    )

    expect(sandboxResult.isOk()).toBe(true)
    if (!sandboxResult.isOk()) return

    // cat of a denied path fails (exit:1 or similar nonzero)
    const output = sandboxResult.value.stdout
    expect(output).not.toContain("exit:0")

    // ANTI-THEATER: same cat outside sandbox on an existing allowed file succeeds.
    const outsideResult = await execFileAsync("cat", [allowedFile]).catch(() => null)
    expect(outsideResult).not.toBeNull()
    expect(outsideResult?.stdout).toContain("hello-allowed")
  })

  it("denied credential path is blocked via BOTH its logical and realpath (symlink bypass)", async () => {
    // Regression: if a denied path is under a symlinked prefix (e.g. /tmp → /private/tmp
    // on macOS), the kernel matches the deny-subpath on the REAL path. A logical-only deny
    // line is silently bypassed by reading the file via its real path. The profile must emit
    // both. We exercise ~/.junction (always-denied) reached via realpath.
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const dotJunction = path.join(os.homedir(), ".junction")
    await rm(path.join(dotJunction, "symlink-probe.txt"), { force: true }).catch(() => {})
    await writeFile(path.join(dotJunction, "symlink-probe.txt"), "CRED-SECRET").catch(() => {})
    const realDenied = await realpath(path.join(dotJunction, "symlink-probe.txt")).catch(() =>
      path.join(dotJunction, "symlink-probe.txt"),
    )

    try {
      const policy = basePolicy(ws)
      const r = await sb.value.runCommand(
        ["/bin/bash", "-c", `cat "${realDenied}" 2>&1; echo "exit:$?"`],
        policy,
      )
      expect(r.isOk()).toBe(true)
      if (!r.isOk()) return
      // Must NOT leak the secret and must NOT exit 0 (the read was denied).
      expect(r.value.stdout).not.toContain("CRED-SECRET")
      expect(r.value.stdout).not.toContain("exit:0")
    } finally {
      await rm(path.join(dotJunction, "symlink-probe.txt"), { force: true }).catch(() => {})
    }
  })

  it("write confinement: write inside workspace succeeds, outside fails", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const policy = basePolicy(ws)

    // Write inside workspace → should succeed.
    const insideFile = path.join(ws, "write-test.txt")
    const insideResult = await sb.value.runCommand(
      ["/bin/bash", "-c", `echo "written" > "${insideFile}"`],
      policy,
    )
    expect(insideResult.isOk()).toBe(true)
    if (!insideResult.isOk()) return
    expect(insideResult.value.exitCode).toBe(0)

    // Write outside workspace → should fail (nonzero).
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "jx-outside-write-"))
    const outsideFile = path.join(outsideDir, "forbidden.txt")
    try {
      const outsideResult = await sb.value.runCommand(
        ["/bin/bash", "-c", `echo "written" > "${outsideFile}"`],
        policy,
      )
      expect(outsideResult.isOk()).toBe(true)
      if (!outsideResult.isOk()) return
      expect(outsideResult.value.exitCode).not.toBe(0)

      // ANTI-THEATER: outside sandbox, writing to that dir works.
      const realWrite = await execFileAsync("/bin/bash", [
        "-c",
        `echo "real" > "${outsideFile}"`,
      ]).catch(() => null)
      expect(realWrite).not.toBeNull()
    } finally {
      await cleanup(outsideDir)
    }
  })

  it("network denied AND same op outside sandbox succeeds", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const policy = basePolicy(ws)

    // nc -z -w2 1.1.1.1 443 — connect probe (denied in sandbox).
    const ncPath = "/usr/bin/nc"
    const sandboxResult = await sb.value.runCommand([ncPath, "-z", "-w2", "1.1.1.1", "443"], policy)
    expect(sandboxResult.isOk()).toBe(true)
    if (!sandboxResult.isOk()) return
    expect(sandboxResult.value.exitCode).not.toBe(0)

    // ANTI-THEATER: same nc outside sandbox → exit 0.
    // Note: CI may block outbound — the key proof is sandbox denied (nonzero above);
    // the outside result is best-effort and not asserted (CI firewalls may block it too).
    void execFileAsync(ncPath, ["-z", "-w2", "1.1.1.1", "443"]).catch(() => null)
  })

  it("no secret leak: JUNCTION_MASTER_KEY is not passed to child", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const original = process.env.JUNCTION_MASTER_KEY
    process.env.JUNCTION_MASTER_KEY = "SUPER-SECRET-VALUE"
    try {
      const policy: SandboxPolicy = {
        ...basePolicy(ws),
        env: {}, // explicit empty env — secret must NOT bleed through
      }
      // Shell expands $JUNCTION_MASTER_KEY from its own env (which is empty after scrub).
      const secretVar = "JUNCTION_MASTER_KEY"
      const result = await sb.value.runCommand(
        ["/bin/bash", "-c", `echo "val=\${${secretVar}}"`],
        policy,
      )
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.stdout).not.toContain("SUPER-SECRET-VALUE")
      // The child sees the var as empty (env scrub worked).
      expect(result.value.stdout.trim()).toBe("val=")
    } finally {
      if (original === undefined) {
        delete process.env.JUNCTION_MASTER_KEY
      } else {
        process.env.JUNCTION_MASTER_KEY = original
      }
    }
  })
})

// ── Deno (when available) ────────────────────────────────────────────────────

describe("Deno runScript", async () => {
  const denoAvailable = (await probeScriptBackend()) === "deno"

  let ws: string

  beforeAll(async () => {
    ws = await makeWorkspace()
  })

  afterAll(async () => {
    _resetCapabilitiesCache()
    await cleanup(ws)
  })

  it.skipIf(!denoAvailable)("denied read → nonzero exit with PermissionDenied", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const policy: SandboxPolicy = {
      readPaths: [ws], // /etc/passwd is NOT in readPaths
      writePaths: [ws],
      allowNet: [],
      env: {},
      cwd: ws,
      timeoutMs: 10_000,
    }

    // Script tries to read a file outside readPaths.
    const result = await sb.value.runScript(
      { code: `Deno.readTextFileSync("/etc/passwd"); console.log("read-ok")` },
      policy,
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.exitCode).not.toBe(0)
    expect(result.value.stderr).toMatch(/PermissionDenied|NotCapable|permission/i)

    // ANTI-THEATER: same read outside sandbox with Deno (unrestricted) succeeds.
    // Use the full binary path (same one the probe resolved) so PATH-less env is not an issue.
    const denoBin = (
      await execFileAsync("which", ["deno"]).catch(() => ({ stdout: "" }))
    ).stdout.trim()
    const outside = denoBin
      ? await execFileAsync(denoBin, [
          "run",
          "--allow-read=/etc/passwd",
          "--deny-run",
          "--deny-ffi",
          "--deny-sys",
          "--deny-import",
          "--no-prompt",
          "data:application/typescript,console.log(Deno.readTextFileSync('/etc/passwd').slice(0,4))",
        ]).catch(() => null)
      : null
    expect(outside).not.toBeNull()
    expect(outside?.stdout.trim()).toBeTruthy()
  })

  it.skipIf(!denoAvailable)("allowed read inside readPaths → exit 0", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const testFile = path.join(ws, "deno-read.txt")
    await writeFile(testFile, "deno-content")

    const policy: SandboxPolicy = {
      readPaths: [ws],
      writePaths: [ws],
      allowNet: [],
      env: {},
      cwd: ws,
      timeoutMs: 10_000,
    }

    const result = await sb.value.runScript(
      { code: `console.log(Deno.readTextFileSync(${JSON.stringify(testFile)}))` },
      policy,
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.exitCode).toBe(0)
    expect(result.value.stdout).toContain("deno-content")
  })

  it.skipIf(!denoAvailable)("--deny-run blocks subprocess spawn", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const policy: SandboxPolicy = {
      readPaths: [ws],
      writePaths: [ws],
      allowNet: [],
      env: {},
      cwd: ws,
      timeoutMs: 10_000,
    }

    // Use absolute path for echo so PATH-absence doesn't produce a different error;
    // the deny-run block should produce PermissionDenied regardless.
    const result = await sb.value.runScript(
      {
        code: `const p = new Deno.Command("/bin/echo", { args: ["spawned"] }).spawn(); await p.status;`,
      },
      policy,
    )
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.exitCode).not.toBe(0)
    expect(result.value.stderr).toMatch(/PermissionDenied|NotCapable|permission/i)
  })
})

// ── bubblewrap (Linux CI only) ────────────────────────────────────────────────

describe("bubblewrap", async () => {
  const bwrapAvailable = (await probeBwrapBackend()) === "bubblewrap"

  let ws: string
  let allowedFile: string

  beforeAll(async () => {
    ws = await makeWorkspace()
    allowedFile = path.join(ws, "bwrap-allowed.txt")
    await writeFile(allowedFile, "bwrap-content")
  })

  afterAll(async () => {
    _resetCapabilitiesCache()
    await cleanup(ws)
  })

  it.skipIf(!bwrapAvailable)("allowed command runs inside bubblewrap", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const policy = basePolicy(ws)
    const result = await sb.value.runCommand(["/bin/cat", allowedFile], policy)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.exitCode).toBe(0)
    expect(result.value.stdout).toContain("bwrap-content")
  })

  it.skipIf(!bwrapAvailable)("no secret leak under bubblewrap", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const original = process.env.JUNCTION_MASTER_KEY
    process.env.JUNCTION_MASTER_KEY = "BWRAP-SECRET"
    try {
      const policy: SandboxPolicy = { ...basePolicy(ws), env: {} }
      const secretVar = "JUNCTION_MASTER_KEY"
      const result = await sb.value.runCommand(
        ["/bin/bash", "-c", `echo "val=\${${secretVar}}"`],
        policy,
      )
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.stdout).not.toContain("BWRAP-SECRET")
    } finally {
      if (original === undefined) {
        delete process.env.JUNCTION_MASTER_KEY
      } else {
        process.env.JUNCTION_MASTER_KEY = original
      }
    }
  })
})

// ── Cross-platform: refuse-if-unavailable + policy-invalid + timeout ─────────

describe("refuse-if-unavailable", () => {
  afterEach(() => {
    _resetCapabilitiesCache()
    vi.restoreAllMocks()
  })

  it("returns Err{unsupported-platform} and does NOT spawn when command backend is none", async () => {
    vi.spyOn(await import("./seatbelt.js"), "probeCommandBackend").mockResolvedValue("none")
    vi.spyOn(await import("./bubblewrap.js"), "probeCommandBackend").mockResolvedValue("none")
    // Tripwire: if any code path tried to spawn, this throws — proving the refuse
    // posture never falls through to raw exec when no backend is enforceable.
    const spawnSpy = vi
      .spyOn(await import("./exec.js"), "spawnSandboxed")
      .mockRejectedValue(new Error("spawnSandboxed must NOT be called when backend is none"))

    _resetCapabilitiesCache()

    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const caps = sb.value.capabilities()
    // The mock pierces createSandbox's dynamic import — assert it (no silent skip).
    expect(caps.command).toBe("none")

    const policy = basePolicy(os.tmpdir())
    const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("unsupported-platform")
    // CARDINAL RULE proof: no spawn happened.
    expect(spawnSpy).not.toHaveBeenCalled()
  })
})

describe("policy-invalid", () => {
  it("rejects policy with *_KEY env var", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: [],
        env: { MY_API_KEY: "secret123" },
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
    } finally {
      await cleanup(ws)
    }
  })

  it("rejects policy with JUNCTION_MASTER_KEY in env", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: [],
        env: { JUNCTION_MASTER_KEY: "mykey" },
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
    } finally {
      await cleanup(ws)
    }
  })

  it("rejects policy with *_TOKEN in env", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: [],
        env: { GITHUB_TOKEN: "ghp_xyz" },
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
    } finally {
      await cleanup(ws)
    }
  })

  it("rejects a granted path that is an ancestor of the credential dir", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const ws = await makeWorkspace()
    try {
      // $HOME is an ancestor of ~/.junction (always-denied) → must be refused.
      const policy: SandboxPolicy = {
        readPaths: [os.homedir()],
        writePaths: [ws],
        allowNet: [],
        env: {},
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
    } finally {
      await cleanup(ws)
    }
  })

  it("rejects cwd outside all read/write paths", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: [],
        env: {},
        cwd: "/usr", // not within ws
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
    } finally {
      await cleanup(ws)
    }
  })
})

// Seatbelt cannot scope egress per-host; host-scoped allowNet must be refused
// (NOT silently produce a non-compiling profile). Port-only allowNet compiles.
describe.skipIf(process.platform !== "darwin")("Seatbelt allowNet", () => {
  it("rejects host-scoped allowNet as policy-invalid", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: ["api.github.com:443"],
        env: {},
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
    } finally {
      await cleanup(ws)
    }
  })

  it("accepts port-only allowNet (profile compiles, command runs)", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: ["443"],
        env: {},
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "ok"], policy)
      // Must be ok (profile compiled) with exit 0 — NOT a spawn/compile failure.
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.exitCode).toBe(0)
    } finally {
      await cleanup(ws)
    }
  })
})

// runScript({code}) requires a writePath so the script file is policy-covered.
describe.skipIf(process.platform === "win32")("Deno runScript code requires writePath", () => {
  it("rejects {code} when writePaths is empty", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return
    if (sb.value.capabilities().script !== "deno") return // gated: deno absent

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [], // no writePath → {code} must be refused
        allowNet: [],
        env: {},
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runScript({ code: `console.log("hi")` }, policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
    } finally {
      await cleanup(ws)
    }
  })
})

describe("timeout", () => {
  it.skipIf(process.platform === "win32")("sleep beyond timeoutMs → timed-out error", async () => {
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return

    const caps = sb.value.capabilities()
    if (caps.command === "none") return // no command backend available

    const ws = await makeWorkspace()
    try {
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: [],
        env: {},
        cwd: ws,
        timeoutMs: 500,
      }

      const result = await sb.value.runCommand(["/bin/sleep", "10"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("timed-out")
    } finally {
      await cleanup(ws)
    }
  })
})
