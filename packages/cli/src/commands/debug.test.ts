// SPDX-License-Identifier: AGPL-3.0-only
// debug command tests — probe (any source), call (any source), mcp-probe alias.
//
// Strategy:
//   OpenAPI paths: real local HTTP server + spec file written to the temp home dir.
//   MCP paths:     @junction/mcp-client mocked so createMcpProvider returns a stub.
//   DB setup:      real DB in temp home via createRepositories + repos.platforms.upsert.
//
// SECURITY assertions: sentinel secret must NOT appear in stdout or JSON content.

import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import {
  addCredential,
  createCredentialStore,
  createRepositories,
  err,
  getDatabase,
  getPaths,
  ok,
  PlatformIdSchema,
  PlatformSchema,
  ResultAsync,
  type ToolProvider,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { debugCommand } from "./debug.js"

// ---------------------------------------------------------------------------
// Mock @junction/mcp-client so MCP tests never open a real transport
// ---------------------------------------------------------------------------

vi.mock("@junction/mcp-client", () => ({
  createMcpProvider: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Sentinel secret — MUST NOT appear in any command output
// ---------------------------------------------------------------------------

const SENTINEL_SECRET = "s3cr3t-sentinel-xyz987" // gitleaks:allow

// ---------------------------------------------------------------------------
// Local test HTTP server (for OpenAPI integration tests)
// ---------------------------------------------------------------------------

let serverPort = 0

const testServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${serverPort}`)
  const path = url.pathname

  if (path === "/greet" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ greeting: "Hello, World!" }))
    return
  }

  res.writeHead(404)
  res.end("not found")
})

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      testServer.listen(0, () => {
        serverPort = (testServer.address() as AddressInfo).port
        resolve()
      })
    }),
)

afterAll(() => new Promise<void>((resolve) => testServer.close(() => resolve())))

// ---------------------------------------------------------------------------
// Reset env + process.exitCode between tests
// ---------------------------------------------------------------------------

let prevStore: string | undefined
let prevExitCode: number | undefined

beforeEach(() => {
  prevStore = process.env.JUNCTION_STORE
  prevExitCode = process.exitCode
  process.env.JUNCTION_STORE = "file"
  process.exitCode = 0
})

afterEach(() => {
  if (prevStore === undefined) delete process.env.JUNCTION_STORE
  else process.env.JUNCTION_STORE = prevStore
  process.exitCode = prevExitCode
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
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
function ctx<T extends Record<string, unknown>>(args: T) {
  return { args, cmd: {} as never, rawArgs: [] as string[] }
}

/** Access a subcommand's run function from debugCommand. */
function getSubCmd(name: string) {
  const subs = (
    debugCommand as unknown as {
      subCommands: Record<string, { run?: (c: unknown) => Promise<void> }>
    }
  ).subCommands
  const cmd = subs[name]
  if (!cmd) throw new Error(`subcommand "${name}" not found`)
  return cmd
}

/** Build an OpenAPI 3.0 spec pointing at our local test server. */
function makeTestSpec(port: number) {
  return {
    openapi: "3.0.0",
    info: { title: "Test API", version: "1.0.0" },
    servers: [{ url: `http://localhost:${port}` }],
    paths: {
      "/greet": {
        get: {
          operationId: "getGreeting",
          summary: "Get a greeting",
          parameters: [],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  }
}

/** Write the spec cache and upsert the platform into the temp-home DB. */
async function setupOpenApiPlatform(home: string, platformId: string) {
  const paths = getPaths()
  const dbResult = await getDatabase(paths)
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = createRepositories(dbResult.value)

  const spec = makeTestSpec(serverPort)
  const cacheDir = join(home, "openapi")
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${platformId}.json`), JSON.stringify(spec), "utf8")

  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "openapi" as const,
    displayName: "Test OpenAPI",
    openapi: { spec: { from: "url" as const, url: "https://example.com/openapi.json" } },
  })
  await repos.platforms.upsert(platform)
  return { repos, paths, platform }
}

/** Setup an MCP platform in the temp-home DB. */
async function setupMcpPlatform(platformId: string) {
  const paths = getPaths()
  const dbResult = await getDatabase(paths)
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = createRepositories(dbResult.value)

  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "mcp" as const,
    displayName: "Test MCP",
    connection: { transport: "http" as const, url: "http://localhost:19999/mcp" },
  })
  await repos.platforms.upsert(platform)
  return { repos, paths, platform }
}

// ---------------------------------------------------------------------------
// debug probe — OpenAPI integration
// ---------------------------------------------------------------------------

describe("debug probe — OpenAPI", () => {
  it("lists tools with both raw and namespaced names in JSON output", async () => {
    await withTempHome(async (home) => {
      await setupOpenApiPlatform(home, "pub-api")
      const probe = getSubCmd("probe")

      const out = await captureStdout(
        () =>
          probe.run?.(ctx({ platform: "pub-api", credential: undefined, json: true })) ??
          Promise.resolve(),
      )

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(true)
      expect(parsed.namespace).toBe("pub_api_public")
      expect(Array.isArray(parsed.tools)).toBe(true)
      const tool = (parsed.tools as Array<{ raw: string; namespaced: string }>)[0]
      expect(tool?.raw).toBe("getGreeting")
      expect(tool?.namespaced).toBe("pub_api_public__getGreeting")
      expect(parsed.skippedCount).toBe(0)
    })
  })

  it("no-credential path: works without touching the credential store", async () => {
    await withTempHome(async (home) => {
      await setupOpenApiPlatform(home, "pub-api")
      const probe = getSubCmd("probe")

      // Run with no credential — should succeed (public path).
      const out = await captureStdout(
        () =>
          probe.run?.(ctx({ platform: "pub-api", credential: undefined, json: true })) ??
          Promise.resolve(),
      )
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(true)
      expect(parsed.tools.length).toBeGreaterThan(0)
    })
  })

  it("provider is closed after listing tools", async () => {
    await withTempHome(async (home) => {
      await setupOpenApiPlatform(home, "pub-api")
      const probe = getSubCmd("probe")

      // Should complete without leak — if close() is not called, the test
      // runner would hang on a dangling timer/connection (the inc-11 gotcha).
      await expect(
        captureStdout(
          () =>
            probe.run?.(ctx({ platform: "pub-api", credential: undefined, json: true })) ??
            Promise.resolve(),
        ),
      ).resolves.toBeDefined()
    })
  })
})

// ---------------------------------------------------------------------------
// debug probe — MCP (mocked createMcpProvider)
// ---------------------------------------------------------------------------

describe("debug probe — MCP (mocked)", () => {
  it("lists tools for an in-memory MCP source (via mocked createMcpProvider)", async () => {
    await withTempHome(async () => {
      await setupMcpPlatform("test-mcp")

      // Inject a stub ToolProvider via the mocked createMcpProvider.
      const { createMcpProvider } = await import("@junction/mcp-client")
      const stubClose = vi.fn().mockResolvedValue(undefined)
      const stubProvider: ToolProvider = {
        listTools: () =>
          new ResultAsync(
            Promise.resolve(
              ok([
                {
                  name: "doSomething",
                  description: "Does something",
                  inputSchema: { type: "object" as const },
                },
                { name: "doAnotherThing", inputSchema: { type: "object" as const } },
              ]),
            ),
          ),
        callTool: () =>
          new ResultAsync(Promise.resolve(ok({ content: [{ type: "text", text: "result" }] }))),
        close: stubClose,
      }
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(Promise.resolve(ok(stubProvider))),
      )

      const probe = getSubCmd("probe")
      const out = await captureStdout(
        () =>
          probe.run?.(ctx({ platform: "test-mcp", credential: undefined, json: true })) ??
          Promise.resolve(),
      )

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(true)
      expect(parsed.tools.length).toBe(2)
      const names = (parsed.tools as Array<{ raw: string }>).map((t) => t.raw)
      expect(names).toContain("doSomething")
      expect(names).toContain("doAnotherThing")

      // Provider must be closed after listing.
      expect(stubClose).toHaveBeenCalledTimes(1)
    })
  })

  it("provider is closed even when listTools returns an error", async () => {
    await withTempHome(async () => {
      await setupMcpPlatform("test-mcp")

      const { createMcpProvider } = await import("@junction/mcp-client")
      const stubClose = vi.fn().mockResolvedValue(undefined)
      const stubProvider: ToolProvider = {
        listTools: () =>
          new ResultAsync(
            Promise.resolve(err({ kind: "upstream-unavailable" as const, cause: "boom" })),
          ),
        callTool: () =>
          new ResultAsync(Promise.resolve(ok({ content: [{ type: "text", text: "x" }] }))),
        close: stubClose,
      }
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(Promise.resolve(ok(stubProvider))),
      )

      const probe = getSubCmd("probe")
      await captureStdout(
        () =>
          probe.run?.(ctx({ platform: "test-mcp", credential: undefined, json: true })) ??
          Promise.resolve(),
      )

      // close() must run in finally even though listTools errored (inc-11 hang guard).
      expect(stubClose).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// debug call — OpenAPI integration
// ---------------------------------------------------------------------------

describe("debug call — OpenAPI", () => {
  it("invokes getGreeting tool → real HTTP response, exit 0", async () => {
    await withTempHome(async (home) => {
      await setupOpenApiPlatform(home, "pub-api")
      const call = getSubCmd("call")

      const out = await captureStdout(
        () =>
          call.run?.(
            ctx({
              platform: "pub-api",
              credential: undefined,
              tool: "getGreeting",
              args: "{}",
              json: true,
            }),
          ) ?? Promise.resolve(),
      )

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(true)
      expect(parsed.isError).toBe(false)
      // content should contain the response text from the server
      const content = parsed.content as Array<{ type: string; text: string }>
      expect(Array.isArray(content)).toBe(true)
      // The response text starts with "200 OK\n..."
      expect(content[0]?.text).toMatch(/^200/)
    })
  })

  it("no-credential path works (public source, no credential)", async () => {
    await withTempHome(async (home) => {
      await setupOpenApiPlatform(home, "pub-api")
      const call = getSubCmd("call")

      const out = await captureStdout(
        () =>
          call.run?.(
            ctx({
              platform: "pub-api",
              credential: undefined,
              tool: "getGreeting",
              args: "{}",
              json: true,
            }),
          ) ?? Promise.resolve(),
      )
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(true)
    })
  })

  it("SECURITY: sentinel secret does not appear in stdout output", async () => {
    await withTempHome(async (home) => {
      const { repos, paths } = await setupOpenApiPlatform(home, "sec-api")

      // Add a credential with the sentinel secret.
      const storeResult = await createCredentialStore(paths)
      expect(storeResult.isOk()).toBe(true)
      if (storeResult.isErr()) return
      const addResult = await addCredential(
        { platformId: "sec-api", account: "test", kind: "bearer", secret: SENTINEL_SECRET },
        storeResult.value,
        repos.credentials,
      )
      expect(addResult.isOk()).toBe(true)
      if (addResult.isErr()) return
      const credential = addResult.value

      const call = getSubCmd("call")
      const out = await captureStdout(
        () =>
          call.run?.(
            ctx({
              platform: "sec-api",
              credential: credential.id,
              tool: "getGreeting",
              args: "{}",
              json: true,
            }),
          ) ?? Promise.resolve(),
      )

      // The sentinel MUST NOT appear anywhere in the output.
      expect(out).not.toContain(SENTINEL_SECRET)
      // The request URL (localhost:PORT/greet) MUST NOT appear in the output.
      expect(out).not.toContain(`localhost:${serverPort}`)
    })
  })

  it("bad --args (invalid JSON) → invalid-args error, no throw", async () => {
    await withTempHome(async (home) => {
      await setupOpenApiPlatform(home, "pub-api")
      const call = getSubCmd("call")

      const savedCode = process.exitCode
      const out = await captureStdout(
        () =>
          call.run?.(
            ctx({
              platform: "pub-api",
              credential: undefined,
              tool: "getGreeting",
              args: "{not valid json",
              json: true,
            }),
          ) ?? Promise.resolve(),
      )

      expect(process.exitCode).not.toBe(0)
      process.exitCode = savedCode

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toMatch(/invalid tool arguments/)
    })
  })

  it("bad --args (JSON array, not object) → invalid-args error", async () => {
    await withTempHome(async (home) => {
      await setupOpenApiPlatform(home, "pub-api")
      const call = getSubCmd("call")

      const savedCode = process.exitCode
      const out = await captureStdout(
        () =>
          call.run?.(
            ctx({
              platform: "pub-api",
              credential: undefined,
              tool: "getGreeting",
              args: "[1,2,3]",
              json: true,
            }),
          ) ?? Promise.resolve(),
      )

      expect(process.exitCode).not.toBe(0)
      process.exitCode = savedCode

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toMatch(/invalid tool arguments/)
    })
  })

  it("provider is closed even when callTool returns an error", async () => {
    await withTempHome(async () => {
      await setupMcpPlatform("fail-mcp")

      // Stub provider where callTool returns an error but close is tracked.
      const { createMcpProvider } = await import("@junction/mcp-client")
      const stubClose = vi.fn().mockResolvedValue(undefined)
      const stubProvider: ToolProvider = {
        listTools: () => new ResultAsync(Promise.resolve(ok([]))),
        callTool: (_name, _args) =>
          new ResultAsync(
            Promise.resolve(err({ kind: "tool-not-found" as const, name: "bad-tool" })),
          ),
        close: stubClose,
      }
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(Promise.resolve(ok(stubProvider))),
      )

      const call = getSubCmd("call")
      const savedCode = process.exitCode
      await captureStdout(
        () =>
          call.run?.(
            ctx({
              platform: "fail-mcp",
              credential: undefined,
              tool: "bad-tool",
              args: "{}",
              json: true,
            }),
          ) ?? Promise.resolve(),
      )
      process.exitCode = savedCode

      // close() must have been called even though callTool returned an error.
      expect(stubClose).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// debug mcp-probe — deprecated alias
// ---------------------------------------------------------------------------

describe("debug mcp-probe (deprecated alias)", () => {
  it("lists tools AND emits the deprecation note on stderr", async () => {
    await withTempHome(async () => {
      await setupMcpPlatform("test-mcp")

      const { createMcpProvider } = await import("@junction/mcp-client")
      const stubProvider: ToolProvider = {
        listTools: () =>
          new ResultAsync(
            Promise.resolve(ok([{ name: "echo", inputSchema: { type: "object" as const } }])),
          ),
        callTool: () => new ResultAsync(Promise.resolve(ok({ content: [] }))),
        close: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(createMcpProvider).mockReturnValue(
        new ResultAsync(Promise.resolve(ok(stubProvider))),
      )

      const mcpProbe = getSubCmd("mcp-probe")
      let stdoutOut = ""
      let stderrOut = ""

      // Capture both streams simultaneously.
      const stderrChunks: string[] = []
      const stdoutChunks: string[] = []
      const origStdout = process.stdout.write.bind(process.stdout)
      const origStderr = process.stderr.write.bind(process.stderr)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
        return true
      }) as NodeJS.WriteStream["write"]
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
        return true
      }) as NodeJS.WriteStream["write"]

      try {
        await mcpProbe.run?.(ctx({ platform: "test-mcp", credential: undefined, json: true }))
      } finally {
        process.stdout.write = origStdout
        process.stderr.write = origStderr
      }

      stdoutOut = stdoutChunks.join("")
      stderrOut = stderrChunks.join("")

      // Deprecation note must be on stderr.
      expect(stderrOut).toContain("deprecated")
      expect(stderrOut).toContain("debug probe")

      // Tool listing should still work.
      const parsed = JSON.parse(stdoutOut.trim())
      expect(parsed.ok).toBe(true)
      expect(parsed.tools.length).toBe(1)
      const tool = (parsed.tools as Array<{ raw: string }>)[0]
      expect(tool?.raw).toBe("echo")
    })
  })
})
