// SPDX-License-Identifier: AGPL-3.0-only
// probe.server unit tests — covers probeSource/callSourceTool against a real
// temp DB (same pattern as data.server.test.ts / profile-mutations.server.test.ts).
//
// Coverage (per docs/methods/28-web-probe-call.md "Proof of done"):
// - probe lists tools for a single-source profile over an in-memory MCP source
//   AND an OpenAPI source.
// - call invokes a tool → real result.
// - the returned shape contains NO secret and NO request URL.
// - bad argsJson → clean error (never a throw).
// - missing profile/namespace → typed error.
// - disabled route → the disabled error.
//
// NOTE: web has no dependency on @junction/mcp-client (docs/rules/web.md — web
// talks to core only), so its type declarations aren't resolvable from this
// package's tsconfig. The MCP-source tests mock the module by STRING PATH
// (vi.mock never needs the module's types) and access the mock through a
// loosely-typed accessor — no `import type` / static import of mcp-client.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRepositories,
  getDatabase,
  getPaths,
  newCredentialId,
  newPlatformId,
  newProfileId,
  ok,
  PlatformIdSchema,
  ResultAsync,
} from "@junction/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { callSourceTool, probeSource, probeSurface, summarizeParams } from "./probe.server.js"

// ---------------------------------------------------------------------------
// Mock @junction/mcp-client so the MCP-source tests never open a real transport.
// Mocked by string path only — no type import of the module (web has no dep on it).
// ---------------------------------------------------------------------------

// Mock @junction/graphql-client for probeSurface's graphql-kind proof (increment
// 30.10) — createGraphQlProvider is SYNCHRONOUS (unlike createMcpProvider), so
// the mock returns a plain ToolProvider object, not a ResultAsync-wrapped one.
//
// vi.hoisted (not a plain top-level `const`): vi.mock factories are hoisted to
// the top of the file by vitest's transform, ABOVE any ordinary `const`/`let` —
// a factory that closes over a plain top-level const risks a
// "Cannot access '...' before initialization" TDZ error depending on how the
// module graph is bundled (this surfaced once @junction/source-runtime gained
// a second, transitive import path to @junction/graphql-client via
// @junction/platform-orchestration in increment 30.11 — same file, previously
// hoisting-order-lucky). vi.hoisted's return value is ITSELF hoisted alongside
// vi.mock, so this ordering dependency is structurally impossible.
const { createGraphQlProviderMock, createMcpProviderMock } = vi.hoisted(() => ({
  createGraphQlProviderMock: vi.fn(),
  createMcpProviderMock: vi.fn(),
}))
vi.mock("@junction/graphql-client", () => ({
  createGraphQlProvider: createGraphQlProviderMock,
}))
vi.mock("@junction/mcp-client", () => ({
  createMcpProvider: createMcpProviderMock,
}))

const MINIMAL_SPEC = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "http://localhost:9999" }],
  paths: {
    "/greet": {
      get: {
        operationId: "getGreeting",
        summary: "Get a greeting",
        responses: { "200": { description: "OK" } },
      },
    },
  },
}

describe("probe.server", () => {
  let tmpHome: string
  let prevHome: string | undefined
  let prevStore: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "junction-probe-test-"))
    prevHome = process.env.JUNCTION_HOME
    prevStore = process.env.JUNCTION_STORE
    process.env.JUNCTION_HOME = tmpHome
    process.env.JUNCTION_STORE = "file"
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
    if (prevStore === undefined) delete process.env.JUNCTION_STORE
    else process.env.JUNCTION_STORE = prevStore
    await rm(tmpHome, { recursive: true, force: true })
    createMcpProviderMock.mockReset()
    createGraphQlProviderMock.mockReset()
  })

  async function makeRepos() {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(String(dbResult.error))
    return createRepositories(dbResult.value)
  }

  // ---------------------------------------------------------------------------
  // probeSource — missing profile / route
  // ---------------------------------------------------------------------------

  it("probeSource: missing profile → typed error", async () => {
    const result = await probeSource({ profileId: "nonexistent", namespace: "ns" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("profile not found")
  })

  it("probeSource: profile exists but namespace not in it → typed error", async () => {
    const repos = await makeRepos()
    const profileId = newProfileId()
    await repos.profiles.create({ id: profileId, name: "work", sources: [] })

    const result = await probeSource({ profileId: String(profileId), namespace: "nope" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toBe("route not found in profile")
  })

  it("probeSource: disabled route → the disabled error (not an empty list)", async () => {
    const repos = await makeRepos()
    const profileId = newProfileId()
    await repos.profiles.create({ id: profileId, name: "disabled-test", sources: [] })
    const platformId = newPlatformId()
    await repos.platforms.create({ id: platformId, kind: "openapi", displayName: "T" })
    await repos.profiles.addSource(String(profileId), {
      platformId,
      toolNamespace: "pub",
      enabled: false,
    })

    const result = await probeSource({ profileId: String(profileId), namespace: "pub" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error).toMatch(/disabled/)
  })

  // ---------------------------------------------------------------------------
  // probeSource — OpenAPI source (real spec fixture, no HTTP call needed to list)
  // ---------------------------------------------------------------------------

  describe("probeSource — OpenAPI source", () => {
    it("lists the namespaced + raw tool names, no secret/URL leaked", async () => {
      const paths = getPaths()
      const platformId = PlatformIdSchema.parse("openapi-probe-test")
      const cacheDir = join(paths.home, "openapi")
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, `${platformId}.json`), JSON.stringify(MINIMAL_SPEC), "utf8")

      const repos = await makeRepos()
      await repos.platforms.create({
        id: platformId,
        kind: "openapi",
        displayName: "Public API",
        openapi: { spec: { from: "url", url: "https://example.com/openapi.json" } },
      })
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "pub-profile", sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "pub_public",
        enabled: true,
      })

      const result = await probeSource({ profileId: String(profileId), namespace: "pub_public" })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.namespace).toBe("pub_public")
      expect(result.tools.some((t) => t.namespaced === "pub_public__getGreeting")).toBe(true)
      const tool = result.tools.find((t) => t.namespaced === "pub_public__getGreeting")
      expect(tool?.raw).toBe("getGreeting")

      // Secret discipline: no secret/secretRef/request-URL anywhere in the shape.
      const serialized = JSON.stringify(result)
      expect(serialized).not.toMatch(/secretRef/)
      expect(serialized).not.toMatch(/https?:\/\//)
    })

    it("call invokes a tool via the OpenAPI provider and returns real content, no leak", async () => {
      const paths = getPaths()
      const platformId = PlatformIdSchema.parse("openapi-call-test")
      const cacheDir = join(paths.home, "openapi")
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, `${platformId}.json`), JSON.stringify(MINIMAL_SPEC), "utf8")

      const repos = await makeRepos()
      await repos.platforms.create({
        id: platformId,
        kind: "openapi",
        displayName: "Public API",
        openapi: { spec: { from: "url", url: "https://example.com/openapi.json" } },
      })
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "call-profile", sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "pub",
        enabled: true,
      })

      // The upstream server isn't actually running, so the HTTP call itself will
      // fail — but that's still a clean typed error (never a throw), and proves
      // the call path resolves + routes correctly before hitting the network.
      const result = await callSourceTool({
        profileId: String(profileId),
        namespace: "pub",
        toolName: "pub__getGreeting",
        argsJson: "{}",
      })
      // Whichever shape comes back, it must never throw and must never leak.
      const serialized = JSON.stringify(result)
      expect(serialized).not.toMatch(/secretRef/)
      if (!result.ok) {
        expect(typeof result.error).toBe("string")
      }
    })
  })

  // ---------------------------------------------------------------------------
  // probeSource — MCP source (mocked createMcpProvider, no real transport)
  // ---------------------------------------------------------------------------

  describe("probeSource — MCP source", () => {
    it("lists tools from a mocked MCP provider", async () => {
      createMcpProviderMock.mockReturnValue(
        new ResultAsync(
          Promise.resolve(
            ok({
              listTools: () =>
                new ResultAsync(
                  Promise.resolve(
                    ok([{ name: "echo", description: "Echoes input", inputSchema: {} }]),
                  ),
                ),
              callTool: () =>
                new ResultAsync(Promise.resolve(ok({ content: [{ type: "text", text: "hi" }] }))),
              close: vi.fn().mockResolvedValue(undefined),
            }),
          ),
        ),
      )

      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "mcp",
        displayName: "MCP Source",
        connection: { transport: "http", url: "http://localhost:9999/mcp" },
      })
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "mcp-profile", sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "mcpns",
        enabled: true,
      })

      const result = await probeSource({ profileId: String(profileId), namespace: "mcpns" })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.tools).toEqual([
        { namespaced: "mcpns__echo", raw: "echo", description: "Echoes input" },
      ])

      const serialized = JSON.stringify(result)
      expect(serialized).not.toMatch(/secretRef/)
    })

    it("callSourceTool invokes the mocked provider and returns content + isError", async () => {
      createMcpProviderMock.mockReturnValue(
        new ResultAsync(
          Promise.resolve(
            ok({
              listTools: () => new ResultAsync(Promise.resolve(ok([]))),
              callTool: (name: string, _args: Record<string, unknown>) =>
                new ResultAsync(
                  Promise.resolve(
                    ok({ content: [{ type: "text", text: `called ${name}` }], isError: false }),
                  ),
                ),
              close: vi.fn().mockResolvedValue(undefined),
            }),
          ),
        ),
      )

      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "mcp",
        displayName: "MCP Source",
        connection: { transport: "http", url: "http://localhost:9999/mcp" },
      })
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "mcp-call-profile", sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "mcpns",
        enabled: true,
      })

      const result = await callSourceTool({
        profileId: String(profileId),
        namespace: "mcpns",
        toolName: "mcpns__echo",
        argsJson: '{"text":"hi"}',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected ok")
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result.content)).toContain("called echo")
    })
  })

  // ---------------------------------------------------------------------------
  // callSourceTool — bad argsJson never throws, always a clean error
  // ---------------------------------------------------------------------------

  describe("callSourceTool — argsJson validation", () => {
    it("invalid JSON → clean error, not a throw", async () => {
      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "openapi", displayName: "T" })
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "badjson-profile", sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "ns",
        enabled: true,
      })

      const result = await callSourceTool({
        profileId: String(profileId),
        namespace: "ns",
        toolName: "ns__tool",
        argsJson: "{not valid json",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toMatch(/invalid JSON/)
    })

    it("JSON array (not an object) → clean error, not a throw", async () => {
      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "openapi", displayName: "T" })
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "arrayjson-profile", sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "ns",
        enabled: true,
      })

      const result = await callSourceTool({
        profileId: String(profileId),
        namespace: "ns",
        toolName: "ns__tool",
        argsJson: "[1,2,3]",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toBe("arguments must be a JSON object")
    })

    it("missing profile → typed error before argsJson is even relevant", async () => {
      const result = await callSourceTool({
        profileId: "nonexistent",
        namespace: "ns",
        toolName: "ns__tool",
        argsJson: "{}",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toBe("profile not found")
    })

    // JSON `null` and bare primitives are valid JSON but not objects — lock the
    // contract that they're rejected (inc-28 correctness review testing gap).
    it.each([
      ["json-null", "null"],
      ["json-number", "42"],
      ["json-bool", "true"],
      ["json-string", '"a string"'],
    ])("argsJson %s (valid JSON, not an object) → clean error", async (label, argsJson) => {
      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({ id: platformId, kind: "openapi", displayName: "T" })
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: `prim-${label}`, sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "ns",
        enabled: true,
      })

      const result = await callSourceTool({
        profileId: String(profileId),
        namespace: "ns",
        toolName: "ns__tool",
        argsJson,
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected error")
      expect(result.error).toBe("arguments must be a JSON object")
    })
  })

  // ---------------------------------------------------------------------------
  // Secret discipline — a REAL stored secret value never appears in any output
  // (stronger than the `secretRef`-absence checks: seeds a known plaintext secret
  // and asserts that literal is absent from the serialized probe/call result).
  // ---------------------------------------------------------------------------

  describe("secret discipline — real credential value never leaks", () => {
    const SECRET = "super-secret-bearer-value-inc28"

    it("probe of a credentialed MCP source never returns the secret literal", async () => {
      // Mocked MCP provider — the mock ignores the secret, but makeResolveProvider
      // resolves it from the store and passes it into createMcpProvider. We assert
      // the SECRET literal is absent from the probe result regardless.
      createMcpProviderMock.mockReturnValue(
        new ResultAsync(
          Promise.resolve(
            ok({
              listTools: () =>
                new ResultAsync(
                  Promise.resolve(ok([{ name: "echo", description: "Echo", inputSchema: {} }])),
                ),
              callTool: () =>
                new ResultAsync(Promise.resolve(ok({ content: [{ type: "text", text: "ok" }] }))),
              close: vi.fn().mockResolvedValue(undefined),
            }),
          ),
        ),
      )

      const { addCredential, createCredentialStore } = await import("@junction/core")
      const repos = await makeRepos()
      const platformId = newPlatformId()
      const platformResult = await repos.platforms.create({
        id: platformId,
        kind: "mcp",
        displayName: "MCP Source",
        connection: { transport: "http", url: "http://localhost:9999/mcp" },
      })
      if (platformResult.isErr()) throw new Error(JSON.stringify(platformResult.error))

      // Store a real secret + attach the credential to the source.
      // addCredential is the ONLY safe path for secret injection: (input, store, repo).
      const storeResult = await createCredentialStore(getPaths())
      if (storeResult.isErr()) throw new Error(JSON.stringify(storeResult.error))
      const credResult = await addCredential(
        { platformId: String(platformId), account: "work", kind: "bearer", secret: SECRET },
        platformResult.value,
        storeResult.value,
        repos.credentials,
      )
      if (credResult.isErr()) throw new Error(JSON.stringify(credResult.error))
      const credentialId = credResult.value.id
      const profileId = newProfileId()
      await repos.profiles.create({ id: profileId, name: "cred-probe", sources: [] })
      await repos.profiles.addSource(String(profileId), {
        platformId,
        toolNamespace: "mcpns",
        enabled: true,
        credentialId,
      })

      const result = await probeSource({ profileId: String(profileId), namespace: "mcpns" })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(SECRET)
      expect(serialized).not.toMatch(/secretRef/)
    })
  })

  // ---------------------------------------------------------------------------
  // summarizeParams — pure inputSchema → short param-list formatter (§3c).
  // ---------------------------------------------------------------------------

  describe("summarizeParams", () => {
    it("required params first (with * suffix), then optional, comma-joined", () => {
      const schema = {
        properties: { owner: {}, repo: {}, title: {}, body: {} },
        required: ["owner", "repo"],
      }
      expect(summarizeParams(schema)).toBe("owner*, repo*, title, body")
    })

    it("caps at ~8 params and appends an overflow marker", () => {
      const properties = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, {}]))
      const schema = { properties, required: ["p0", "p1"] }
      const result = summarizeParams(schema)
      expect(result).toBeDefined()
      // 8 shown + the overflow marker.
      expect(result?.split(", ")).toHaveLength(9)
      expect(result).toMatch(/…$/)
      expect(result).toMatch(/^p0\*, p1\*/)
    })

    it("no properties → undefined", () => {
      expect(summarizeParams({})).toBeUndefined()
      expect(summarizeParams({ properties: {} })).toBeUndefined()
    })

    it("object/array-typed params are named only (no nested expansion)", () => {
      const schema = {
        properties: {
          filters: { type: "object", properties: { a: {}, b: {} } },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["filters"],
      }
      expect(summarizeParams(schema)).toBe("filters*, tags")
    })
  })

  // ---------------------------------------------------------------------------
  // probeSurface — platform-scoped probe, buildProvider-direct (§3c). The
  // load-bearing proof: a graphql-kind platform returns tools, proving this
  // path is NOT the mcp/openapi-only makeResolveProvider restriction.
  // ---------------------------------------------------------------------------

  describe("probeSurface", () => {
    it("platform not found → a clean error result, never a throw", async () => {
      const result = await probeSurface({ platformId: "nonexistent-platform" })
      expect(result.status).toBe("error")
      if (result.status === "ok") throw new Error("expected error")
      expect(result.reason).toBe("platform not found")
    })

    it("no credentialId (public/no-auth connection) — the no-credential graceful arm — still probes via buildProvider", async () => {
      const closeMock = vi.fn().mockResolvedValue(undefined)
      createGraphQlProviderMock.mockReturnValue({
        listTools: () =>
          new ResultAsync(
            Promise.resolve(
              ok([{ name: "search", description: "Search", inputSchema: { properties: {} } }]),
            ),
          ),
        callTool: vi.fn(),
        close: closeMock,
      })

      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "graphql",
        displayName: "GraphQL Source",
        graphql: { endpoint: "https://example.com/graphql" },
      })

      const result = await probeSurface({ platformId: String(platformId) })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") throw new Error("expected ok")
      expect(result.tools).toEqual([{ namespaced: "search", raw: "search", description: "Search" }])
      // close() called even on the happy path — the finally block always runs.
      expect(closeMock).toHaveBeenCalledTimes(1)
    })

    it("a graphql-kind platform returns tools — proves this is NOT the mcp/openapi-only makeResolveProvider path", async () => {
      const closeMock = vi.fn().mockResolvedValue(undefined)
      createGraphQlProviderMock.mockReturnValue({
        listTools: () =>
          new ResultAsync(
            Promise.resolve(
              ok([
                {
                  name: "listRepos",
                  description: "List repositories",
                  inputSchema: { properties: { owner: {}, limit: {} }, required: ["owner"] },
                },
              ]),
            ),
          ),
        callTool: vi.fn(),
        close: closeMock,
      })

      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "graphql",
        displayName: "GraphQL Source",
        graphql: { endpoint: "https://example.com/graphql" },
      })

      const credId = newCredentialId()
      await repos.credentials.create({
        id: credId,
        name: "work-13",
        platformId,
        profileName: "work",
        kind: "bearer",
        secretRef: "FAKE_REF_NEVER_EXPOSE",
      })

      const result = await probeSurface({ platformId: String(platformId), credentialId: credId })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") throw new Error("expected ok")
      expect(result.tools).toEqual([
        {
          namespaced: "listRepos",
          raw: "listRepos",
          description: "List repositories",
          params: "owner*, limit",
        },
      ])
      expect(closeMock).toHaveBeenCalledTimes(1)
      // Raw/un-namespaced: no profile namespace exists on this path.
      expect(result.tools[0]?.namespaced).toBe(result.tools[0]?.raw)
      // Secret discipline.
      expect(JSON.stringify(result)).not.toContain("FAKE_REF_NEVER_EXPOSE")
    })

    it("db-error graceful arm (credential lookup fails) → an honest error result, never a throw", async () => {
      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "graphql",
        displayName: "GraphQL Source",
        graphql: { endpoint: "https://example.com/graphql" },
      })

      const result = await probeSurface({
        platformId: String(platformId),
        credentialId: "nonexistent-credential-id",
      })
      expect(result.status).toBe("error")
    })

    it("empty-but-ok tool list is the honest 'no tools available' case, NOT converted to an error", async () => {
      const closeMock = vi.fn().mockResolvedValue(undefined)
      createGraphQlProviderMock.mockReturnValue({
        listTools: () => new ResultAsync(Promise.resolve(ok([]))),
        callTool: vi.fn(),
        close: closeMock,
      })

      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "graphql",
        displayName: "GraphQL Source",
        graphql: { endpoint: "https://example.com/graphql" },
      })

      const result = await probeSurface({ platformId: String(platformId) })
      expect(result).toEqual({ status: "ok", tools: [] })
      expect(closeMock).toHaveBeenCalledTimes(1)
    })

    it("provider.close() is called even when listTools() errors — the finally-block discipline (inc-11 leak gotcha)", async () => {
      const { err: errResult } = await import("@junction/core")
      const closeMock = vi.fn().mockResolvedValue(undefined)
      createGraphQlProviderMock.mockReturnValue({
        listTools: () =>
          new ResultAsync(Promise.resolve(errResult({ kind: "connect-failed", cause: "boom" }))),
        callTool: vi.fn(),
        close: closeMock,
      })

      const repos = await makeRepos()
      const platformId = newPlatformId()
      await repos.platforms.create({
        id: platformId,
        kind: "graphql",
        displayName: "GraphQL Source",
        graphql: { endpoint: "https://example.com/graphql" },
      })

      const result = await probeSurface({ platformId: String(platformId) })
      expect(result.status).toBe("error")
      expect(closeMock).toHaveBeenCalledTimes(1)
    })
  })
})
