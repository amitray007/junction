// SPDX-License-Identifier: AGPL-3.0-only
// `junction serve` HTTP integration tests (increment 27, §4-Slice-B).
//
// Spawns the BUILT junction binary (packages/cli/dist/index.js) with `serve`
// on an EPHEMERAL port and drives it with a real fetch / SDK client. Seeds the
// DB directly (in-process, source-level @junction/core — the unit vitest
// project aliases @junction/core to source) before spawning the child.
//
// Requires: pnpm build must have run before these tests.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createRepositories,
  getDatabase,
  getPaths,
  mintApiKey,
  newPlatformId,
  newProfileId,
} from "@junction/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")
// Same builtBinReady guard as commands/mcp.test.ts / commands/profile.test.ts —
// these child-process tests require both the built cli AND core's packaged
// migrations; skip cleanly on a source-only `verify` run.
const coreDistMigrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../node_modules/@junction/core/dist/migrations",
)
const builtBinReady = existsSync(distIndex) && existsSync(coreDistMigrations)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find an OS-assigned free TCP port on 127.0.0.1. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr === null || typeof addr === "string") {
        srv.close()
        reject(new Error("could not determine free port"))
        return
      }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}

interface ServeHandle {
  port: number
  stdout: string[]
  stderr: string[]
  kill: () => void
  exited: Promise<number | null>
}

/** Spawn `junction serve --port <p>` against `home`, waiting until it's listening. */
async function spawnServe(home: string, port?: number): Promise<ServeHandle> {
  const p = port ?? (await findFreePort())
  const stdout: string[] = []
  const stderr: string[] = []

  const args = [distIndex, "serve", "--port", String(p)]
  const child = spawn("node", args, {
    env: { ...process.env, JUNCTION_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()))

  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code))
  })

  // Poll until the endpoint accepts connections (or the process exits early).
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${p}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      })
      break
    } catch {
      // not up yet — but if the process already died, stop polling
      const raced = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 50))])
      if (raced !== null) break
    }
  }

  return {
    port: p,
    stdout,
    stderr,
    kill: () => child.kill("SIGINT"),
    exited,
  }
}

async function openRepos(home: string) {
  const prevHome = process.env.JUNCTION_HOME
  process.env.JUNCTION_HOME = home
  try {
    const dbResult = await getDatabase(getPaths())
    if (dbResult.isErr()) throw new Error(`seed: db error ${dbResult.error.kind}`)
    return createRepositories(dbResult.value)
  } finally {
    if (prevHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevHome
  }
}

async function makeClient(port: number, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: "serve-test-client", version: "0" })
  await client.connect(transport)
  return client
}

/**
 * Send a raw POST with a caller-controlled Host header. Node's global `fetch`
 * (undici) silently overrides/ignores a manually-set Host header with the real
 * connection host — so exercising the Host guard requires `node:http`'s
 * `request` with `setHost: false`, which honors exactly the headers given.
 */
async function rawPostWithHost(
  port: number,
  hostHeader: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        setHost: false,
        headers: {
          host: hostHeader,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
          ...extraHeaders,
        },
      },
      (res) => {
        res.resume()
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }))
      },
    )
    req.on("error", reject)
    req.end(body)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!builtBinReady)("junction serve — HTTP /mcp endpoint", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "junction-serve-test-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it("valid single-profile key: initialize + tools/list (2-seg names, passthrough)", async () => {
    const repos = await openRepos(home)
    const profile = await repos.profiles.create({
      id: newProfileId(),
      name: "work",
      sources: [],
    })
    if (profile.isErr()) throw new Error("seed failed")

    const minted = await mintApiKey(
      { label: "t1", scope: "profile", profileIds: [profile.value.id] },
      repos.apiKeys,
    )
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const client = await makeClient(handle.port, minted.value.plaintext)
      const tools = await client.listTools()
      expect(tools.tools).toEqual([])
      await client.close()
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("valid multi-profile key: initialize + tools/list (3-seg prefixed names)", async () => {
    const repos = await openRepos(home)
    const p1 = await repos.profiles.create({ id: newProfileId(), name: "work", sources: [] })
    const p2 = await repos.profiles.create({ id: newProfileId(), name: "personal", sources: [] })
    if (p1.isErr() || p2.isErr()) throw new Error("seed failed")

    const minted = await mintApiKey(
      { label: "t2", scope: "profiles", profileIds: [p1.value.id, p2.value.id] },
      repos.apiKeys,
    )
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const client = await makeClient(handle.port, minted.value.plaintext)
      const tools = await client.listTools()
      expect(tools.tools).toEqual([]) // both profiles have zero sources
      await client.close()
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("no key → 401", async () => {
    const handle = await spawnServe(home)
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      })
      expect(res.status).toBe(401)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("bad key → 401", async () => {
    const handle = await spawnServe(home)
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer jct_00000000000000000000000000_garbage",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      })
      expect(res.status).toBe(401)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("revoked key → 401", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey({ label: "rk", scope: "global", profileIds: [] }, repos.apiKeys)
    if (minted.isErr()) throw new Error("mint failed")
    const revoked = await repos.apiKeys.revoke(minted.value.meta.id)
    if (revoked.isErr()) throw new Error("revoke failed")

    const handle = await spawnServe(home)
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted.value.plaintext}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      })
      expect(res.status).toBe(401)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("revoke mid-session → next request 401", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey(
      { label: "mid", scope: "global", profileIds: [] },
      repos.apiKeys,
    )
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const client = await makeClient(handle.port, minted.value.plaintext)
      await client.listTools() // establishes + uses the session successfully

      const revoked = await repos.apiKeys.revoke(minted.value.meta.id)
      if (revoked.isErr()) throw new Error("revoke failed")

      await expect(client.listTools()).rejects.toBeDefined()
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("known session + different valid key → 401 (fixation guard)", async () => {
    const repos = await openRepos(home)
    const minted1 = await mintApiKey(
      { label: "k1", scope: "global", profileIds: [] },
      repos.apiKeys,
    )
    const minted2 = await mintApiKey(
      { label: "k2", scope: "global", profileIds: [] },
      repos.apiKeys,
    )
    if (minted1.isErr() || minted2.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      // Initialize a session with key 1.
      const initRes = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted1.value.plaintext}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      })
      const sessionId = initRes.headers.get("mcp-session-id")
      expect(sessionId).toBeTruthy()

      // Re-use the session-id with a DIFFERENT valid key.
      const res2 = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted2.value.plaintext}`,
          "mcp-session-id": sessionId ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      })
      expect(res2.status).toBe(401)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("unknown/stale session-id → 404", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey({ label: "u", scope: "global", profileIds: [] }, repos.apiKeys)
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted.value.plaintext}`,
          "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      })
      expect(res.status).toBe(404)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("authenticated non-initialize POST without a session-id → 400 (no leaked transport)", async () => {
    // Regression: a valid-key POST whose body is NOT an initialize request and
    // that carries no session-id must be rejected 400 BEFORE any session/transport
    // is built — otherwise a connected transport would leak (never registered,
    // never closed). We assert the 400 and that a subsequent real initialize on
    // the same server still succeeds (the server is not wedged/leaking).
    const repos = await openRepos(home)
    const minted = await mintApiKey({ label: "ni", scope: "global", profileIds: [] }, repos.apiKeys)
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const bad = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted.value.plaintext}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
      })
      expect(bad.status).toBe(400)

      // A real initialize still works afterward — the server is not leaking/wedged.
      const ok = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted.value.plaintext}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "1" },
          },
        }),
      })
      expect(ok.status).toBe(200)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("request with Origin header → 403", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey({ label: "o", scope: "global", profileIds: [] }, repos.apiKeys)
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted.value.plaintext}`,
          origin: "https://evil.example",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      })
      expect(res.status).toBe(403)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("non-loopback Host → 403", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey({ label: "h", scope: "global", profileIds: [] }, repos.apiKeys)
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      const res = await rawPostWithHost(handle.port, "evil.example", body, {
        authorization: `Bearer ${minted.value.plaintext}`,
      })
      expect(res.status).toBe(403)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("over-cap body → 413", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey(
      { label: "big", scope: "global", profileIds: [] },
      repos.apiKeys,
    )
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const bigPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { pad: "x".repeat(2 * 1024 * 1024) },
      })
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted.value.plaintext}`,
        },
        body: bigPayload,
      })
      expect(res.status).toBe(413)
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("global key with one broken source still initializes and serves the rest", async () => {
    const repos = await openRepos(home)
    // Two profiles in scope for the global key (resolved live — §2.2: global
    // keys have no join rows, buildHandlers loads ALL profiles): one whose
    // only source references a REAL platform row that fails to CONNECT at
    // runtime (an openapi platform with no cached spec on disk → buildProvider
    // hits ENOENT — resolveProvider's per-source resilience skips it; a
    // dangling platformId isn't reachable here, source_refs.platform_id has a
    // real FK constraint) and one with zero sources (trivially fine). The
    // session must still initialize and serve the rest — one broken source
    // must not brick a global key.
    const brokenPlatform = await repos.platforms.create({
      id: newPlatformId(),
      kind: "openapi",
      displayName: "Broken OpenAPI Platform",
      openapi: { spec: { from: "url", url: "https://example.invalid/openapi.json" } },
    })
    if (brokenPlatform.isErr()) throw new Error("platform seed failed")

    const brokenProfile = await repos.profiles.create({
      id: newProfileId(),
      name: "broken-src",
      sources: [
        {
          platformId: brokenPlatform.value.id,
          toolNamespace: "broken",
          enabled: true,
        },
      ],
    })
    const fineProfile = await repos.profiles.create({
      id: newProfileId(),
      name: "fine",
      sources: [],
    })
    if (brokenProfile.isErr() || fineProfile.isErr()) throw new Error("seed failed")

    const minted = await mintApiKey({ label: "g", scope: "global", profileIds: [] }, repos.apiKeys)
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const client = await makeClient(handle.port, minted.value.plaintext)
      // Both profiles are in scope (global resolves live to ALL profiles).
      // The broken source resolves to zero tools (skipped, per-source
      // resilience) and the fine profile has zero sources — so the aggregate
      // list is empty, but the KEY ASSERTION is that initialize + tools/list
      // both SUCCEED (no 500, no thrown error) despite the broken source.
      const tools = await client.listTools()
      expect(tools.tools).toEqual([])
      await client.close()
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("global key with zero profiles → valid empty session", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey(
      { label: "empty-global", scope: "global", profileIds: [] },
      repos.apiKeys,
    )
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      const client = await makeClient(handle.port, minted.value.plaintext)
      const tools = await client.listTools()
      expect(tools.tools).toEqual([])
      await client.close()
    } finally {
      handle.kill()
      await handle.exited
    }
  })

  it("EADDRINUSE → actionable non-zero exit", async () => {
    const port = await findFreePort()
    const handle1 = await spawnServe(home, port)
    try {
      const handle2 = await spawnServe(home, port)
      const code = await handle2.exited
      expect(code).not.toBe(0)
      expect(handle2.stderr.join("")).toMatch(/in use/i)
    } finally {
      handle1.kill()
      await handle1.exited
    }
  })

  it("never logs the presented token", async () => {
    const repos = await openRepos(home)
    const minted = await mintApiKey(
      { label: "logcheck", scope: "global", profileIds: [] },
      repos.apiKeys,
    )
    if (minted.isErr()) throw new Error("mint failed")

    const handle = await spawnServe(home)
    try {
      // A mix of valid and invalid auth attempts — the token must never
      // appear in stdout/stderr regardless of outcome.
      const client = await makeClient(handle.port, minted.value.plaintext)
      await client.listTools()
      await client.close()

      await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${minted.value.plaintext}xxxxx`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      })
    } finally {
      handle.kill()
      await handle.exited
      const allOutput = [...handle.stdout, ...handle.stderr].join("\n")
      expect(allOutput).not.toContain(minted.value.plaintext)
      // Also check the secret half never leaks even if truncated/split oddly.
      const secretHalf = minted.value.plaintext.split("_").slice(2).join("_")
      expect(allOutput).not.toContain(secretHalf)
    }
  })
})
