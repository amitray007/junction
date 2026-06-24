// SPDX-License-Identifier: AGPL-3.0-only
// CLI integration tests — drive command handlers directly + one child-process smoke test.

import { execFile } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { getPaths } from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { describe, expect, it } from "vitest"
import { initCommand } from "./commands/init.js"
import { statusCommand } from "./commands/status.js"

const execFileAsync = promisify(execFile)

const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js")

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
})
