// SPDX-License-Identifier: AGPL-3.0-only
// CLI edge tests for `junction platform add` and `junction platform list`.
//
// The "unit" suite resolves @junction/core to SOURCE (vitest alias), so it runs
// under `pnpm verify` without a build. The "built bin" suite drives the compiled
// dist/index.js end-to-end; it is skipped when dist/ is absent.

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

/**
 * Multi-tag spec: 5 ops across pet(3), store(1), user(1).
 * Total > maxTools=3 → refused without --tag; pet slice (3) fits.
 */
function makeTaggedSpec(port: number) {
  return {
    openapi: "3.0.0",
    info: { title: "Tagged API", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/pet": {
        get: {
          operationId: "listPets",
          tags: ["pet"],
          summary: "List pets",
          responses: { "200": { description: "ok" } },
        },
        post: {
          operationId: "createPet",
          tags: ["pet"],
          summary: "Create pet",
          responses: { "201": { description: "created" } },
        },
      },
      "/pet/{petId}": {
        get: {
          operationId: "getPet",
          tags: ["pet"],
          summary: "Get pet",
          parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/store/inventory": {
        get: {
          operationId: "getInventory",
          tags: ["store"],
          summary: "Get inventory",
          responses: { "200": { description: "ok" } },
        },
      },
      "/user": {
        post: {
          operationId: "createUser",
          tags: ["user"],
          summary: "Create user",
          responses: { "201": { description: "created" } },
        },
      },
    },
  }
}

/** Single-op spec — used in refresh no-clobber test (maxTools=1 → 3-op refresh is over cap). */
function makeThreeOpsSpec(port: number) {
  return {
    openapi: "3.0.0",
    info: { title: "Three Ops API", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/a": {
        get: { operationId: "opA", summary: "Op A", responses: { "200": { description: "ok" } } },
      },
      "/b": {
        get: { operationId: "opB", summary: "Op B", responses: { "200": { description: "ok" } } },
      },
      "/c": {
        get: { operationId: "opC", summary: "Op C", responses: { "200": { description: "ok" } } },
      },
    },
  }
}

// Dynamic overrides allow tests to swap what a URL returns between add and refresh.
const dynamicSpecs = new Map<string, object>()

const specServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${specPort}`)

  // Dynamic overrides take precedence (used by refresh tests)
  const dynamic = dynamicSpecs.get(url.pathname)
  if (dynamic !== undefined) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(dynamic))
    return
  }

  const specs: Record<string, () => object> = {
    "/relative.json": makeRelativeServersSpec,
    "/noservers.json": makeNoServersSpec,
    "/variables.json": makeVariableServersSpec,
    "/tagged.json": () => makeTaggedSpec(specPort),
    "/three-ops.json": () => makeThreeOpsSpec(specPort),
  }
  const factory = specs[url.pathname]
  if (factory) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(factory()))
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
function ctx<T extends Record<string, unknown>>(argValues: T, rawArgs: string[] = []) {
  return { args: argValues, cmd: {} as never, rawArgs }
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
// platform add --verify-op — only valid for --kind openapi (inc 28.9 slice B)
// ---------------------------------------------------------------------------

describe("platform add --verify-op rejected for non-openapi kind (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevExitCode: number | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-verify-op-test-"))
    process.env.JUNCTION_HOME = home
    process.exitCode = 0
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    process.exitCode = prevExitCode
    await rm(home, { recursive: true, force: true })
  })

  it("--verify-op with --kind mcp (default) exits 1 with a clean error", async () => {
    const add = getPlatformSubCmd("add")

    const out = await captureStdout(() =>
      add.run?.(
        ctx({
          id: "verify-op-mcp",
          kind: "mcp",
          "display-name": "Verify Op MCP",
          transport: "http",
          url: "https://api.example.com/mcp/",
          "verify-op": "getUser",
          json: true,
        }),
      ),
    )

    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain("--verify-op")
    expect(parsed.error).toContain("openapi")
    expect(process.exitCode).toBe(1)
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

// ---------------------------------------------------------------------------
// platform add — --tag / --path selection (unit, direct command invocation)
// ---------------------------------------------------------------------------

describe("platform add — openapi selection (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-selection-test-"))
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

  it(">cap spec without --tag → refused with tag breakdown + --tag/--path guidance", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/tagged.json`

    // tagged.json has 5 ops; maxTools=3 → refused without selection
    const out = await captureStdout(
      () =>
        add.run?.(
          ctx(
            {
              id: "big-plat",
              kind: "openapi",
              "display-name": "Big",
              "spec-url": specUrl,
              "base-url": undefined,
              "auth-scheme": undefined,
              "auth-in": undefined,
              "auth-name": undefined,
              "auth-username": undefined,
              "max-tools": "3",
              json: true,
            },
            [],
          ),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    // message should name tags + guide to --tag/--path
    expect(parsed.error).toMatch(/exceeding the cap/)
    expect(parsed.error).toMatch(/--tag/)
    expect(parsed.error).toMatch(/--path/)
    expect(parsed.error).toMatch(/pet/)
  })

  it("--tag pet → adds only the 3 pet ops; select persisted in the descriptor", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/tagged.json`

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx(
            {
              id: "pet-plat",
              kind: "openapi",
              "display-name": "Pet",
              "spec-url": specUrl,
              "base-url": undefined,
              "auth-scheme": undefined,
              "auth-in": undefined,
              "auth-name": undefined,
              "auth-username": undefined,
              "max-tools": "3",
              json: true,
            },
            ["--tag", "pet"],
          ),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(0)
    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      platform?: { openapi?: { select?: { tags?: string[] } } }
      toolCount?: number
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.toolCount).toBe(3)
    // Selection must be persisted in the descriptor
    expect(parsed.platform?.openapi?.select?.tags).toEqual(["pet"])

    // Verify DB state directly
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const list = await repos.platforms.list()
    expect(list.isOk()).toBe(true)
    if (!list.isOk()) return
    const plat = list.value.find((p) => p.id === "pet-plat")
    expect(plat?.openapi?.select?.tags).toEqual(["pet"])
  })

  it("--path /pet → adds only ops under /pet prefix", async () => {
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/tagged.json`

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx(
            {
              id: "path-plat",
              kind: "openapi",
              "display-name": "Path",
              "spec-url": specUrl,
              "base-url": undefined,
              "auth-scheme": undefined,
              "auth-in": undefined,
              "auth-name": undefined,
              "auth-username": undefined,
              "max-tools": "3",
              json: true,
            },
            ["--path", "/pet"],
          ),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(0)
    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      platform?: { openapi?: { select?: { paths?: string[] } } }
      toolCount?: number
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.toolCount).toBe(3)
    expect(parsed.platform?.openapi?.select?.paths).toEqual(["/pet"])
  })
})

// ---------------------------------------------------------------------------
// platform refresh (unit, direct command invocation)
// ---------------------------------------------------------------------------

describe("platform refresh (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-refresh-test-"))
    process.env.JUNCTION_HOME = home
    process.env.JUNCTION_STORE = "file"
    process.exitCode = 0
    dynamicSpecs.clear()
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    process.exitCode = prevExitCode
    dynamicSpecs.clear()
    await rm(home, { recursive: true, force: true })
  })

  it("non-openapi platform → error (kind mismatch)", async () => {
    const refresh = getPlatformSubCmd("refresh")
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)

    // Insert an MCP platform directly
    await repos.platforms.upsert({
      id: "mcp-plat" as Parameters<typeof repos.platforms.upsert>[0]["id"],
      kind: "mcp",
      displayName: "MCP Platform",
      connection: {
        transport: "http",
        url: "https://api.example.com/mcp/",
        auth: { scheme: "bearer", header: "Authorization" },
      },
    })

    const out = await captureStdout(
      () => refresh.run?.(ctx({ id: "mcp-plat", json: true })) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/openapi/)
  })

  it("from:inline spec → error (cannot refresh inline)", async () => {
    const refresh = getPlatformSubCmd("refresh")
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)

    // Insert an openapi platform with inline spec
    await repos.platforms.upsert({
      id: "inline-plat" as Parameters<typeof repos.platforms.upsert>[0]["id"],
      kind: "openapi",
      displayName: "Inline Platform",
      openapi: {
        spec: {
          from: "inline",
          document: { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {} },
        },
        baseUrl: "https://api.example.com",
      },
    })

    const out = await captureStdout(
      () => refresh.run?.(ctx({ id: "inline-plat", json: true })) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/URL/)
  })

  it("from:url platform → re-fetches and reports tool count", async () => {
    // Set up: add a platform from three-ops.json
    const add = getPlatformSubCmd("add")
    const specUrl = `http://127.0.0.1:${specPort}/three-ops.json`

    const addOut = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "refresh-plat",
            kind: "openapi",
            "display-name": "Refresh Test",
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
    expect(process.exitCode).toBe(0)
    const addParsed = JSON.parse(addOut.trim()) as { ok: boolean }
    expect(addParsed.ok).toBe(true)

    // Now refresh
    const refresh = getPlatformSubCmd("refresh")
    const out = await captureStdout(
      () => refresh.run?.(ctx({ id: "refresh-plat", json: true })) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(0)
    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      newCount?: number
      oldCount?: number | null
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.newCount).toBe(3)
    // Old count is read from the cache (3 ops), so delta should be 3 → 3
    expect(parsed.oldCount).toBe(3)
  })

  it("refreshed spec over cap → refuses, leaves DB descriptor and cache file unchanged", async () => {
    // Setup: directly insert a platform with maxTools=2 pointing to a URL that will
    // return 3 ops when refreshed (3 > 2 → over cap → no-clobber)
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)

    const specUrl = `http://127.0.0.1:${specPort}/three-ops.json`
    const platformId = "clobber-test" as Parameters<typeof repos.platforms.upsert>[0]["id"]

    await repos.platforms.upsert({
      id: platformId,
      kind: "openapi",
      displayName: "Clobber Test",
      openapi: {
        spec: { from: "url", url: specUrl },
        baseUrl: `http://127.0.0.1:${specPort}`,
        maxTools: 2, // 3 ops > cap=2 → refresh must refuse
      },
    })

    // Write a sentinel cache file so we can verify it's NOT overwritten
    const cacheDir = join(home, "openapi")
    const cacheFile = join(cacheDir, `${platformId}.json`)
    const sentinelContent = '{"sentinel":"original"}'
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cacheFile, sentinelContent, "utf8")

    // Run refresh — must refuse because 3 ops > maxTools=2
    const refresh = getPlatformSubCmd("refresh")
    const out = await captureStdout(
      () => refresh.run?.(ctx({ id: platformId, json: true })) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/exceeding the cap/)
    expect(parsed.error).toMatch(/unchanged/)

    // Cache file must be the original sentinel — NOT overwritten
    const cacheAfter = await readFile(cacheFile, "utf8")
    expect(cacheAfter).toBe(sentinelContent)

    // DB descriptor must be unchanged (maxTools still 2)
    const platAfter = await repos.platforms.get(platformId)
    expect(platAfter.isOk()).toBe(true)
    if (!platAfter.isOk()) return
    expect(platAfter.value.openapi?.maxTools).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// platform add — http (unit, direct command invocation)
// ---------------------------------------------------------------------------

describe("platform add — http (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-http-test-"))
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

  const validDescriptor = JSON.stringify({
    baseUrl: "https://api.example.com",
    tools: [
      {
        name: "getIssue",
        description: "Fetch a single issue by owner/repo/number.",
        method: "GET",
        path: "/repos/{owner}/{repo}/issues/{number}",
        params: [
          { name: "owner", in: "path", type: "string", required: true },
          { name: "repo", in: "path", type: "string", required: true },
          { name: "number", in: "path", type: "number", required: true },
        ],
      },
    ],
  })

  it("--descriptor '<valid json>' --json → creates the platform and reports toolCount", async () => {
    const add = getPlatformSubCmd("add")

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "http-plat",
            kind: "http",
            "display-name": "HTTP Platform",
            descriptor: validDescriptor,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(0)
    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      platform?: { id: string; kind: string; http?: { baseUrl: string } }
      toolCount?: number
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.toolCount).toBe(1)
    expect(parsed.platform?.kind).toBe("http")
    expect(parsed.platform?.http?.baseUrl).toBe("https://api.example.com")

    // Verify DB state directly
    const dbResult = await getDatabase(getPaths())
    expect(dbResult.isOk()).toBe(true)
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const got = await repos.platforms.get("http-plat")
    expect(got.isOk()).toBe(true)
    if (!got.isOk()) return
    expect(got.value.kind).toBe("http")
    expect(got.value.http?.tools.length).toBe(1)
  })

  it("bad JSON in --descriptor → {ok:false}, platform not persisted", async () => {
    const add = getPlatformSubCmd("add")

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "http-badjson",
            kind: "http",
            "display-name": "Bad JSON",
            descriptor: "{not valid json",
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/not valid JSON/)

    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const list = await repos.platforms.list()
    if (!list.isOk()) return
    expect(list.value.find((p) => p.id === "http-badjson")).toBeUndefined()
  })

  it("missing --descriptor → {ok:false}", async () => {
    const add = getPlatformSubCmd("add")

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "http-missing-descriptor",
            kind: "http",
            "display-name": "Missing Descriptor",
            descriptor: undefined,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/--descriptor is required/)
  })

  it("descriptor failing the path↔param cross-check → {ok:false} invalid descriptor, not persisted", async () => {
    const add = getPlatformSubCmd("add")
    const badDescriptor = JSON.stringify({
      baseUrl: "https://api.example.com",
      tools: [
        {
          name: "getIssue",
          description: "Missing the path param declaration.",
          method: "GET",
          path: "/repos/{owner}/{repo}/issues/{number}",
          params: [{ name: "owner", in: "path", type: "string", required: true }],
        },
      ],
    })

    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "http-mismatch",
            kind: "http",
            "display-name": "Mismatch",
            descriptor: badDescriptor,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )

    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/Invalid HTTP descriptor/)

    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const list = await repos.platforms.list()
    if (!list.isOk()) return
    expect(list.value.find((p) => p.id === "http-mismatch")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// platform add — graphql (unit, direct command invocation)
// ---------------------------------------------------------------------------

describe("platform add — graphql (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevStore: string | undefined
  let prevExitCode: number | undefined

  // Local GraphQL endpoint whose introspection POST fails (introspection disabled),
  // so add-time introspection degrades gracefully.
  const gqlServer = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ errors: [{ message: "introspection is disabled" }] }))
    })
  })
  let gqlPort = 0

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        gqlServer.listen(0, "127.0.0.1", () => {
          gqlPort = (gqlServer.address() as AddressInfo).port
          resolve()
        })
      }),
  )
  afterAll(() => new Promise<void>((resolve) => gqlServer.close(() => resolve())))

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-graphql-test-"))
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

  it("rejects apiKey --auth-in query at add time and does not persist", async () => {
    const add = getPlatformSubCmd("add")
    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "gql-q",
            kind: "graphql",
            "display-name": "GQL Q",
            endpoint: `http://127.0.0.1:${gqlPort}/graphql`,
            "auth-scheme": "apiKey",
            "auth-in": "query",
            "auth-name": "key",
            json: true,
          }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/auth-in query is not supported/)

    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const list = await repos.platforms.list()
    if (!list.isOk()) return
    expect(list.value.find((p) => p.id === "gql-q")).toBeUndefined()
  })

  it("introspection disabled at add → platform still created with no cached SDL", async () => {
    const add = getPlatformSubCmd("add")
    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "gql-nointro",
            kind: "graphql",
            "display-name": "No Introspection",
            endpoint: `http://127.0.0.1:${gqlPort}/graphql`,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )
    // Add succeeds (graceful degradation) — the source still works for query/mutation.
    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      platform?: { graphql?: { schemaSdl?: string } }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.platform?.graphql?.schemaSdl).toBeUndefined()

    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) return
    const repos = createRepositories(dbResult.value)
    const got = await repos.platforms.get("gql-nointro")
    expect(got.isOk()).toBe(true)
    if (!got.isOk()) return
    expect(got.value.kind).toBe("graphql")
    expect(got.value.graphql?.schemaSdl).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// platform add --kind cli --full-access — binary discovery + install (inc 41.4)
// ---------------------------------------------------------------------------

describe("platform add --kind cli --full-access (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevExitCode: number | undefined
  let binDir: string
  let binPath: string

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-cli-fa-test-"))
    process.env.JUNCTION_HOME = home
    process.exitCode = 0

    binDir = await mkdtemp(join(tmpdir(), "junction-cli-fa-bin-"))
    binPath = join(binDir, "faketool")
    await writeFile(
      binPath,
      "#!/bin/sh\necho 'usage: faketool [flags]'\necho ''\necho 'FLAGS'\necho '  --dry-run   no-op'\n",
    )
    await chmod(binPath, 0o755)
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    process.exitCode = prevExitCode
    await rm(home, { recursive: true, force: true })
    await rm(binDir, { recursive: true, force: true })
  })

  it("missing both --name and --binary-path → reportError, exitCode 1", async () => {
    const add = getPlatformSubCmd("add")
    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "fa-missing",
            kind: "cli",
            "display-name": "Missing",
            "full-access": true,
            json: true,
          }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/--name.*--binary-path/)
  })

  it.skipIf(process.platform !== "darwin")(
    "--binary-path <override> --json → discovers nothing, extracts via the pinned path, upserts",
    async () => {
      const add = getPlatformSubCmd("add")
      const out = await captureStdout(
        () =>
          add.run?.(
            ctx({
              id: "fa-tool",
              kind: "cli",
              "display-name": "Fake Tool",
              "full-access": true,
              "binary-path": binPath,
              json: true,
            }),
          ) ?? Promise.resolve(),
      )
      expect(process.exitCode).toBe(0)
      const parsed = JSON.parse(out.trim()) as {
        ok: boolean
        candidates: unknown[]
        chosen: string
        nodeCount: number
        truncated: boolean
        platform: { id: string; kind: string; cli?: { mode: string; binaryPath: string } }
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.candidates).toEqual([])
      expect(parsed.chosen).toBe(binPath)
      expect(parsed.nodeCount).toBeGreaterThanOrEqual(1)
      expect(parsed.platform.kind).toBe("cli")
      expect(parsed.platform.cli?.mode).toBe("full-access")
      expect(parsed.platform.cli?.binaryPath).toBe(binPath)

      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) return
      const repos = createRepositories(dbResult.value)
      const got = await repos.platforms.get("fa-tool")
      expect(got.isOk()).toBe(true)
      if (!got.isOk()) return
      expect(got.value.cli?.mode).toBe("full-access")
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "--name <not found> → binary-not-found error (searches an empty temp PATH)",
    async () => {
      const add = getPlatformSubCmd("add")
      const prevPath = process.env.PATH
      process.env.PATH = binDir.replace("faketool", "") // a dir with no matching binary name
      try {
        const out = await captureStdout(
          () =>
            add.run?.(
              ctx({
                id: "fa-notfound",
                kind: "cli",
                "display-name": "Not Found",
                "full-access": true,
                name: "definitely-not-a-real-binary-xyz",
                json: true,
              }),
            ) ?? Promise.resolve(),
        )
        expect(process.exitCode).toBe(1)
        const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
        expect(parsed.ok).toBe(false)
        expect(parsed.error).toMatch(/could not find/)
      } finally {
        process.env.PATH = prevPath
      }
    },
  )

  it("the existing --descriptor declared path still works unchanged", async () => {
    const add = getPlatformSubCmd("add")
    const out = await captureStdout(
      () =>
        add.run?.(
          ctx({
            id: "declared-still-works",
            kind: "cli",
            "display-name": "Declared Tool",
            descriptor: JSON.stringify({
              tools: [
                {
                  name: "echo",
                  argv: [
                    { kind: "literal", value: "/bin/echo" },
                    { kind: "arg", name: "msg" },
                  ],
                  args: [{ name: "msg", type: "string" }],
                  policy: {
                    cwd: binDir,
                    readPaths: [binDir],
                    writePaths: [binDir],
                    allowNet: [],
                    timeoutMs: 5_000,
                  },
                },
              ],
            }),
            json: true,
          }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(0)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; toolCount?: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.toolCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// platform cli-shortcut add/remove — headless shortcuts editing (inc 41.5)
// ---------------------------------------------------------------------------

describe("platform cli-shortcut add/remove (unit)", () => {
  let home: string
  let prevHome: string | undefined
  let prevExitCode: number | undefined

  beforeEach(async () => {
    prevHome = process.env.JUNCTION_HOME
    prevExitCode = process.exitCode
    home = await mkdtemp(join(tmpdir(), "junction-cli-shortcut-test-"))
    process.env.JUNCTION_HOME = home
    process.exitCode = 0
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    process.exitCode = prevExitCode
    await rm(home, { recursive: true, force: true })
  })

  /** Seed a Full CLI access platform directly (no sandbox extraction needed for shortcuts editing). */
  async function seedFullAccessPlatform(id: string) {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error("failed to open test db")
    const repos = createRepositories(dbResult.value)
    const upsertResult = await repos.platforms.upsert({
      id,
      kind: "cli",
      displayName: "GitHub CLI",
      cli: {
        mode: "full-access",
        binaryPath: "/usr/bin/gh",
        policy: {
          cwd: "/tmp",
          readPaths: ["/tmp"],
          writePaths: [],
          allowNet: [],
          timeoutMs: 5_000,
          envAllow: {},
        },
        schema: {
          binaryName: "gh",
          extractedAt: new Date().toISOString(),
          root: {
            path: [],
            parsed: true,
            explored: true,
            flags: [],
            positionals: [],
            subcommands: [],
          },
          truncated: false,
        },
      },
    })
    if (upsertResult.isErr()) throw new Error("failed to seed platform")
    return repos
  }

  function shortcutDescriptor(name: string) {
    return JSON.stringify({
      name,
      argv: [
        { kind: "literal", value: "/usr/bin/gh" },
        { kind: "literal", value: "pr" },
        { kind: "literal", value: "list" },
      ],
      args: [],
      policy: {
        cwd: "/tmp",
        readPaths: ["/tmp"],
        writePaths: [],
        allowNet: [],
        timeoutMs: 5_000,
      },
    })
  }

  it("add: makes the provider expose the shortcut as a named tool", async () => {
    await seedFullAccessPlatform("gh")
    const add = getPlatformSubCmd("cli-shortcut")

    const out = await captureStdout(
      () =>
        (
          add as unknown as {
            subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
          }
        ).subCommands.add?.run?.(
          ctx({ platform: "gh", descriptor: shortcutDescriptor("pr_list"), json: true }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(0)
    const parsed = JSON.parse(out.trim()) as {
      ok: boolean
      shortcutCount: number
      platform: { cli?: { shortcuts?: Array<{ name: string }> } }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.shortcutCount).toBe(1)
    expect(parsed.platform.cli?.shortcuts?.map((s) => s.name)).toEqual(["pr_list"])

    // Confirm the provider now lists it alongside execute/help (41.3 integration).
    const { createCliProvider } = await import("@junction/core")
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error("db")
    const repos = createRepositories(dbResult.value)
    const got = await repos.platforms.get("gh")
    if (!got.isOk() || !got.value.cli) throw new Error("platform missing")
    const provider = createCliProvider(got.value.cli, null)
    const listResult = await provider.listTools()
    if (!listResult.isOk()) throw new Error("listTools failed")
    expect(listResult.value.map((t) => t.name)).toEqual(["execute", "help", "pr_list"])
  })

  it("remove: drops the shortcut so the provider no longer lists it", async () => {
    await seedFullAccessPlatform("gh")
    const cliShortcut = getPlatformSubCmd("cli-shortcut") as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }

    await captureStdout(
      () =>
        cliShortcut.subCommands.add?.run?.(
          ctx({ platform: "gh", descriptor: shortcutDescriptor("pr_list"), json: true }),
        ) ?? Promise.resolve(),
    )

    const out = await captureStdout(
      () =>
        cliShortcut.subCommands.remove?.run?.(
          ctx({ platform: "gh", name: "pr_list", json: true }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(0)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; shortcutCount: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.shortcutCount).toBe(0)

    const { createCliProvider } = await import("@junction/core")
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error("db")
    const repos = createRepositories(dbResult.value)
    const got = await repos.platforms.get("gh")
    if (!got.isOk() || !got.value.cli) throw new Error("platform missing")
    const provider = createCliProvider(got.value.cli, null)
    const listResult = await provider.listTools()
    if (!listResult.isOk()) throw new Error("listTools failed")
    expect(listResult.value.map((t) => t.name)).toEqual(["execute", "help"])
  })

  it("remove: a nonexistent shortcut name reports a clean error, exitCode 1", async () => {
    await seedFullAccessPlatform("gh")
    const cliShortcut = getPlatformSubCmd("cli-shortcut") as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }
    const out = await captureStdout(
      () =>
        cliShortcut.subCommands.remove?.run?.(
          ctx({ platform: "gh", name: "does_not_exist", json: true }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/no shortcut named/)
  })

  it("add: refuses on a declared-mode cli platform (not-full-access)", async () => {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error("db")
    const repos = createRepositories(dbResult.value)
    await repos.platforms.upsert({
      id: "declared-tool",
      kind: "cli",
      displayName: "Declared Tool",
      cli: {
        tools: [
          {
            name: "echo",
            argv: [
              { kind: "literal", value: "/bin/echo" },
              { kind: "arg", name: "msg" },
            ],
            args: [{ name: "msg", type: "string" }],
            policy: {
              cwd: "/tmp",
              readPaths: ["/tmp"],
              writePaths: [],
              allowNet: [],
              timeoutMs: 5_000,
              envAllow: {},
            },
          },
        ],
      },
    })

    const cliShortcut = getPlatformSubCmd("cli-shortcut") as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }
    const out = await captureStdout(
      () =>
        cliShortcut.subCommands.add?.run?.(
          ctx({
            platform: "declared-tool",
            descriptor: shortcutDescriptor("pr_list"),
            json: true,
          }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/Full CLI access/)
  })

  it("add: platform not found reports a clean error", async () => {
    const cliShortcut = getPlatformSubCmd("cli-shortcut") as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }
    const out = await captureStdout(
      () =>
        cliShortcut.subCommands.add?.run?.(
          ctx({ platform: "nope", descriptor: shortcutDescriptor("pr_list"), json: true }),
        ) ?? Promise.resolve(),
    )
    expect(process.exitCode).toBe(1)
    const parsed = JSON.parse(out.trim()) as { ok: boolean; error?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatch(/not found/)
  })
})
