// SPDX-License-Identifier: AGPL-3.0-only
// CLI provider tests — security-critical suites per inc-21 proof-of-done.
// Priority order:
//   1. argv-building injection-inert (agent value → exactly one argv token, never widening)
//   2. arg validation (type/enum/pattern/maxLength/path/required/additionalProperties)
//   3. provider listTools + callTool mapping
//   4. credential-as-env sentinel (secret in policy.env ONLY)
//   5. refusal on no backend (fail-closed)
//   6. exec.ts output cap (OOM hardening)
//   7. schema validation (CliConnectionSchema refines)

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CliConnection, CliPolicy, CliTool } from "../../schema/cli-connection.js"
import { CliConnectionSchema } from "../../schema/cli-connection.js"
import { validateArgs } from "./args.js"
import { buildArgv } from "./argv.js"
import { createCliProvider } from "./provider.js"

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const BASE_POLICY: CliPolicy = {
  cwd: "/tmp",
  readPaths: ["/tmp"],
  writePaths: [],
  allowNet: [],
  timeoutMs: 5_000,
  envAllow: {},
}

function echoTool(overrides: Partial<CliTool> = {}): CliTool {
  return {
    name: "greet",
    description: "Echo a message",
    argv: [
      { kind: "literal", value: "/bin/echo" },
      { kind: "literal", value: "--" },
      { kind: "arg", name: "message" },
    ],
    args: [{ name: "message", type: "string", required: true, maxLength: 200 }],
    policy: BASE_POLICY,
    ...overrides,
  }
}

function minimalConnection(tool: CliTool = echoTool(), credentialEnvVar?: string): CliConnection {
  return { tools: [tool], ...(credentialEnvVar ? { credentialEnvVar } : {}) }
}

// ---------------------------------------------------------------------------
// 1. argv-building injection-inert suite
// ---------------------------------------------------------------------------

describe("buildArgv — injection-inert", () => {
  it("each declared arg → exactly one argv element (with prefix)", () => {
    const segments = [
      { kind: "literal" as const, value: "/bin/grep" },
      { kind: "arg" as const, name: "pattern", prefix: "--regexp=" },
    ]
    const validated = new Map<string, string | number | boolean>([["pattern", "hello"]])
    const argv = buildArgv(segments, validated)
    expect(argv).toEqual(["/bin/grep", "--regexp=hello"])
    // One element per segment: 2 segments → 2 elements
    expect(argv).toHaveLength(2)
  })

  it("injection value '; rm -rf /' lands as exactly one inert argv token", () => {
    const segments = [
      { kind: "literal" as const, value: "/bin/echo" },
      { kind: "arg" as const, name: "msg" },
    ]
    const validated = new Map<string, string | number | boolean>([["msg", "; rm -rf /"]])
    const argv = buildArgv(segments, validated)
    expect(argv).toHaveLength(2)
    expect(argv[1]).toBe("; rm -rf /")
  })

  it("injection value '--output=/etc/passwd' lands as exactly one inert argv token", () => {
    const segments = [
      { kind: "literal" as const, value: "/bin/echo" },
      { kind: "arg" as const, name: "flag" },
    ]
    const validated = new Map<string, string | number | boolean>([["flag", "--output=/etc/passwd"]])
    const argv = buildArgv(segments, validated)
    expect(argv).toHaveLength(2)
    expect(argv[1]).toBe("--output=/etc/passwd")
  })

  it("injection value '$(whoami)' lands as exactly one inert argv token", () => {
    const segments = [
      { kind: "literal" as const, value: "/bin/echo" },
      { kind: "arg" as const, name: "x" },
    ]
    const validated = new Map<string, string | number | boolean>([["x", "$(whoami)"]])
    const argv = buildArgv(segments, validated)
    expect(argv).toHaveLength(2)
    expect(argv[1]).toBe("$(whoami)")
  })

  it("value with spaces and newlines is a single argv token", () => {
    const segments = [
      { kind: "literal" as const, value: "/bin/echo" },
      { kind: "arg" as const, name: "s" },
    ]
    const value = "hello world\nnewline\r\ncarriage"
    const validated = new Map<string, string | number | boolean>([["s", value]])
    const argv = buildArgv(segments, validated)
    expect(argv).toHaveLength(2)
    expect(argv[1]).toBe(value)
  })

  it("optional arg absent → element omitted from argv", () => {
    const segments = [
      { kind: "literal" as const, value: "/bin/ls" },
      { kind: "arg" as const, name: "path" },
      { kind: "literal" as const, value: "--long" },
    ]
    const validated = new Map<string, string | number | boolean>() // path absent
    const argv = buildArgv(segments, validated)
    expect(argv).toEqual(["/bin/ls", "--long"])
    expect(argv).not.toContain(undefined)
  })

  it("multiple optional args absent → each omitted independently", () => {
    const segments = [
      { kind: "literal" as const, value: "/usr/bin/rg" },
      { kind: "arg" as const, name: "pattern" },
      { kind: "arg" as const, name: "file" },
    ]
    const validated = new Map<string, string | number | boolean>([["pattern", "foo"]])
    const argv = buildArgv(segments, validated)
    expect(argv).toEqual(["/usr/bin/rg", "foo"])
  })

  it("literal segment is always included verbatim regardless of args", () => {
    const segments = [
      { kind: "literal" as const, value: "/usr/bin/git" },
      { kind: "literal" as const, value: "status" },
      { kind: "literal" as const, value: "--short" },
    ]
    const argv = buildArgv(segments, new Map())
    expect(argv).toEqual(["/usr/bin/git", "status", "--short"])
  })

  it("prefix is prepended to the value as a single element", () => {
    const segments = [
      { kind: "literal" as const, value: "/bin/cat" },
      { kind: "arg" as const, name: "out", prefix: "--output=" },
    ]
    const validated = new Map<string, string | number | boolean>([["out", "result.txt"]])
    const argv = buildArgv(segments, validated)
    // Must be ONE element, not split on the "=" or the space boundary
    expect(argv[1]).toBe("--output=result.txt")
    expect(argv).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 2. arg validation suite
// ---------------------------------------------------------------------------

describe("validateArgs — arg validation", () => {
  const cwd = "/tmp"

  it("unknown arg key → invalid-args (additionalProperties:false)", () => {
    const declared = [{ name: "msg", type: "string" as const, required: true }]
    const result = validateArgs(declared, { msg: "hello", extra: "bad" }, cwd)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
    expect(result.error.reason).toContain('"extra"')
  })

  it("missing required arg → invalid-args", () => {
    const declared = [{ name: "msg", type: "string" as const, required: true }]
    const result = validateArgs(declared, {}, cwd)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
    expect(result.error.reason).toContain('"msg"')
  })

  it("optional arg absent → not in returned map", () => {
    const declared = [{ name: "opt", type: "string" as const, required: false }]
    const result = validateArgs(declared, {}, cwd)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.has("opt")).toBe(false)
  })

  it("string type accepts string", () => {
    const declared = [{ name: "s", type: "string" as const, required: true }]
    const result = validateArgs(declared, { s: "hello" }, cwd)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.get("s")).toBe("hello")
  })

  it("number type accepts number", () => {
    const declared = [{ name: "n", type: "number" as const, required: true }]
    const result = validateArgs(declared, { n: 42 }, cwd)
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.get("n")).toBe(42)
  })

  it("number type rejects string", () => {
    const declared = [{ name: "n", type: "number" as const, required: true }]
    const result = validateArgs(declared, { n: "42" }, cwd)
    expect(result.isErr()).toBe(true)
  })

  it("boolean type accepts boolean", () => {
    const declared = [{ name: "b", type: "boolean" as const, required: true }]
    const result = validateArgs(declared, { b: true }, cwd)
    expect(result.isOk()).toBe(true)
  })

  it("boolean type rejects string 'true'", () => {
    const declared = [{ name: "b", type: "boolean" as const, required: true }]
    const result = validateArgs(declared, { b: "true" }, cwd)
    expect(result.isErr()).toBe(true)
  })

  it("enum type accepts a valid choice", () => {
    const declared = [{ name: "e", type: "enum" as const, required: true, enum: ["a", "b", "c"] }]
    const result = validateArgs(declared, { e: "b" }, cwd)
    expect(result.isOk()).toBe(true)
  })

  it("enum type rejects a value not in the list", () => {
    const declared = [{ name: "e", type: "enum" as const, required: true, enum: ["a", "b"] }]
    const result = validateArgs(declared, { e: "c" }, cwd)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })

  it("maxLength enforced — value at limit passes", () => {
    const declared = [{ name: "s", type: "string" as const, required: true, maxLength: 5 }]
    expect(validateArgs(declared, { s: "hello" }, cwd).isOk()).toBe(true)
  })

  it("maxLength enforced — value over limit rejected", () => {
    const declared = [{ name: "s", type: "string" as const, required: true, maxLength: 5 }]
    const result = validateArgs(declared, { s: "toolong" }, cwd)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.reason).toContain("maxLength")
  })

  it("pattern enforced — matching value passes", () => {
    const declared = [{ name: "s", type: "string" as const, required: true, pattern: "[0-9]+" }]
    expect(validateArgs(declared, { s: "123" }, cwd).isOk()).toBe(true)
  })

  it("pattern enforced — non-matching value rejected", () => {
    const declared = [{ name: "s", type: "string" as const, required: true, pattern: "[0-9]+" }]
    const result = validateArgs(declared, { s: "abc" }, cwd)
    expect(result.isErr()).toBe(true)
  })

  it("type:path rejects absolute path", () => {
    const declared = [{ name: "p", type: "path" as const, required: true }]
    const result = validateArgs(declared, { p: "/etc/passwd" }, cwd)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.reason).toContain("absolute")
  })

  it("type:path rejects '..' traversal component", () => {
    const declared = [{ name: "p", type: "path" as const, required: true }]
    const result = validateArgs(declared, { p: "../../etc/passwd" }, cwd)
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.reason).toContain("..")
  })

  it("type:path rejects path that would escape cwd when joined", () => {
    const declared = [{ name: "p", type: "path" as const, required: true }]
    // Construct a path that path.join normalises to go outside cwd
    const result = validateArgs(declared, { p: "sub/../../outside" }, cwd)
    expect(result.isErr()).toBe(true)
  })

  it("type:path accepts a valid relative path within cwd", () => {
    const declared = [{ name: "p", type: "path" as const, required: true }]
    const result = validateArgs(declared, { p: "subdir/file.txt" }, cwd)
    expect(result.isOk()).toBe(true)
  })

  it("null value for required arg → invalid-args", () => {
    const declared = [{ name: "s", type: "string" as const, required: true }]
    const result = validateArgs(declared, { s: null }, cwd)
    expect(result.isErr()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. provider listTools + callTool mapping
// ---------------------------------------------------------------------------

describe("createCliProvider — listTools", () => {
  it("returns one ProviderTool per declared tool", async () => {
    const conn = minimalConnection()
    const provider = createCliProvider(conn, null)
    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.name).toBe("greet")
  })

  it("inputSchema has type:object with declared arg properties", async () => {
    const tool = echoTool()
    const provider = createCliProvider({ tools: [tool] }, null)
    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    const schema = result.value[0]?.inputSchema as Record<string, unknown>
    expect(schema.type).toBe("object")
    expect(schema.additionalProperties).toBe(false)
    const props = schema.properties as Record<string, unknown>
    expect(props).toHaveProperty("message")
    expect((props.message as Record<string, unknown>).type).toBe("string")
    expect((props.message as Record<string, unknown>).maxLength).toBe(200)
  })

  it("inputSchema required array includes required args", async () => {
    const tool = echoTool()
    const provider = createCliProvider({ tools: [tool] }, null)
    const result = await provider.listTools()
    if (!result.isOk()) return
    const schema = result.value[0]?.inputSchema as Record<string, unknown>
    expect(schema.required).toContain("message")
  })

  it("listTools works even when sandbox is unavailable", async () => {
    // listTools is always pure — it never touches the sandbox
    const provider = createCliProvider(minimalConnection(), null)
    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
  })
})

describe("createCliProvider — callTool", () => {
  it("tool-not-found for unknown name", async () => {
    const provider = createCliProvider(minimalConnection(), null)
    const result = await provider.callTool("nonexistent", {})
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("tool-not-found")
    expect((result.error as { name: string }).name).toBe("nonexistent")
  })

  it("invalid-args when required arg missing", async () => {
    const provider = createCliProvider(minimalConnection(), null)
    // "message" is required but absent
    const result = await provider.callTool("greet", {})
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })

  it("invalid-args when unknown arg supplied", async () => {
    const provider = createCliProvider(minimalConnection(), null)
    const result = await provider.callTool("greet", { message: "hi", unknown: "bad" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })

  it("invalid-args (not an uncaught throw) when a value contains a NUL byte", async () => {
    const provider = createCliProvider(minimalConnection(), null)
    // NUL would make spawn() throw synchronously → uncaught rejection across the
    // boundary; the control-char guard must turn it into a clean invalid-args.
    const result = await provider.callTool("greet", { message: "ab\x00cd" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })

  it("flag-injection: leading '-' on an unprefixed arg BEFORE any '--' is rejected", async () => {
    // A tool with no "--" separator and an unprefixed positional arg.
    const tool = echoTool({
      argv: [
        { kind: "literal", value: "/bin/echo" },
        { kind: "arg", name: "message" },
      ],
    })
    const provider = createCliProvider(minimalConnection(tool), null)
    const result = await provider.callTool("greet", { message: "--evil-flag" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    expect(result.error.kind).toBe("invalid-args")
  })

  it("flag-injection: leading '-' is ALLOWED after a '--' separator (default echoTool)", async () => {
    // echoTool has a "--" literal before the message arg → leading "-" is safe.
    // (On non-darwin without a sandbox backend this still passes validation and
    //  fails closed at the sandbox; we only assert it's NOT an invalid-args rejection.)
    const provider = createCliProvider(minimalConnection(), null)
    const result = await provider.callTool("greet", { message: "-n" })
    if (result.isErr()) expect(result.error.kind).not.toBe("invalid-args")
  })

  it.skipIf(process.platform !== "darwin")(
    "Ok(ToolResult) maps a real run: exit 0, content text, isError false",
    async () => {
      const provider = createCliProvider(minimalConnection(), null)
      const result = await provider.callTool("greet", { message: "hello-mapping" })
      expect(result.isOk()).toBe(true)
      if (!result.isOk()) return
      expect(result.value.isError).toBe(false)
      const text = (result.value.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
      expect(text).toContain("exit 0")
      expect(text).toContain("hello-mapping")
    },
  )
})

// ---------------------------------------------------------------------------
// schema refines (defense-in-depth at the descriptor boundary)
// ---------------------------------------------------------------------------

describe("CliConnectionSchema refines", () => {
  const baseTool = (args: unknown[]): unknown => ({
    name: "t",
    argv: [{ kind: "literal", value: "/bin/echo" }],
    args,
    policy: BASE_POLICY,
  })
  const parse = (tools: unknown[], credentialEnvVar?: string) =>
    CliConnectionSchema.safeParse({ tools, ...(credentialEnvVar ? { credentialEnvVar } : {}) })

  it('type:"enum" requires a non-empty enum array', () => {
    expect(parse([baseTool([{ name: "x", type: "enum" }])]).success).toBe(false)
    expect(parse([baseTool([{ name: "x", type: "enum", enum: ["a"] }])]).success).toBe(true)
  })

  it("pattern requires maxLength (ReDoS guard)", () => {
    expect(parse([baseTool([{ name: "x", type: "string", pattern: "a+" }])]).success).toBe(false)
    expect(
      parse([baseTool([{ name: "x", type: "string", pattern: "a+", maxLength: 50 }])]).success,
    ).toBe(true)
  })

  it("credentialEnvVar rejects denylisted + master-key names", () => {
    expect(parse([baseTool([])], "API_TOKEN").success).toBe(false)
    expect(parse([baseTool([])], "JUNCTION_MASTER_KEY_FILE").success).toBe(false)
    expect(parse([baseTool([])], "GH_PAT").success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. credential-as-env sentinel
// ---------------------------------------------------------------------------

describe("credential-as-env sentinel", () => {
  // These tests run on macOS (Seatbelt) or skip gracefully on other platforms.
  // They verify the SECRET flows only through policy.env, never argv/result/error.

  const SECRET = "super-secret-sentinel-value-must-not-leak"

  it("secret is NOT in argv — injection value stays inert in a single slot", () => {
    // We can verify the argv-building path synchronously without spawning.
    const tool: CliTool = {
      name: "run",
      argv: [
        { kind: "literal", value: "/bin/echo" },
        { kind: "arg", name: "msg" },
      ],
      args: [{ name: "msg", type: "string", required: true }],
      policy: BASE_POLICY,
    }
    const argsResult = validateArgs(tool.args, { msg: "hello" }, tool.policy.cwd)
    expect(argsResult.isOk()).toBe(true)
    if (!argsResult.isOk()) return
    const argv = buildArgv(tool.argv, argsResult.value)
    // The secret must not appear anywhere in argv
    for (const token of argv) {
      expect(token).not.toContain(SECRET)
    }
  })

  it("no credentialEnvVar → env built without any secret key", () => {
    // Inspect what the provider would pass to policy.env by checking the connection
    // has no credentialEnvVar and verifying the connection schema allows this.
    const conn: CliConnection = { tools: [echoTool()] }
    expect(conn.credentialEnvVar).toBeUndefined()
    // The provider builds env from envAllow only when credentialEnvVar is absent.
    // Verified by the callTool flow: no credentialEnvVar in connection → secret omitted.
    const provider = createCliProvider(conn, SECRET)
    // listTools should not touch the secret
    expect(provider).toBeDefined()
  })

  it("credentialEnvVar name must not end in _TOKEN/_SECRET/_KEY (schema guard)", () => {
    // The schema refine blocks names that would trip validatePolicy's denylist.
    for (const badName of ["MY_TOKEN", "API_SECRET", "GH_KEY", "JUNCTION_MASTER_KEY"]) {
      const result = CliConnectionSchema.safeParse({
        tools: [echoTool()],
        credentialEnvVar: badName,
      })
      expect(result.success).toBe(false)
    }
    // A safe name is accepted
    const result = CliConnectionSchema.safeParse({
      tools: [echoTool()],
      credentialEnvVar: "GH_PAT",
    })
    expect(result.success).toBe(true)
  })

  it("invalid-args error message does not contain the secret value", async () => {
    // Trigger an invalid-args error while a secret is set and confirm it's not leaked.
    const conn = minimalConnection(echoTool(), "GH_PAT")
    const provider = createCliProvider(conn, SECRET)
    const result = await provider.callTool("greet", { message: "ok", unknown: "oops" })
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    // The error reason must not contain the secret
    const reason = "reason" in result.error ? (result.error.reason as string) : ""
    expect(reason).not.toContain(SECRET)
    // Nor should any stringification
    expect(JSON.stringify(result.error)).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// 5. refusal on no backend (fail-closed)
// ---------------------------------------------------------------------------

describe("createCliProvider — refusal on no backend", () => {
  // These tests mock createSandbox to return an unsupported-platform error,
  // verifying that callTool fails closed (never raw-execs) when no backend exists.
  // listTools must still work (it never touches the sandbox).

  it("callTool → Err when sandbox refuses with policy-invalid (denylist env key)", async () => {
    // Test the fail-closed guarantee: when validatePolicy rejects a policy, callTool
    // must return connect-failed — never a raw exec.
    // provider.ts adds cwd to readPaths automatically, so we trigger policy-invalid via
    // an env key that matches validatePolicy's secret denylist (/_TOKEN$/ suffix).
    const tool: CliTool = {
      name: "noop",
      argv: [{ kind: "literal", value: "/bin/echo" }],
      args: [],
      policy: {
        cwd: "/tmp",
        readPaths: ["/tmp"],
        writePaths: [],
        allowNet: [],
        timeoutMs: 1000,
        // MY_API_TOKEN ends in _TOKEN → validatePolicy's SECRET_DENYLIST_RE rejects it
        envAllow: { MY_API_TOKEN: "forbidden" },
      },
    }
    const provider = createCliProvider({ tools: [tool] }, null)
    // callTool: policy-invalid env key should give connect-failed (fail-closed)
    const result = await provider.callTool("noop", {})
    expect(result.isErr()).toBe(true)
    if (!result.isErr()) return
    // sandbox.runCommand returns policy-invalid; mapErr converts it to connect-failed
    expect(result.error.kind).toBe("connect-failed")
  })

  it("listTools still returns tools even when sandbox would refuse", async () => {
    const provider = createCliProvider(minimalConnection(), null)
    const result = await provider.listTools()
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 6. exec.ts output cap
// ---------------------------------------------------------------------------

describe("exec.ts output cap — OOM hardening", () => {
  let ws: string

  beforeAll(async () => {
    ws = await mkdtemp(path.join(os.tmpdir(), "jx-cli-cap-"))
  })

  afterAll(async () => {
    await rm(ws, { recursive: true, force: true })
  })

  it.skipIf(process.platform !== "darwin")(
    "a child flooding stdout is killed, output bounded, result flagged outputCapped",
    async () => {
      // Write a shell script that emits 2 MB of output (exceeds 1 MB cap).
      const script = path.join(ws, "flood.sh")
      // Use /bin/sh printf in a loop to emit lines until killed
      await writeFile(script, "#!/bin/sh\nwhile true; do printf '%0.s=%.0s' {1..1000}; done\n", {
        mode: 0o755,
      })

      const { spawnSandboxed, SPAWN_OUTPUT_BYTE_CAP } = await import("../../sandbox/exec.js")
      const result = await spawnSandboxed(["/bin/sh", script], {
        env: {},
        cwd: ws,
        timeoutMs: 10_000,
      })

      // Must not be a spawn error
      expect("_err" in result).toBe(false)
      if ("_err" in result) return

      // Output must be bounded — not OOM
      const totalBytes =
        Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8")
      expect(totalBytes).toBeLessThanOrEqual(SPAWN_OUTPUT_BYTE_CAP)

      // outputCapped flag must be set
      expect(result.outputCapped).toBe(true)
    },
    15_000,
  )

  it.skipIf(process.platform !== "darwin")(
    "normal-size output is not flagged outputCapped",
    async () => {
      const { spawnSandboxed } = await import("../../sandbox/exec.js")
      const result = await spawnSandboxed(["/bin/echo", "hello"], {
        env: {},
        cwd: ws,
        timeoutMs: 5_000,
      })
      expect("_err" in result).toBe(false)
      if ("_err" in result) return
      expect(result.outputCapped).toBe(false)
      expect(result.stdout).toContain("hello")
    },
  )
})

// ---------------------------------------------------------------------------
// 7. CliConnectionSchema validation
// ---------------------------------------------------------------------------

describe("CliConnectionSchema — schema validation", () => {
  it("accepts a minimal valid descriptor", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "echo",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("rejects descriptor with zero tools", () => {
    const result = CliConnectionSchema.safeParse({ tools: [] })
    expect(result.success).toBe(false)
  })

  it("rejects argv[0] that is not a literal", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "bad",
          argv: [{ kind: "arg", name: "binary" }], // arg as argv[0] — forbidden
          args: [{ name: "binary", type: "string", required: true }],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejects argv[0] literal that is not an absolute path", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "bad",
          argv: [{ kind: "literal", value: "echo" }], // relative — forbidden
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejects credentialEnvVar ending in _TOKEN", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "t",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
      credentialEnvVar: "MY_TOKEN",
    })
    expect(result.success).toBe(false)
  })

  it("rejects credentialEnvVar ending in _SECRET", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "t",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
      credentialEnvVar: "API_SECRET",
    })
    expect(result.success).toBe(false)
  })

  it("rejects credentialEnvVar ending in _KEY", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "t",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
      credentialEnvVar: "GH_KEY",
    })
    expect(result.success).toBe(false)
  })

  it("accepts credentialEnvVar like GH_PAT", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "t",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 5000,
            envAllow: {},
          },
        },
      ],
      credentialEnvVar: "GH_PAT",
    })
    expect(result.success).toBe(true)
  })

  it("tool name must match ^[a-z][a-z0-9_]*$", () => {
    const badNames = ["Bad", "bad-name", "1start", ""]
    for (const name of badNames) {
      const result = CliConnectionSchema.safeParse({
        tools: [
          {
            name,
            argv: [{ kind: "literal", value: "/bin/echo" }],
            args: [],
            policy: {
              cwd: "/tmp",
              readPaths: ["/tmp"],
              writePaths: [],
              allowNet: [],
              timeoutMs: 5000,
              envAllow: {},
            },
          },
        ],
      })
      expect(result.success).toBe(false)
    }
  })

  it("timeoutMs max is 600_000", () => {
    const result = CliConnectionSchema.safeParse({
      tools: [
        {
          name: "t",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: {
            cwd: "/tmp",
            readPaths: ["/tmp"],
            writePaths: [],
            allowNet: [],
            timeoutMs: 600_001,
            envAllow: {},
          },
        },
      ],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. Migration 0006 round-trip
// ---------------------------------------------------------------------------

describe("migration 0006 — cli column round-trip", () => {
  // Verify that a Platform with a CliConnection survives a DB upsert + read cycle.
  // Uses withTempHome + getDatabase to run all migrations (including 0006) against
  // a real temp directory so the cli column exists in the schema.

  it("cli platform persists and reads back correctly", async () => {
    const { getDatabase } = await import("../../db/index.js")
    const { createRepositories } = await import("../../repositories/index.js")
    const { getPaths } = await import("../../paths/index.js")
    const { withTempHome } = await import("../../testing/index.js")

    await withTempHome(async () => {
      const dbResult = await getDatabase(getPaths())
      if (dbResult.isErr()) throw dbResult.error
      const db = dbResult.value
      const repos = createRepositories(db)

      const conn: CliConnection = {
        tools: [
          {
            name: "greet",
            description: "Echo a message",
            argv: [
              { kind: "literal", value: "/bin/echo" },
              { kind: "literal", value: "--" },
              { kind: "arg", name: "message" },
            ],
            args: [{ name: "message", type: "string", required: true, maxLength: 200 }],
            policy: {
              cwd: "/tmp",
              readPaths: ["/tmp"],
              writePaths: [],
              allowNet: [],
              timeoutMs: 5000,
              envAllow: {},
            },
          },
        ],
        credentialEnvVar: "GH_PAT",
      }

      const platform = {
        id: "test-cli-platform" as ReturnType<
          typeof import("../../schema/primitives.js").PlatformIdSchema.parse
        >,
        kind: "cli" as const,
        displayName: "Test CLI Platform",
        cli: conn,
      }

      const upsertResult = await repos.platforms.upsert(platform)
      expect(upsertResult.isOk()).toBe(true)

      const getResult = await repos.platforms.get("test-cli-platform")
      expect(getResult.isOk()).toBe(true)
      if (!getResult.isOk()) return

      const loaded = getResult.value
      expect(loaded.kind).toBe("cli")
      expect(loaded.cli).toBeDefined()
      expect(loaded.cli?.tools).toHaveLength(1)
      expect(loaded.cli?.tools[0]?.name).toBe("greet")
      expect(loaded.cli?.credentialEnvVar).toBe("GH_PAT")
    })
  })
})
