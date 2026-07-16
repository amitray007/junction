// SPDX-License-Identifier: AGPL-3.0-only
// Schema-level tests for CliConnectionSchema's security refines.
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { validatePolicy } from "../sandbox/index.js"
import { CliArgSchema, CliConnectionSchema, CliToolSchema, isFullAccess } from "./cli-connection.js"

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

// ---------------------------------------------------------------------------
// 32.13 Slice D1 — argv[0] SBPL-metachar refine
// ---------------------------------------------------------------------------

describe("CliToolSchema — argv[0] metachar refine (32.13 Slice D1)", () => {
  it('REJECTS argv[0] containing a double-quote (") — SBPL string-terminator injection', () => {
    const r = CliToolSchema.safeParse({
      name: "echo",
      argv: [{ kind: "literal", value: '/bin/echo") (allow file-read* (subpath "/' }],
      args: [],
      policy: basePolicy,
    })
    expect(r.success).toBe(false)
  })

  it("REJECTS argv[0] containing a backslash", () => {
    const r = CliToolSchema.safeParse({
      name: "echo",
      argv: [{ kind: "literal", value: "/bin/ec\\ho" }],
      args: [],
      policy: basePolicy,
    })
    expect(r.success).toBe(false)
  })

  it("REJECTS argv[0] containing parens", () => {
    const r = CliToolSchema.safeParse({
      name: "echo",
      argv: [{ kind: "literal", value: "/bin/ec(ho)" }],
      args: [],
      policy: basePolicy,
    })
    expect(r.success).toBe(false)
  })

  it("still ACCEPTS a clean absolute argv[0] (no false positive)", () => {
    const r = CliToolSchema.safeParse({
      name: "echo",
      argv: [{ kind: "literal", value: "/usr/local/bin/my-tool" }],
      args: [],
      policy: basePolicy,
    })
    expect(r.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 32.13 Slice D3 — CliArgSchema.pattern ReDoS guard
// ---------------------------------------------------------------------------

describe("CliArgSchema — pattern ReDoS guard (32.13 Slice D3)", () => {
  it("REJECTS the classic catastrophic-backtracking shape (\\w+)+$", () => {
    const r = CliArgSchema.safeParse({
      name: "arg1",
      type: "string",
      pattern: "(\\w+)+$",
      maxLength: 100,
    })
    expect(r.success).toBe(false)
  })

  it("REJECTS (a+)+ nested-unbounded-quantifier shape", () => {
    const r = CliArgSchema.safeParse({
      name: "arg1",
      type: "string",
      pattern: "(a+)+",
      maxLength: 100,
    })
    expect(r.success).toBe(false)
  })

  it("still ACCEPTS a safe bounded pattern (no false positive)", () => {
    const r = CliArgSchema.safeParse({
      name: "arg1",
      type: "string",
      pattern: "\\d{1,3}(\\.\\d{1,3}){3}",
      maxLength: 15,
    })
    expect(r.success).toBe(true)
  })

  it("still ACCEPTS an optional-group pattern (no false positive)", () => {
    const r = CliArgSchema.safeParse({
      name: "arg1",
      type: "string",
      pattern: "(\\d+)?",
      maxLength: 20,
    })
    expect(r.success).toBe(true)
  })
})

describe("credentialEnvVar denylist — lock-step with validatePolicy", () => {
  // Increment 32.7 item 3 (revised inc 41 — Fable ruling): the schema's
  // inline denylist refine (this file's CliConnectionSchema) and the
  // sandbox's isDenylistedEnvKey (sandbox.ts) are two separately-maintained
  // call sites of the SAME shared predicate (sandbox/env-denylist.ts).
  // Nothing pins them together except behavior — this test is that pin, via
  // BEHAVIORAL parity over a corpus (neither call site is exported; both
  // stay private).
  //
  // JUNCTION_HOME is stubbed to a tmpdir for this block (testing.md rule;
  // mirrors sandbox.test.ts): validatePolicy →
  // grantedPathExposesSecrets realpaths REAL home-derived secret-file paths,
  // so running against the developer's actual ~/.junction would couple the
  // test to machine state.
  //
  // CORPUS CONSTRAINT (load-bearing — do not add a lowercase entry): every
  // name below MUST match the schema's charset regex ^[A-Z_][A-Z0-9_]*$.
  // The schema is strictly stricter than validatePolicy on charset (a
  // lowercase name fails the schema's regex but would pass validatePolicy,
  // which is charset-agnostic) — a non-uppercase corpus entry would fail the
  // parity assertion for the WRONG reason (charset, not the denylist rule
  // under test).
  //
  // inc 41: the _TOKEN/_SECRET/_KEY suffix heuristic was DROPPED (it blocked
  // GH_TOKEN — the only var `gh` reads — for no real security gain) and
  // REPLACED with a JUNCTION_ prefix reservation + the shared
  // interpreter/linker denylist class (LD_PRELOAD, DYLD_*, NODE_OPTIONS, …).
  const REJECTED = [
    "JUNCTION_MASTER_KEY",
    "JUNCTION_MASTER_KEY_FILE",
    "JUNCTION_HOME",
    "JUNCTION_ANYTHING",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS",
  ]
  const ACCEPTED = [
    "GH_PAT",
    "API_AUTH",
    "TOKEN_FOO",
    "MY_KEYS",
    "KEYRING_NAME",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "CLOUDFLARE_API_TOKEN",
  ]

  let fakeJunctionHome: string
  let prevJunctionHome: string | undefined

  beforeAll(async () => {
    fakeJunctionHome = await mkdtemp(path.join(os.tmpdir(), "junction-parity-test-"))
    prevJunctionHome = process.env.JUNCTION_HOME
    process.env.JUNCTION_HOME = fakeJunctionHome
  })

  afterAll(async () => {
    if (prevJunctionHome === undefined) delete process.env.JUNCTION_HOME
    else process.env.JUNCTION_HOME = prevJunctionHome
    await rm(fakeJunctionHome, { recursive: true, force: true })
  })

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

// ---------------------------------------------------------------------------
// Increment 41.1 — mode-tagged CliConnection (declared | full-access)
// docs/methods/41.1-cli-full-access-core.md
// ---------------------------------------------------------------------------

const fullAccessPolicy = {
  cwd: "/work",
  readPaths: ["/work"],
  writePaths: [],
  allowNet: [],
  timeoutMs: 5000,
}

const minimalExtractedSchema = {
  binaryName: "gh",
  extractedAt: "2026-07-16T00:00:00.000Z",
  root: {
    path: [],
    parsed: true,
    explored: true,
    flags: [],
    positionals: [],
    subcommands: [],
  },
  truncated: false,
}

function fullAccessConnection(overrides: Record<string, unknown> = {}) {
  return {
    mode: "full-access" as const,
    binaryPath: "/opt/homebrew/bin/gh",
    policy: fullAccessPolicy,
    schema: minimalExtractedSchema,
    ...overrides,
  }
}

describe("CliConnectionSchema — mode discriminant back-compat (inc 41.1)", () => {
  it("(a) parses a LEGACY object with NO `mode` field as declared", () => {
    // The exact shape every CLI platform row predating this increment has.
    const legacy = {
      tools: [
        {
          name: "run",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: fullAccessPolicy,
        },
      ],
      credentialEnvVar: "GH_PAT",
    }
    const r = CliConnectionSchema.safeParse(legacy)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.mode).toBe("declared")
      expect(isFullAccess(r.data)).toBe(false)
      if (!isFullAccess(r.data)) {
        expect(r.data.tools).toHaveLength(1)
        expect(r.data.credentialEnvVar).toBe("GH_PAT")
      }
    }
  })

  it('(b) parses an object with explicit mode:"declared" as declared', () => {
    const explicit = {
      mode: "declared" as const,
      tools: [
        {
          name: "run",
          argv: [{ kind: "literal", value: "/bin/echo" }],
          args: [],
          policy: fullAccessPolicy,
        },
      ],
    }
    const r = CliConnectionSchema.safeParse(explicit)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.mode).toBe("declared")
      expect(isFullAccess(r.data)).toBe(false)
    }
  })

  it("(c) parses a valid full-access object as full-access", () => {
    const r = CliConnectionSchema.safeParse(fullAccessConnection())
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.mode).toBe("full-access")
      expect(isFullAccess(r.data)).toBe(true)
      if (isFullAccess(r.data)) {
        expect(r.data.binaryPath).toBe("/opt/homebrew/bin/gh")
        expect(r.data.schema.binaryName).toBe("gh")
      }
    }
  })

  it("(d) REJECTS full-access with a relative binaryPath", () => {
    const r = CliConnectionSchema.safeParse(fullAccessConnection({ binaryPath: "gh" }))
    expect(r.success).toBe(false)
  })

  it("(d) REJECTS full-access with a metachar-unsafe binaryPath", () => {
    const r = CliConnectionSchema.safeParse(
      fullAccessConnection({ binaryPath: '/opt/homebrew/bin/gh") (allow file-read* (subpath "/' }),
    )
    expect(r.success).toBe(false)
  })

  it("(e) REJECTS full-access with a denylisted credentialEnvVar", () => {
    const r = CliConnectionSchema.safeParse(
      fullAccessConnection({ credentialEnvVar: "JUNCTION_MASTER_KEY" }),
    )
    expect(r.success).toBe(false)
  })

  it("accepts full-access with a non-denylisted credentialEnvVar", () => {
    const r = CliConnectionSchema.safeParse(fullAccessConnection({ credentialEnvVar: "GH_PAT" }))
    expect(r.success).toBe(true)
  })

  it("accepts full-access with GH_TOKEN (inc 41 — the only var gh reads)", () => {
    const r = CliConnectionSchema.safeParse(fullAccessConnection({ credentialEnvVar: "GH_TOKEN" }))
    expect(r.success).toBe(true)
  })

  it("accepts full-access with optional shortcuts (reusing CliToolSchema verbatim)", () => {
    const r = CliConnectionSchema.safeParse(
      fullAccessConnection({
        shortcuts: [
          {
            name: "prs",
            argv: [
              { kind: "literal", value: "/opt/homebrew/bin/gh" },
              { kind: "literal", value: "pr" },
              { kind: "literal", value: "list" },
            ],
            args: [],
            policy: fullAccessPolicy,
          },
        ],
      }),
    )
    expect(r.success).toBe(true)
  })
})
