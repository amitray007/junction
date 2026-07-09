// SPDX-License-Identifier: AGPL-3.0-only
// Schema-level tests for CliConnectionSchema's security refines.
import { describe, expect, it } from "vitest"
import { validatePolicy } from "../sandbox/index.js"
import { CliConnectionSchema, CliToolSchema } from "./cli-connection.js"

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

describe("credentialEnvVar denylist — lock-step with validatePolicy", () => {
  // Increment 32.7 item 3: the schema's inline denylist refine (this file's
  // CliConnectionSchema) and the sandbox's SECRET_DENYLIST_RE/EXACT
  // (sandbox.ts) are two separately-maintained copies of the same rule.
  // Nothing pins them together — this test is that pin, via BEHAVIORAL
  // parity over a corpus (neither list is exported; both stay private).
  //
  // CORPUS CONSTRAINT (load-bearing — do not add a lowercase entry): every
  // name below MUST match the schema's charset regex ^[A-Z_][A-Z0-9_]*$.
  // The schema is strictly stricter than validatePolicy on charset (a
  // lowercase name fails the schema's regex but would pass validatePolicy,
  // which is charset-agnostic) — a non-uppercase corpus entry would fail the
  // parity assertion for the WRONG reason (charset, not the denylist rule
  // under test).
  const REJECTED = [
    "FOO_TOKEN",
    "BAR_SECRET",
    "BAZ_KEY",
    "JUNCTION_MASTER_KEY",
    "JUNCTION_MASTER_KEY_FILE",
  ]
  const ACCEPTED = ["GH_PAT", "API_AUTH", "TOKEN_FOO", "MY_KEYS", "KEYRING_NAME"]

  function baseConnection(credentialEnvVar: string) {
    return {
      tools: [
        {
          name: "run",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: basePolicy,
        },
      ],
      credentialEnvVar,
    }
  }

  for (const name of [...REJECTED, ...ACCEPTED]) {
    it(`"${name}": schema acceptance matches validatePolicy acceptance`, async () => {
      const schemaResult = CliConnectionSchema.safeParse(baseConnection(name))
      const schemaAccepts = schemaResult.success

      const policyError = await validatePolicy({
        cwd: "/work",
        readPaths: ["/work"],
        writePaths: [],
        allowNet: [],
        timeoutMs: 5000,
        env: { [name]: "x" },
      })

      // THE PARITY ASSERTION — the point of this test. A drift on EITHER
      // side (schema accepts what the sandbox would reject, or vice versa)
      // fails here, not the individual per-name expectation.
      expect(schemaAccepts).toBe(policyError === null)
    })
  }
})
