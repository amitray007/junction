// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction platform add` and `junction platform list`.
//
// The "unit" suite resolves @junction/core to SOURCE (vitest alias), so it runs
// under `pnpm verify` without a build. The "built bin" suite drives the compiled
// dist/index.js end-to-end; it is skipped when dist/ is absent.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createRepositories, getDatabase, getPaths } from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { platformCommand } from "./platform.js"

const execFileAsync = promisify(execFile)
const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

// ---------------------------------------------------------------------------
// Local spec server (serves OpenAPI specs for add-time resolution tests)
// ---------------------------------------------------------------------------

let specPort = 0

/** Spec with relative servers — /api/v1 should resolve against the spec URL. */
function makeRelativeServersSpec() {
  return {
    openapi: "3.0.0",
    info: { title: "Relative Servers API", version: "1.0.0" },
    servers: [{ url: "/api/v1" }],
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          summary: "List items",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }
}

/** Spec with no servers entry — should fail at add time. */
function makeNoServersSpec() {
  return {
    openapi: "3.0.0",
    info: { title: "No Servers API", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          summary: "List items",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }
}

/** Spec with server-variable templating in URL. */
function makeVariableServersSpec() {
  return {
    openapi: "3.0.0",
    info: { title: "Variable Servers API", version: "1.0.0" },
    servers: [{ url: "https://{host}/v1" }],
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }
}

const specServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${specPort}`)
  const specs: Record<string, object> = {
    "/relative.json": makeRelativeServersSpec(),
    "/noservers.json": makeNoServersSpec(),
    "/variables.json": makeVariableServersSpec(),
  }
  const spec = specs[url.pathname]
  if (spec) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(spec))
    return
  }
  res.writeHead(404)
  res.end("not found")
})

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      specServer.listen(0, "127.0.0.1", () => {
        specPort = (specServer.address() as AddressInfo).port
        resolve()
      })
    }),
)

afterAll(() => new Promise<void>((resolve) => specServer.close(() => resolve())))

// ---------------------------------------------------------------------------
// Helpers for direct-command tests
// ---------------------------------------------------------------------------

/** Capture everything written to process.stdout during fn(). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  const intercept: NodeJS.WriteStream["write"] = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }
  process.stdout.write = intercept
  try {
    await fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join("")
}

/** Minimal citty run context — matches what citty passes to run(). */
function ctx<T extends Record<string, unknown>>(argValues: T) {
  return { args: argValues, cmd: {} as never, rawArgs: [] as string[] }
}

/** Access a subcommand's run function from platformCommand. */
function getPlatformSubCmd(name: string) {
  const subs = (
    platformCommand as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }
  ).subCommands
  const cmd = subs[name]
  if (!cmd) throw new Error(`subcommand "${name}" not found`)
  return cmd
}

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

// ---------------------------------------------------------------------------
// platform add — OpenAPI base-URL resolution (unit, direct command invocation)
// ---------------------------------------------------------------------------

describe("platform add — openapi base-URL resolution (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-openapi-baseurl-test-"))
    process.env.JUNCTION_HOME = home
    process.env.JUNCTION_STORE = "file"
    process.exitCode = 0
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    process.exitCode = prevExitCode
    await rm(home, { recursive: true, force: true })
  })

  it("relative servers URL is resolved to an absolute baseUrl (no --base-url)", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/relative.json`

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "rel-plat",
            kind: "openapi",
            "display-name": "Relative Servers",
            "spec-url": specUrl,
            "base-url": undefined,
            "auth-scheme": undefined,
            "auth-in": undefined,
            "auth-name": undefined,
            "auth-username": undefined,
            "max-tools": undefined,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      platform?: { openapi?: { baseUrl?: string } }
    }
    expect(parsed.ok).toBe(true)

    // Verify the stored baseUrl is the absolute resolved URL
    const expectedBase = `http://127.0.0.1:${specPort}/api/v1`
    expect(parsed.platform?.openapi?.baseUrl).toBe(expectedBase)

    // Also verify DB state directly
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const list = await repos.platforms.list()
    expect(list.isOk()).toBe(true)
    if (!list.isOk()) return
    const plat = list.value.find((p) => p.id === "rel-plat")
    expect(plat?.openapi?.baseUrl).toBe(expectedBase)
  })

  it("spec with no servers and no --base-url → fails at add time, platform not persisted", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/noservers.json`

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "nobase-plat",
            kind: "openapi",
            "display-name": "No Servers",
            "spec-url": specUrl,
            "base-url": undefined,
            "auth-scheme": undefined,
            "auth-in": undefined,
            "auth-name": undefined,
            "auth-username": undefined,
            "max-tools": undefined,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    // Should report an error
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/base URL/)
    expect(parsed.error).toMatch(/--base-url/)

    // Platform must not be persisted
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const list = await repos.platforms.list()
    if (!list.isOk()) return
    expect(list.value.find((p) => p.id === "nobase-plat")).toBeUndefined()
  })

  it("spec with server-variable URL and no --base-url → fails at add time", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/variables.json`

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "var-plat",
            kind: "openapi",
            "display-name": "Variable Servers",
            "spec-url": specUrl,
            "base-url": undefined,
            "auth-scheme": undefined,
            "auth-in": undefined,
            "auth-name": undefined,
            "auth-username": undefined,
            "max-tools": undefined,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/variables/)
  })

  it("--base-url override is honored and stored as absolute baseUrl", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/noservers.json`
    const override = "https://api.example.com/v2"

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "override-plat",
            kind: "openapi",
            "display-name": "Override Base URL",
            "spec-url": specUrl,
            "base-url": override,
            "auth-scheme": undefined,
            "auth-in": undefined,
            "auth-name": undefined,
            "auth-username": undefined,
            "max-tools": undefined,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      platform?: { openapi?: { baseUrl?: string } }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.platform?.openapi?.baseUrl).toBe(override)
  })

  it("--base-url non-absolute → fails at add time with invalid-base-url message", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/noservers.json`

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "badurl-plat",
            kind: "openapi",
            "display-name": "Bad Base URL",
            "spec-url": specUrl,
            "base-url": "/not-absolute",
            "auth-scheme": undefined,
            "auth-in": undefined,
            "auth-name": undefined,
            "auth-username": undefined,
            "max-tools": undefined,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/absolute/)
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
