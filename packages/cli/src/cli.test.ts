// SPDX-License-Identifier: AGPL-3.0-only
// CLI integration tests — drive command handlers directly + one child-process smoke test.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { ensureHome, getPaths } from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { describe, expect, it } from "vitest"
import { initCommand } from "./commands/init.js"
import { runStatus, statusCommand } from "./commands/status.js"

const execFileAsync = promisify(execFile)

const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js")
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

// ---------------------------------------------------------------------------
// Helper: capture what a command handler writes to process.stdout
// ---------------------------------------------------------------------------
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)

  // Replace write with an interceptor typed to match NodeJS.WriteStream["write"].
  const intercept: NodeJS.WriteStream["write"] = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return orig(chunk as string)
  }
  process.stdout.write = intercept

  try {
    await fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join("")
}

// citty's run signature uses a context object; craft a minimal one
type RunCtx<T extends Record<string, unknown>> = {
  args: T
  cmd: never
  rawArgs: string[]
}

function ctx<T extends Record<string, unknown>>(args: T): RunCtx<T> {
  return { args, cmd: {} as never, rawArgs: [] }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI commands", () => {
  it("init creates config.json; status --json reports initialized: true", async () => {
    await withTempHome(async (home) => {
      // Run init --json (skips prompts)
      const initOut = await captureStdout(() => initCommand.run?.(ctx({ json: true, yes: false })))
      const initJson = JSON.parse(initOut.trim())
      expect(initJson.ok).toBe(true)
      expect(initJson.home).toBe(home)
      expect(initJson.created).toBe(true)

      // Config file must exist on disk
      const paths = getPaths()
      await expect(stat(paths.configFile)).resolves.toBeTruthy()

      // status --json must report initialized: true with config
      const statusOut = await captureStdout(() => statusCommand.run?.(ctx({ json: true })))
      const statusJson = JSON.parse(statusOut.trim())
      expect(statusJson.initialized).toBe(true)
      expect(statusJson.home).toBe(home)
      expect(statusJson.config).toMatchObject({ version: 1 })
    })
  })

  it("init --json is non-interactive and emits valid JSON", async () => {
    await withTempHome(async () => {
      const out = await captureStdout(() => initCommand.run?.(ctx({ json: true, yes: false })))
      const parsed = JSON.parse(out.trim())
      expect(typeof parsed.ok).toBe("boolean")
    })
  })

  it("init twice is idempotent — second call reports created: false", async () => {
    await withTempHome(async () => {
      await captureStdout(() => initCommand.run?.(ctx({ json: true, yes: false })))
      const out = await captureStdout(() => initCommand.run?.(ctx({ json: true, yes: false })))
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(true)
      expect(parsed.created).toBe(false)
    })
  })

  it("status --json on fresh home (no config) returns initialized: false, exit 0", async () => {
    await withTempHome(async (home) => {
      // withTempHome sets JUNCTION_HOME; home dir was created by ensureHome implicitly —
      // but no config.json was written yet.
      await mkdir(home, { recursive: true })

      const out = await captureStdout(() => statusCommand.run?.(ctx({ json: true })))
      const parsed = JSON.parse(out.trim())
      expect(parsed.initialized).toBe(false)
      expect(parsed.home).toBe(home)
      expect(parsed.config).toBeNull()
    })
  })

  it("status --json output is pure parseable JSON — exactly one line, no log noise", async () => {
    await withTempHome(async () => {
      await captureStdout(() => initCommand.run?.(ctx({ json: true, yes: false })))

      const out = await captureStdout(() => statusCommand.run?.(ctx({ json: true })))
      const lines = out.split("\n").filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0] ?? "")
      expect(parsed).toHaveProperty("initialized", true)
    })
  })

  it("status --json on malformed config.json → exit != 0, valid JSON {ok:false,error:...}", async () => {
    await withTempHome(async () => {
      const pathsResult = await ensureHome()
      if (!pathsResult.isOk()) throw new Error("ensureHome failed")
      await writeFile(pathsResult.value.configFile, "this is not json", "utf-8")

      const savedCode = process.exitCode
      const out = await captureStdout(() => statusCommand.run?.(ctx({ json: true })))
      expect(process.exitCode).not.toBe(0)
      process.exitCode = savedCode

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(typeof parsed.error).toBe("string")
      expect(parsed.error.length).toBeGreaterThan(0)
    })
  })

  it("init over a corrupt config.json → exit != 0, valid JSON {ok:false,error:...}", async () => {
    await withTempHome(async () => {
      const pathsResult = await ensureHome()
      if (!pathsResult.isOk()) throw new Error("ensureHome failed")
      await writeFile(pathsResult.value.configFile, "garbage", "utf-8")

      const savedCode = process.exitCode
      const out = await captureStdout(() => initCommand.run?.(ctx({ json: true, yes: false })))
      expect(process.exitCode).not.toBe(0)
      process.exitCode = savedCode

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(typeof parsed.error).toBe("string")
      expect(parsed.error.length).toBeGreaterThan(0)
    })
  })
})

describe("CLI smoke test (child-process)", () => {
  it("built dist/index.js --help exits 0 and mentions junction", async () => {
    await withTempHome(async (home) => {
      const { stdout } = await execFileAsync("node", [distIndex, "--help"], {
        env: { ...process.env, JUNCTION_HOME: home },
      })
      expect(stdout).toContain("junction")
    })
  })

  it("init --json then status --json round-trips over real filesystem", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }

      const { stdout: initOut } = await execFileAsync("node", [distIndex, "init", "--json"], {
        env,
      })
      const initJson = JSON.parse(initOut.trim())
      expect(initJson.ok).toBe(true)
      expect(initJson.created).toBe(true)

      const { stdout: statusOut } = await execFileAsync("node", [distIndex, "status", "--json"], {
        env,
      })
      const statusJson = JSON.parse(statusOut.trim())
      expect(statusJson.initialized).toBe(true)
      expect(statusJson.config).toMatchObject({ version: 1 })
    })
  })

  it("--json error output is parseable and non-empty on a non-TTY pipe (bad config.json)", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }

      // First create the home dir so we can write a bad config.json into it.
      await execFileAsync("node", [distIndex, "init", "--json"], { env })

      // Overwrite config.json with garbage to trigger a parse error.
      const paths = getPaths()
      await writeFile(paths.configFile, "not valid json at all", "utf-8")

      // Run status --json — must exit non-zero and emit parseable JSON with ok:false.
      let stdout = ""
      let exitedNonZero = false
      try {
        const result = await execFileAsync("node", [distIndex, "status", "--json"], { env })
        stdout = result.stdout
      } catch (err: unknown) {
        exitedNonZero = true
        if (err && typeof err === "object" && "stdout" in err) {
          stdout = String((err as { stdout: unknown }).stdout)
        }
      }

      expect(exitedNonZero).toBe(true)
      expect(stdout.trim().length).toBeGreaterThan(0)
      const parsed = JSON.parse(stdout.trim())
      expect(parsed.ok).toBe(false)
      expect(typeof parsed.error).toBe("string")
    })
  })
})

// ---------------------------------------------------------------------------
// Headless-fallback contract (unit — no built dist needed)
// ---------------------------------------------------------------------------

describe("bare junction headless fallback (runStatus)", () => {
  it("runStatus(false) produces human-readable output on stdout (non-TTY path)", async () => {
    await withTempHome(async () => {
      // Init first so status has something to report
      await captureStdout(() =>
        initCommand.run?.({ args: { json: true, yes: false }, cmd: {} as never, rawArgs: [] }),
      )

      const out = await captureStdout(() => runStatus(false))
      // Should contain the home path and key status fields
      expect(out.length).toBeGreaterThan(0)
    })
  })

  it("runStatus(true) produces valid JSON on stdout (--json fallback path)", async () => {
    await withTempHome(async () => {
      await captureStdout(() =>
        initCommand.run?.({ args: { json: true, yes: false }, cmd: {} as never, rawArgs: [] }),
      )

      const out = await captureStdout(() => runStatus(true))
      const lines = out.split("\n").filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0] ?? "")
      expect(parsed).toHaveProperty("initialized", true)
      expect(parsed).toHaveProperty("home")
    })
  })
})

// ---------------------------------------------------------------------------
// Headless-fallback + status --json contract (built bin — child process)
// ---------------------------------------------------------------------------

describe.skipIf(!builtBinReady)("bare junction non-TTY (child-process — headless contract)", () => {
  it("bare junction piped (non-TTY stdout) outputs status and does NOT hang", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      // Init home
      await execFileAsync("node", [distIndex, "init", "--json"], { env })

      // Bare junction with piped stdout (execFileAsync gives non-TTY stdout)
      // Must complete within timeout and produce non-empty output (not hang).
      const { stdout } = await execFileAsync("node", [distIndex], {
        env,
        timeout: 8000,
      })
      expect(stdout.trim().length).toBeGreaterThan(0)
      // Should not have launched the interactive TUI (which would never resolve)
    })
  })

  it("junction status --json is unchanged (still emits valid JSON after TUI wiring)", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home }
      await execFileAsync("node", [distIndex, "init", "--json"], { env })

      const { stdout } = await execFileAsync("node", [distIndex, "status", "--json"], { env })
      const parsed = JSON.parse(stdout.trim())
      expect(parsed).toHaveProperty("initialized", true)
      expect(parsed).toHaveProperty("home", home)
      expect(parsed).toHaveProperty("credentialStore")
      expect(parsed).toHaveProperty("sandbox")
    })
  })
})
