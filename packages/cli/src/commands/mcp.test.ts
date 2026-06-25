// SPDX-License-Identifier: AGPL-3.0-only
// CLI mcp serve smoke tests — child-process + stdout-is-MCP-only assertions.
//
// Spawns the BUILT junction binary (packages/cli/dist/index.js) and drives
// a full MCP handshake over stdin/stdout. Verifies:
//   1. `junction mcp serve` completes an MCP initialize handshake.
//   2. tools/list returns an empty tool array.
//   3. stdout carries ONLY valid JSON-RPC frames — no log noise, no stray lines.
//
// Requires: pnpm build must have run before these tests (the CLI child-process
// smoke tests always test the built output, not the TypeScript source).

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withTempHome } from "@junction/core/testing"
import { describe, expect, it } from "vitest"

const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** MCP JSON-RPC initialize request */
const INIT_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
})

/** MCP JSON-RPC initialized notification (required after initialize) */
const INITIALIZED_NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "notifications/initialized",
})

/** MCP JSON-RPC tools/list request */
const LIST_TOOLS_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
})

/**
 * Drive a `junction mcp serve` child process through a full MCP handshake.
 * Returns an array of parsed JSON-RPC frames received on stdout.
 */
async function runMcpHandshake(home: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [distIndex, "mcp", "serve"], {
      env: { ...process.env, JUNCTION_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    })

    const frames: unknown[] = []
    let stdoutBuf = ""
    const stderrLines: string[] = []

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderrLines.push(chunk.toString())
    })

    child.on("error", reject)

    // Write the handshake frames and close stdin to signal end
    child.stdin.write(`${INIT_REQUEST}\n`)
    child.stdin.write(`${INITIALIZED_NOTIFICATION}\n`)
    child.stdin.write(`${LIST_TOOLS_REQUEST}\n`)
    child.stdin.end()

    child.on("close", () => {
      // Parse stdout line by line — every non-empty line must be valid JSON-RPC
      const lines = stdoutBuf.split("\n").filter((l) => l.trim().length > 0)
      for (const line of lines) {
        try {
          frames.push(JSON.parse(line))
        } catch {
          reject(new Error(`Non-JSON-RPC line on stdout: ${JSON.stringify(line)}`))
          return
        }
      }
      resolve(frames)
    })

    // Safety timeout — kill after 10s if the process doesn't close
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("MCP handshake timed out after 10s"))
    }, 10_000)

    child.on("close", () => clearTimeout(timer))
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("junction mcp serve", () => {
  it("completes MCP initialize handshake and returns empty tools/list", async () => {
    await withTempHome(async (home) => {
      const frames = await runMcpHandshake(home)

      // Must have received at least 2 frames: initialize result + tools/list result
      expect(frames.length).toBeGreaterThanOrEqual(2)

      // First frame: initialize result (id:1)
      const initResult = frames.find(
        (f) => typeof f === "object" && f !== null && "id" in f && (f as { id: unknown }).id === 1,
      )
      expect(initResult).toBeDefined()
      expect(initResult).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({
          protocolVersion: expect.any(String),
          serverInfo: expect.objectContaining({ name: "junction" }),
        }),
      })

      // tools/list result (id:2) — must have empty tools array
      const toolsResult = frames.find(
        (f) => typeof f === "object" && f !== null && "id" in f && (f as { id: unknown }).id === 2,
      )
      expect(toolsResult).toBeDefined()
      expect(toolsResult).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [] },
      })
    })
  })

  it("stdout contains ONLY valid JSON-RPC frames (no log noise)", async () => {
    await withTempHome(async (home) => {
      // runMcpHandshake already asserts every stdout line is valid JSON.
      // If it resolves, the assertion holds. If any stray line exists, it rejects.
      await expect(runMcpHandshake(home)).resolves.toBeDefined()
    })
  })
})
