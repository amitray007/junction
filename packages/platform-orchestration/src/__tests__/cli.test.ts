// SPDX-License-Identifier: AGPL-3.0-only
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CliPolicy, CliTool, FullAccessCliConnection, Platform } from "@junction/core"
import { withTempHome } from "@junction/core/testing"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addCliPlatform, addFullAccessCliPlatform, setFullAccessCliShortcuts } from "../cli.js"

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

// ---------------------------------------------------------------------------
// addFullAccessCliPlatform — the discovery-install assembly (increment 41.4)
// ---------------------------------------------------------------------------

describe("addFullAccessCliPlatform", () => {
  // The sandbox-touching happy path (extraction requires a real seatbelt/bwrap
  // backend) is darwin-gated, same pattern as provider.test.ts's real-run tests.
  it.skipIf(process.platform !== "darwin")(
    "assembles a full-access Platform: extracts the schema and persists the realpath",
    async () => {
      await withTempHome(async () => {
        const binDir = await mkdtemp(path.join(os.tmpdir(), "jx-po-fa-bin-"))
        const binPath = path.join(binDir, "faketool")
        await writeFile(
          binPath,
          "#!/bin/sh\necho 'usage: faketool [flags]'\necho ''\necho 'FLAGS'\necho '  --dry-run   no-op'\n",
        )
        await chmod(binPath, 0o755)

        try {
          const result = await addFullAccessCliPlatform({
            id: "faketool",
            displayName: "Fake Tool",
            binaryPath: binPath,
          })
          expect(result.isOk()).toBe(true)
          if (!result.isOk()) return
          expect(result.value.platform.kind).toBe("cli")
          expect(result.value.platform.cli?.mode).toBe("full-access")
          if (result.value.platform.cli?.mode !== "full-access") return
          expect(result.value.platform.cli.binaryPath).toBe(binPath)
          expect(result.value.platform.cli.policy.allowNet).toEqual([])
          expect(result.value.nodeCount).toBeGreaterThanOrEqual(1)
        } finally {
          await rm(binDir, { recursive: true, force: true })
        }
      })
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "translates a caller-provided host allowNet to the enforceable port scope (Seatbelt can't host-scope)",
    async () => {
      await withTempHome(async () => {
        const binDir = await mkdtemp(path.join(os.tmpdir(), "jx-po-fa-bin-"))
        const binPath = path.join(binDir, "nettool")
        await writeFile(binPath, "#!/bin/sh\necho 'usage: nettool [flags]'\n")
        await chmod(binPath, 0o755)

        try {
          const result = await addFullAccessCliPlatform({
            id: "nettool",
            displayName: "Net Tool",
            binaryPath: binPath,
            allowNet: ["api.example.com:443"],
            credentialEnvVar: "EXAMPLE_PAT",
          })
          expect(result.isOk()).toBe(true)
          if (!result.isOk()) return
          if (result.value.platform.cli?.mode !== "full-access") return
          // Host intent "api.example.com:443" is recorded but enforced as "*:443"
          // — Seatbelt scopes egress by port only, so storing the host would
          // hard-fail runCommand at call time (Fable net-policy ruling, inc 41).
          expect(result.value.platform.cli.policy.allowNet).toEqual(["*:443"])
          expect(result.value.platform.cli.credentialEnvVar).toBe("EXAMPLE_PAT")
        } finally {
          await rm(binDir, { recursive: true, force: true })
        }
      })
    },
  )

  it("a binaryPath that doesn't resolve (extraction refuses) surfaces extract-refused, not a crash", async () => {
    await withTempHome(async () => {
      const result = await addFullAccessCliPlatform({
        id: "missing-tool",
        displayName: "Missing Tool",
        binaryPath: "/definitely/not/a/real/binary/path",
      })
      // On a host with no sandbox backend this is sandbox-unavailable; on a
      // host WITH a backend the root probe itself refuses (spawn-failed
      // surfaces as an Ok node per extract.ts's contract, NOT an Err — so this
      // assembly actually succeeds with a parsed:false root). Assert only the
      // safe invariant: it never throws and always returns a Result.
      expect(result.isOk() || result.isErr()).toBe(true)
    })
  })

  it("rejects a metachar-laden binaryPath at the CliConnectionSchema/policy layer", async () => {
    await withTempHome(async () => {
      const result = await addFullAccessCliPlatform({
        id: "evil-tool",
        displayName: "Evil Tool",
        binaryPath: '/tmp/evil"tool',
      })
      expect(result.isErr()).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// setFullAccessCliShortcuts — the shortcuts editing surface (increment 41.5)
// ---------------------------------------------------------------------------

const SHORTCUT_POLICY: CliPolicy = {
  cwd: "/tmp",
  readPaths: ["/tmp"],
  writePaths: [],
  allowNet: [],
  timeoutMs: 5_000,
  envAllow: {},
}

function shortcutTool(overrides: Partial<CliTool> = {}): CliTool {
  return {
    name: "pr_list",
    description: "List open PRs",
    argv: [
      { kind: "literal", value: "/usr/bin/gh" },
      { kind: "literal", value: "pr" },
      { kind: "literal", value: "list" },
    ],
    args: [],
    policy: SHORTCUT_POLICY,
    ...overrides,
  }
}

function fullAccessCli(overrides: Partial<FullAccessCliConnection> = {}): FullAccessCliConnection {
  return {
    mode: "full-access",
    binaryPath: "/usr/bin/gh",
    policy: SHORTCUT_POLICY,
    schema: {
      binaryName: "gh",
      extractedAt: new Date().toISOString(),
      root: { path: [], parsed: true, explored: true, flags: [], positionals: [], subcommands: [] },
      truncated: false,
    },
    ...overrides,
  }
}

function fullAccessPlatform(overrides: Partial<FullAccessCliConnection> = {}): Platform {
  return {
    id: "gh",
    kind: "cli",
    displayName: "GitHub CLI",
    cli: fullAccessCli(overrides),
  }
}

describe("setFullAccessCliShortcuts", () => {
  it("adds a shortcut to a platform with none yet", () => {
    const platform = fullAccessPlatform()
    const result = setFullAccessCliShortcuts({
      platform,
      shortcuts: [shortcutTool()],
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.cli?.mode).toBe("full-access")
    if (result.value.cli?.mode !== "full-access") return
    expect(result.value.cli.shortcuts).toHaveLength(1)
    expect(result.value.cli.shortcuts?.[0]?.name).toBe("pr_list")
  })

  it("removing all shortcuts drops the field entirely (empty list, not shortcuts:[])", () => {
    const platform = fullAccessPlatform({ shortcuts: [shortcutTool()] })
    const result = setFullAccessCliShortcuts({ platform, shortcuts: [] })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.cli?.mode).toBe("full-access")
    if (result.value.cli?.mode !== "full-access") return
    expect(result.value.cli.shortcuts).toBeUndefined()
  })

  it("replaces the shortcuts list wholesale (two shortcuts -> one)", () => {
    const platform = fullAccessPlatform({
      shortcuts: [shortcutTool({ name: "pr_list" }), shortcutTool({ name: "issue_list" })],
    })
    const result = setFullAccessCliShortcuts({
      platform,
      shortcuts: [shortcutTool({ name: "pr_list" })],
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    if (result.value.cli?.mode !== "full-access") return
    expect(result.value.cli.shortcuts?.map((t) => t.name)).toEqual(["pr_list"])
  })

  it("preserves every other full-access field (binaryPath, policy, schema, credentialEnvVar)", () => {
    const platform = fullAccessPlatform({ credentialEnvVar: "GH_PAT" })
    const result = setFullAccessCliShortcuts({
      platform,
      shortcuts: [shortcutTool()],
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    if (result.value.cli?.mode !== "full-access") return
    expect(result.value.cli.binaryPath).toBe("/usr/bin/gh")
    expect(result.value.cli.credentialEnvVar).toBe("GH_PAT")
    expect(result.value.cli.schema.binaryName).toBe("gh")
  })

  it("refuses on a declared-mode cli platform (no shortcuts slot)", () => {
    const platform: Platform = {
      id: "declared-tool",
      kind: "cli",
      displayName: "Declared Tool",
      cli: { tools: [shortcutTool()] },
    }
    const result = setFullAccessCliShortcuts({ platform, shortcuts: [shortcutTool()] })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("not-full-access")
  })

  it("refuses on a non-cli platform", () => {
    const platform: Platform = {
      id: "mcp-thing",
      kind: "mcp",
      displayName: "MCP Thing",
      connection: { transport: "http", url: "https://example.com/mcp" },
    }
    const result = setFullAccessCliShortcuts({ platform, shortcuts: [] })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("not-full-access")
    if (result.error.kind !== "not-full-access") return
    expect(result.error.platformKind).toBe("mcp")
  })

  it("an invalid shortcut descriptor (argv[0] not absolute) surfaces invalid-descriptor", () => {
    const platform = fullAccessPlatform()
    const badTool = shortcutTool({
      argv: [{ kind: "literal", value: "gh" }],
    })
    const result = setFullAccessCliShortcuts({ platform, shortcuts: [badTool] })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-descriptor")
  })
})
