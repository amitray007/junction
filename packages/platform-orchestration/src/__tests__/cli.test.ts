// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addCliPlatform } from "../cli.js"

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(path.join(os.tmpdir(), "jx-po-cli-test-"))
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

function descriptorFor(ws2: string) {
  return {
    tools: [
      {
        name: "echo",
        argv: [
          { kind: "literal", value: "/bin/echo" },
          { kind: "arg", name: "msg" },
        ],
        args: [{ name: "msg", type: "string" }],
        policy: {
          cwd: ws2,
          readPaths: [ws2],
          writePaths: [ws2],
          allowNet: [],
          timeoutMs: 5_000,
        },
      },
    ],
  }
}

describe("addCliPlatform", () => {
  it("assembles a Platform from a valid descriptor", async () => {
    const result = await addCliPlatform({
      id: "echo-tool",
      displayName: "Echo Tool",
      descriptor: descriptorFor(ws),
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.platform.kind).toBe("cli")
    expect(result.value.toolCount).toBe(1)
  })

  it("invalid descriptor (not matching CliConnectionSchema) returns invalid-descriptor", async () => {
    const result = await addCliPlatform({
      id: "bad-tool",
      displayName: "Bad Tool",
      descriptor: { tools: "not-an-array" },
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-descriptor")
  })

  it("a tool whose policy escapes readPaths/writePaths returns policy-invalid", async () => {
    const descriptor = descriptorFor(ws)
    // cwd outside the granted read/write paths — validatePolicy must refuse.
    const [tool] = descriptor.tools
    if (!tool) throw new Error("fixture must have one tool")
    tool.policy.cwd = "/"
    const result = await addCliPlatform({
      id: "escape-tool",
      displayName: "Escape Tool",
      descriptor,
    })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("policy-invalid")
    if (result.error.kind !== "policy-invalid") return
    expect(result.error.toolName).toBe("echo")
  })
})
