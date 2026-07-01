// SPDX-License-Identifier: AGPL-3.0-only
// Schema-level tests for CliConnectionSchema's security refines.
import { describe, expect, it } from "vitest"
import { CliToolSchema } from "./cli-connection.js"

const basePolicy = {
  cwd: "/work",
  readPaths: ["/work"],
  writePaths: [],
  allowNet: [],
  timeoutMs: 5000,
}

describe("CliToolSchema — argv[0] absolute-path refine", () => {
  it("accepts an absolute-literal argv[0]", () => {
    const r = CliToolSchema.safeParse({
      name: "echo",
      argv: [{ kind: "literal", value: "/bin/echo" }],
      args: [],
      policy: basePolicy,
    })
    expect(r.success).toBe(true)
  })

  it("rejects a relative argv[0]", () => {
    const r = CliToolSchema.safeParse({
      name: "echo",
      argv: [{ kind: "literal", value: "echo" }],
      args: [],
      policy: basePolicy,
    })
    expect(r.success).toBe(false)
  })
})

describe("CliToolSchema — every argv arg must be declared refine", () => {
  it("accepts an argv arg that IS declared", () => {
    const r = CliToolSchema.safeParse({
      name: "search",
      argv: [
        { kind: "literal", value: "/bin/rg" },
        { kind: "arg", name: "pattern" },
      ],
      args: [{ name: "pattern", type: "string", required: true }],
      policy: basePolicy,
    })
    expect(r.success).toBe(true)
  })

  it("REJECTS an argv arg segment that names an UNDECLARED arg", () => {
    // The exact corruption the web edit path could produce: a literal "$foo"
    // mis-serialised into an arg segment with no matching declared arg. At call
    // time buildArgv would silently drop it — this refine is the backstop.
    const r = CliToolSchema.safeParse({
      name: "echo",
      argv: [
        { kind: "literal", value: "/bin/echo" },
        { kind: "arg", name: "foo" },
      ],
      args: [], // "foo" is not declared
      policy: basePolicy,
    })
    expect(r.success).toBe(false)
  })
})
