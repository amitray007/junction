// SPDX-License-Identifier: AGPL-3.0-only
// `junction run` unit tests — drives runCommand.run() directly (in-process,
// mirrors commands/debug.test.ts's ctx()/captureStdout() pattern) against a
// real local OpenAPI upstream (no credential needed — a public source), so
// the full ProfileProxy → code-mode → audit pipeline runs for real.
//
// Covers the method file's proof-of-done: --json structured output, the
// audit.log code_exec + inner tool_call pairing (joined by correlationId),
// and clean typed errors for a bad profile / missing / empty file.

import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import {
  createRepositories,
  getDatabase,
  getPaths,
  newProfileId,
  PlatformIdSchema,
  PlatformSchema,
  readAuditLog,
} from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runCommand } from "./run.js"

// ---------------------------------------------------------------------------
// Local test HTTP server — a real public OpenAPI upstream
// ---------------------------------------------------------------------------

let serverPort = 0
let callCount = 0

const testServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${serverPort}`)
  if (url.pathname === "/greet" && req.method === "GET") {
    callCount += 1
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ greeting: "hello" }))
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

beforeEach(() => {
  callCount = 0
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let prevExitCode: number | undefined

beforeEach(() => {
  prevExitCode = process.exitCode
  process.exitCode = 0
})

afterEach(() => {
  process.exitCode = prevExitCode
})

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

async function runRun(args: {
  file: string
  profile: string
  json?: boolean
  timeout?: string
}): Promise<string> {
  return captureStdout(
    () =>
      runCommand.run?.(
        ctx({
          file: args.file,
          profile: args.profile,
          json: args.json ?? false,
          timeout: args.timeout ?? "",
        }),
      ) ?? Promise.resolve(),
  )
}

/** Seed a profile with one public (credential-free) OpenAPI source. */
async function seedProfileWithOpenApiSource(home: string, profileName: string) {
  const paths = getPaths()
  const dbResult = await getDatabase(paths)
  if (dbResult.isErr()) throw new Error(`DB error: ${dbResult.error.kind}`)
  const repos = createRepositories(dbResult.value)

  const platformId = "pub-api"
  const spec = {
    openapi: "3.0.0",
    info: { title: "Test API", version: "1.0.0" },
    servers: [{ url: `http://localhost:${serverPort}` }],
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
  const cacheDir = join(home, "openapi")
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${platformId}.json`), JSON.stringify(spec), "utf8")

  const platform = PlatformSchema.parse({
    id: PlatformIdSchema.parse(platformId),
    kind: "openapi" as const,
    displayName: "Test OpenAPI",
    openapi: { spec: { from: "url" as const, url: "https://example.com/openapi.json" } },
  })
  const upserted = await repos.platforms.upsert(platform)
  if (upserted.isErr()) throw new Error("platform seed failed")

  const profileResult = await repos.profiles.create({
    id: newProfileId(),
    name: profileName,
    sources: [
      {
        platformId: PlatformIdSchema.parse(platformId),
        toolNamespace: "pub_api",
        enabled: true,
      },
    ],
  })
  if (profileResult.isErr()) throw new Error("profile seed failed")
  return { repos, paths, profile: profileResult.value }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("junction run", () => {
  it("--json: runs a tool call + returns a computed value, audit.log shows tool_call + code_exec", async () => {
    await withTempHome(async (home) => {
      const { paths } = await seedProfileWithOpenApiSource(home, "work")

      const file = join(home, "demo.js")
      // 33f: the facade unwraps the OpenAPI provider's raw
      // "<status> <statusText>\n<body>" MCP content envelope into the
      // parsed JSON body BEFORE the guest ever sees it — no more hand-
      // parsing the envelope or splitting off the status line. This is the
      // exact real-`junction run` reproduction of the orchestrator's QA
      // finding (docs/methods/33f-result-unwrap.md): `tools.pub_api
      // .getGreeting(...).greeting` is directly usable.
      const guestCode = [
        "const body = await tools.pub_api.getGreeting({});",
        "return { shout: body.greeting.toUpperCase(), len: body.greeting.length };",
      ].join("\n")
      await writeFile(file, guestCode, "utf8")

      const out = await captureStdout(
        () =>
          runCommand.run?.(ctx({ file, profile: "work", json: true, timeout: "" })) ??
          Promise.resolve(),
      )

      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(true)
      expect(parsed.value).toEqual({ shout: "HELLO", len: 5 })
      expect(parsed.toolCallCount).toBe(1)
      expect(callCount).toBe(1)
      expect(process.exitCode).toBe(0)

      // Audit log: one code_exec wrapping one tool_call, same correlationId.
      const { entries } = await readAuditLog(paths.auditLogFile)
      const toolCalls = entries.filter((e) => e.event === "tool_call")
      const codeExecs = entries.filter((e) => e.event === "code_exec")
      expect(toolCalls).toHaveLength(1)
      expect(codeExecs).toHaveLength(1)
      expect(toolCalls[0]?.correlationId).toBe(codeExecs[0]?.correlationId)
      expect(codeExecs[0]?.toolCallCount).toBe(1)
      expect(codeExecs[0]?.outcome).toBe("ok")
      if (toolCalls[0]?.event === "tool_call") {
        expect(toolCalls[0].target.profile).toBe("work")
        expect(toolCalls[0].target.namespace).toBe("pub_api")
      }
    })
  })

  it("human mode: pretty-prints the value and a success line", async () => {
    await withTempHome(async (home) => {
      await seedProfileWithOpenApiSource(home, "work")
      const file = join(home, "demo2.js")
      await writeFile(file, "return 1 + 1;", "utf8")

      const out = await runRun({ file, profile: "work" })
      expect(out).toContain("2")
      expect(process.exitCode).toBe(0)
    })
  })

  it("bad profile: clean typed error, not a stack trace", async () => {
    await withTempHome(async (home) => {
      const file = join(home, "demo.js")
      await writeFile(file, "return 1;", "utf8")

      const out = await runRun({ file, profile: "does-not-exist", json: true })
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("does-not-exist")
      expect(parsed.error).not.toContain("at ") // no stack frame text
      expect(process.exitCode).toBe(1)
    })
  })

  it("missing file: clean typed error", async () => {
    await withTempHome(async (home) => {
      const out = await runRun({
        file: join(home, "nope.js"),
        profile: "work",
        json: true,
      })
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("nope.js")
      expect(process.exitCode).toBe(1)
    })
  })

  it("empty file: clean typed error", async () => {
    await withTempHome(async (home) => {
      await seedProfileWithOpenApiSource(home, "work")
      const file = join(home, "empty.js")
      await writeFile(file, "   \n  ", "utf8")

      const out = await runRun({ file, profile: "work", json: true })
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("empty")
      expect(process.exitCode).toBe(1)
    })
  })

  it("invalid --timeout: clean typed error before any I/O", async () => {
    await withTempHome(async (home) => {
      const file = join(home, "demo.js")
      await writeFile(file, "return 1;", "utf8")

      const out = await runRun({ file, profile: "work", json: true, timeout: "not-a-number" })
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("timeout")
      expect(process.exitCode).toBe(1)
    })
  })

  it("guest throw: reported as a clean guest-error outcome, not a crash", async () => {
    await withTempHome(async (home) => {
      await seedProfileWithOpenApiSource(home, "work")
      const file = join(home, "throws.js")
      await writeFile(file, "throw new Error('boom');", "utf8")

      const out = await runRun({ file, profile: "work", json: true })
      const parsed = JSON.parse(out.trim())
      expect(parsed.ok).toBe(false)
      expect(typeof parsed.error).toBe("string")
      expect(process.exitCode).toBe(1)
    })
  })
})
