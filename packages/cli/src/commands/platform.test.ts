// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction platform add` and `junction platform list`.
//
// The "unit" suite resolves @junction/core to SOURCE (vitest alias), so it runs
// under `pnpm verify` without a build. The "built bin" suite drives the compiled
// dist/index.js end-to-end; it is skipped when dist/ is absent.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createRepositories, getDatabase, getPaths } from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

describe("platform commands (unit)", () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    home = await mkdtemp(join(tmpdir(), "junction-platform-test-"))
    process.env.JUNCTION_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it("empty DB returns empty platform list", async () => {
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return

    const repos = createRepositories(dbResult.value)
    const listResult = await repos.platforms.list()
    expect(listResult.isOk()).toBe(true)
    if (listResult.isOk()) {
      expect(listResult.value).toEqual([])
    }
  })

  it("upserts an http platform and retrieves it", async () => {
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return

    const repos = createRepositories(dbResult.value)
    const result = await repos.platforms.upsert({
      id: "example-mcp" as Parameters<typeof repos.platforms.upsert>[0]["id"],
      kind: "mcp" as const,
      displayName: "Example MCP",
      connection: {
        transport: "http" as const,
        url: "https://api.example.com/mcp/",
        auth: { scheme: "bearer" as const, header: "Authorization" },
      },
    })
    expect(result.isOk()).toBe(true)

    const list = await repos.platforms.list()
    expect(list.isOk()).toBe(true)
    if (list.isOk()) {
      expect(list.value.length).toBe(1)
      expect(list.value[0]?.connection?.transport).toBe("http")
    }
  })
})

describe.skipIf(!builtBinReady)("platform commands (built bin, child process)", () => {
  it("platform add --json creates a platform and list --json shows it", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      // Add an http platform (generic data — not vendor-specific code)
      const addOut = await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "my-mcp-server",
          "--kind",
          "mcp",
          "--display-name",
          "My MCP Server",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--auth-header",
          "Authorization",
          "--json",
        ],
        { env },
      )
      const addParsed = JSON.parse(addOut.stdout.trim()) as {
        ok: boolean
        platform?: { id: string }
      }
      expect(addParsed.ok).toBe(true)
      expect(addParsed.platform?.id).toBe("my-mcp-server")

      // List should show the platform
      const listOut = await execFileAsync("node", [distIndex, "platform", "list", "--json"], {
        env,
      })
      const platforms = JSON.parse(listOut.stdout.trim()) as Array<{
        id: string
        connection?: { transport: string; url: string }
      }>
      expect(platforms.length).toBe(1)
      expect(platforms[0]?.id).toBe("my-mcp-server")
      expect(platforms[0]?.connection?.transport).toBe("http")
      expect(platforms[0]?.connection?.url).toBe("https://api.example.com/mcp/")
    })
  })

  it("platform add stdio transport --json creates a platform with command", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      const addOut = await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "local-mcp",
          "--kind",
          "mcp",
          "--display-name",
          "Local MCP",
          "--transport",
          "stdio",
          "--command",
          "npx",
          "--arg",
          "-y",
          "--arg",
          "@mcp/server-example",
          "--token-env",
          "MCP_TOKEN",
          "--json",
        ],
        { env },
      )
      const parsed = JSON.parse(addOut.stdout.trim()) as {
        ok: boolean
        platform?: { connection?: { transport: string; command: string; args: string[] } }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.platform?.connection?.transport).toBe("stdio")
      expect(parsed.platform?.connection?.command).toBe("npx")
      expect(parsed.platform?.connection?.args).toEqual(["-y", "@mcp/server-example"])
    })
  })

  it("platform add without --url for http transport returns error --json", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      const result = await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "bad",
          "--display-name",
          "Bad",
          "--transport",
          "http",
          "--json",
        ],
        { env, reject: false } as Parameters<typeof execFileAsync>[2] & { reject?: boolean },
      ).catch((e: { stdout?: string }) => e)
      const stdout = (result as { stdout?: string }).stdout ?? ""
      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toMatch(/--url/)
    })
  })

  it("platform list --json on a fresh home returns empty array", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }
      const { stdout } = await execFileAsync("node", [distIndex, "platform", "list", "--json"], {
        env,
      })
      const parsed: unknown = JSON.parse(stdout.trim())
      expect(parsed).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // platform remove — success + in-use RESTRICT guard
  // ---------------------------------------------------------------------------
  it("platform remove --id removes the platform and exits 0", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "to-remove",
          "--display-name",
          "To Remove",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      const { stdout } = await execFileAsync(
        "node",
        [distIndex, "platform", "remove", "--id", "to-remove", "--json"],
        { env },
      )
      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; id?: string }
      expect(parsed.ok).toBe(true)
      expect(parsed.id).toBe("to-remove")

      // verify it's gone from list
      const listAfter = await execFileAsync("node", [distIndex, "platform", "list", "--json"], {
        env,
      })
      const remaining = JSON.parse(listAfter.stdout.trim()) as unknown[]
      expect(remaining).toHaveLength(0)
    })
  })

  it("platform remove --id while credential references it → in-use error, exit 1", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, JUNCTION_HOME: home, JUNCTION_STORE: "file" }

      await execFileAsync(
        "node",
        [
          distIndex,
          "platform",
          "add",
          "--id",
          "inuse-plat",
          "--display-name",
          "InUse Plat",
          "--transport",
          "http",
          "--url",
          "https://api.example.com/mcp/",
          "--json",
        ],
        { env },
      )

      await new Promise<void>((resolve) => {
        const child = execFile(
          "node",
          [
            distIndex,
            "credential",
            "add",
            "--platform",
            "inuse-plat",
            "--account",
            "work",
            "--kind",
            "bearer",
            "--token-stdin",
            "--json",
          ],
          { env },
          () => resolve(),
        )
        child.stdin?.write("dummy-token")
        child.stdin?.end()
      })

      // Try to remove the platform — should fail because credential references it
      const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        execFile(
          "node",
          [distIndex, "platform", "remove", "--id", "inuse-plat", "--json"],
          { env },
          (err, stdout) => {
            resolve({ stdout, exitCode: (err as { code?: number } | null)?.code ?? 0 })
          },
        )
      })
      expect(result.exitCode).toBe(1)
      const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; error?: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("in use")
    })
  })
})
