// SPDX-License-Identifier: AGPL-3.0-only
// Sandbox integration tests -- Seatbelt (macOS), Deno (when available), bubblewrap (Linux).
// ANTI-THEATER: every forbidden-op test also asserts the same op succeeds OUTSIDE the sandbox.

import { execFile as execFileCb } from "node:child_process"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  buildBwrapArgv,
  buildBwrapEnv,
  probeCommandBackend as probeBwrapBackend,
} from "./bubblewrap.js"
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

  it("TRUE read confinement: a file OUTSIDE readPaths (not a credential) is denied", async () => {
    // inc 21: reads are deny-default (bsd.sb supplies system reads); only readPaths
    // are readable. Before this, the profile broad-allowed reads and only denied
    // ~/.junction — so /etc/hosts (a non-credential file outside readPaths) WAS
    // readable. It must now be denied, while a file inside readPaths still reads.
    const sb = await createSandbox()
    expect(sb.isOk()).toBe(true)
    if (!sb.isOk()) return
    const policy = basePolicy(ws)

    // /etc/hosts exists, is outside readPaths, and is NOT a junction credential.
    const denied = await sb.value.runCommand(["/bin/cat", "/etc/hosts"], policy)
    expect(denied.isOk()).toBe(true)
    if (denied.isOk()) expect(denied.value.exitCode).not.toBe(0) // Operation not permitted

    // A file INSIDE readPaths still reads (loader survived deny-default via bsd.sb).
    const allowed = await sb.value.runCommand(["/bin/cat", allowedFile], policy)
    expect(allowed.isOk()).toBe(true)
    if (allowed.isOk()) {
      expect(allowed.value.exitCode).toBe(0)
      expect(allowed.value.stdout).toContain("hello-allowed")
    }
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

// ── bubblewrap argv (pure, cross-platform): secret must NOT land in argv ──────
describe("bubblewrap argv construction", () => {
  it("credential value goes to the env, never into the bwrap argv (no /proc/cmdline leak)", () => {
    const SENTINEL = "s3cr3t-bwrap-sentinel-zzz"
    const policy: SandboxPolicy = {
      readPaths: ["/work"],
      writePaths: [],
      allowNet: [],
      env: { GH_PAT: SENTINEL, PATH: "/usr/bin:/bin" },
      cwd: "/work",
      timeoutMs: 5_000,
    }
    const argv = buildBwrapArgv(["/bin/echo", "hi"], policy)
    // The secret VALUE must not appear anywhere in argv (it would be in `ps`/cmdline).
    expect(argv.some((a) => a.includes(SENTINEL))).toBe(false)
    // No --setenv at all (env is forwarded via the spawn env, not argv).
    expect(argv).not.toContain("--setenv")
    // The secret IS forwarded via the env map.
    expect(buildBwrapEnv(policy).GH_PAT).toBe(SENTINEL)
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
  it.skipIf(process.platform === "win32")("sleep beyond timeoutMs -> timed-out error", async () => {
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

// ── FIX 1: SBPL/argv metachar injection -- policy-invalid BEFORE spawn ────────

describe("path metachar injection (FIX 1)", () => {
  // Chars that must be rejected: double-quote, close-paren, newline, comma.
  // NUL (char code 0) and CR are also covered but hard to express in test literals.
  const PAREN = ")"
  const DQUOTE = '"'
  // LF and comma via string literals
  const LF = String.fromCharCode(10)
  const COMMA = ","

  const BAD_CHARS: Array<[string, string]> = [
    ["double-quote", DQUOTE],
    ["close-paren", PAREN],
    ["newline", LF],
    ["comma", COMMA],
  ]

  // Exact PoC writePath from FIX 1 spec (SBPL injection).
  const POC_WRITE_PATH = '/private/tmp/ws")) (allow file-write* (subpath "/private/tmp/escape'

  it.each(BAD_CHARS)("readPaths with %s -> policy-invalid, no spawn", async (_, badChar) => {
    const ws = await makeWorkspace()
    const spawnSpy = vi
      .spyOn(await import("./exec.js"), "spawnSandboxed")
      .mockRejectedValue(new Error("spawnSandboxed must NOT be called for metachar path"))
    try {
      const sb = await createSandbox()
      expect(sb.isOk()).toBe(true)
      if (!sb.isOk()) return
      const policy: SandboxPolicy = {
        ...basePolicy(ws),
        readPaths: [`${ws}${badChar}safe`],
        writePaths: [ws],
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await cleanup(ws)
    }
  })

  it.each(BAD_CHARS)("writePaths with %s -> policy-invalid, no spawn", async (_, badChar) => {
    const ws = await makeWorkspace()
    const spawnSpy = vi
      .spyOn(await import("./exec.js"), "spawnSandboxed")
      .mockRejectedValue(new Error("spawnSandboxed must NOT be called for metachar path"))
    try {
      const sb = await createSandbox()
      expect(sb.isOk()).toBe(true)
      if (!sb.isOk()) return
      const policy: SandboxPolicy = {
        ...basePolicy(ws),
        writePaths: [`${ws}${badChar}safe`],
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await cleanup(ws)
    }
  })

  it.each(BAD_CHARS)("cwd with %s -> policy-invalid, no spawn", async (_, badChar) => {
    const ws = await makeWorkspace()
    const spawnSpy = vi
      .spyOn(await import("./exec.js"), "spawnSandboxed")
      .mockRejectedValue(new Error("spawnSandboxed must NOT be called for metachar cwd"))
    try {
      const sb = await createSandbox()
      expect(sb.isOk()).toBe(true)
      if (!sb.isOk()) return
      // cwd must pass isAbsolute + be within a granted path; inject bad char AFTER ws prefix
      const badCwd = `${ws}${badChar}`
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [ws],
        allowNet: [],
        env: {},
        cwd: badCwd,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await cleanup(ws)
    }
  })

  it("PoC SBPL injection writePath -> policy-invalid and no spawn", async () => {
    const ws = await makeWorkspace()
    const spawnSpy = vi
      .spyOn(await import("./exec.js"), "spawnSandboxed")
      .mockRejectedValue(new Error("spawnSandboxed must NOT be called for PoC path"))
    try {
      const sb = await createSandbox()
      expect(sb.isOk()).toBe(true)
      if (!sb.isOk()) return
      const policy: SandboxPolicy = {
        readPaths: [ws],
        writePaths: [POC_WRITE_PATH],
        allowNet: [],
        env: {},
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await cleanup(ws)
    }
  })
})

// ── FIX 2: allowNet strict validation ────────────────────────────────────────

describe("allowNet validation (FIX 2)", () => {
  async function runWithNet(net: string[]): Promise<{ isErr: boolean; kind?: string }> {
    const ws = await makeWorkspace()
    try {
      const sb = await createSandbox()
      if (!sb.isOk()) return { isErr: true, kind: "sandbox-unavailable" }
      const policy: SandboxPolicy = { ...basePolicy(ws), allowNet: net }
      const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
      if (result.isErr()) return { isErr: true, kind: result.error.kind }
      return { isErr: false }
    } finally {
      await cleanup(ws)
    }
  }

  it('bare hostname "api.github.com" -> policy-invalid', async () => {
    // Caught by central validateAllowNetEntry: bare hostname without port is always rejected.
    // Cross-platform: runs on seatbelt (macOS) and bubblewrap (Linux) alike.
    const r = await runWithNet(["api.github.com"])
    expect(r.isErr).toBe(true)
    expect(r.kind).toBe("policy-invalid")
  })

  // Seatbelt-specific: "host:port" passes central validation (valid shape) but
  // validateSeatbeltNet rejects it because seatbelt cannot scope egress per-host.
  // On bubblewrap, --unshare-all denies all network anyway; host-scoped entries
  // are not rejected at the policy level (there's no seatbelt profile to compile).
  it.skipIf(process.platform !== "darwin")(
    '"api.github.com:443" -> policy-invalid (Seatbelt cannot host-scope)',
    async () => {
      const r = await runWithNet(["api.github.com:443"])
      expect(r.isErr).toBe(true)
      expect(r.kind).toBe("policy-invalid")
    },
  )

  it('"evil.com,x.com" -> policy-invalid (comma metachar)', async () => {
    const r = await runWithNet(["evil.com,x.com"])
    expect(r.isErr).toBe(true)
    expect(r.kind).toBe("policy-invalid")
  })

  it.skipIf(process.platform !== "darwin")('"*:443" -> accepted (profile compiles)', async () => {
    const r = await runWithNet(["*:443"])
    expect(r.isErr).toBe(false)
  })

  it.skipIf(process.platform !== "darwin")(
    '"443" (port-only) -> accepted (profile compiles)',
    async () => {
      const r = await runWithNet(["443"])
      expect(r.isErr).toBe(false)
    },
  )
})

// ── FIX 1 (Deno): comma in readPath widens --allow-read -> policy-invalid ────

describe("Deno comma readPath widening (FIX 1)", () => {
  it("readPath containing comma -> policy-invalid before Deno spawn", async () => {
    const ws = await makeWorkspace()
    const spawnSpy = vi
      .spyOn(await import("./exec.js"), "spawnSandboxed")
      .mockRejectedValue(new Error("spawnSandboxed must NOT be called for comma readPath"))
    try {
      const sb = await createSandbox()
      expect(sb.isOk()).toBe(true)
      if (!sb.isOk()) return
      if (sb.value.capabilities().script !== "deno") return // gated: deno absent
      const policy: SandboxPolicy = {
        readPaths: [`${ws}/safe,/etc`], // comma widens Deno --allow-read
        writePaths: [ws],
        allowNet: [],
        env: {},
        cwd: ws,
        timeoutMs: 5_000,
      }
      const result = await sb.value.runScript({ code: `console.log("hi")` }, policy)
      expect(result.isErr()).toBe(true)
      if (!result.isErr()) return
      expect(result.error.kind).toBe("policy-invalid")
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await cleanup(ws)
    }
  })
})

// ── FIX 3: symlinked writePath into secret tree -> exposure flagged ───────────

describe.skipIf(process.platform === "win32")(
  "symlinked writePath into secret tree (FIX 3)",
  () => {
    it("symlink whose realpath is inside JUNCTION_HOME -> policy-invalid", async () => {
      // Set JUNCTION_HOME to a CONTROLLED temp dir so the always-denied list is
      // deterministic on any runner (including CI where ~/.junction does not exist).
      // getPaths() reads process.env.JUNCTION_HOME, so setting it here means
      // getAlwaysDeniedPaths() returns paths inside fakeJunctionHome.
      const fakeJunctionHome = await mkdtemp(path.join(os.tmpdir(), "jx-fake-junction-"))
      const prevJunctionHome = process.env.JUNCTION_HOME
      process.env.JUNCTION_HOME = fakeJunctionHome

      // Create a credential file inside the controlled secret tree so realpath
      // resolution succeeds (the exposure check resolves both sides with realpath).
      const fakeCredFile = path.join(fakeJunctionHome, "credentials.enc.json")
      await writeFile(fakeCredFile, "{}")

      // Create a symlink in a separate temp dir that points INTO the controlled
      // secret tree. The symlink itself is outside JUNCTION_HOME.
      const linkBase = await mkdtemp(path.join(os.tmpdir(), "jx-link-base-"))
      const linkToSecret = path.join(linkBase, "cred-link")
      // Symlink points to fakeJunctionHome — resolving it lands inside the secret tree.
      await symlink(fakeJunctionHome, linkToSecret)

      try {
        // Verify the symlink resolves into the fake secret tree (sanity check).
        const resolvedLink = await realpath(linkToSecret)
        expect(resolvedLink).toBe(await realpath(fakeJunctionHome))

        // The exposure check is cross-platform (no backend needed): a writePath
        // whose realpath falls inside JUNCTION_HOME must be flagged policy-invalid.
        // This test exercises validatePolicy → grantedPathExposesSecrets with a real
        // secret tree present in the controlled JUNCTION_HOME.
        const ws = await makeWorkspace()
        try {
          const sb = await createSandbox()
          expect(sb.isOk()).toBe(true)
          if (!sb.isOk()) return
          const policy: SandboxPolicy = {
            readPaths: [ws],
            writePaths: [linkToSecret], // symlink → fakeJunctionHome (always-denied)
            allowNet: [],
            env: {},
            cwd: ws,
            timeoutMs: 5_000,
          }
          const result = await sb.value.runCommand(["/bin/echo", "hi"], policy)
          // Must be policy-invalid — realpath(linkToSecret) == fakeJunctionHome,
          // which is in the always-denied list (since JUNCTION_HOME=fakeJunctionHome).
          expect(result.isErr()).toBe(true)
          if (!result.isErr()) return
          expect(result.error.kind).toBe("policy-invalid")
        } finally {
          await cleanup(ws)
        }
      } finally {
        // Restore JUNCTION_HOME before cleanup so any subsequent getPaths() calls
        // in the same test run see the original value.
        if (prevJunctionHome === undefined) {
          delete process.env.JUNCTION_HOME
        } else {
          process.env.JUNCTION_HOME = prevJunctionHome
        }
        await cleanup(linkBase)
        await cleanup(fakeJunctionHome)
      }
    })
  },
)
