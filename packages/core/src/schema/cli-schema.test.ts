// SPDX-License-Identifier: AGPL-3.0-only
// Schema-level tests for ExtractedCliSchema / CliSchemaNode (increment 41.1).
import { describe, expect, it } from "vitest"
import {
  CliFlagSchema,
  type CliSchemaNode,
  CliSchemaNodeSchema,
  ExtractedCliSchemaSchema,
} from "./cli-schema.js"

describe("CliFlagSchema", () => {
  it("parses a full flag", () => {
    const r = CliFlagSchema.safeParse({
      name: "--title",
      alias: "-t",
      takesValue: true,
      description: "The title of the PR",
    })
    expect(r.success).toBe(true)
  })

  it("parses a minimal flag (no alias/description)", () => {
    const r = CliFlagSchema.safeParse({ name: "--verbose", takesValue: false })
    expect(r.success).toBe(true)
  })

  it("rejects a flag missing takesValue", () => {
    const r = CliFlagSchema.safeParse({ name: "--title" })
    expect(r.success).toBe(false)
  })
})

describe("CliSchemaNodeSchema — node parse + defaults", () => {
  it("parses a minimal leaf node and defaults array fields to []", () => {
    const r = CliSchemaNodeSchema.safeParse({
      path: ["pr", "create"],
      parsed: true,
      explored: true,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.flags).toEqual([])
      expect(r.data.positionals).toEqual([])
      expect(r.data.subcommands).toEqual([])
    }
  })

  it("parses a root node (path: [])", () => {
    const r = CliSchemaNodeSchema.safeParse({
      path: [],
      parsed: true,
      explored: true,
      description: "GitHub CLI",
      usage: "gh <command> <subcommand> [flags]",
    })
    expect(r.success).toBe(true)
  })

  it("parses parsed:false with rawHelp — Fable Q5: never dropped, raw persisted", () => {
    const r = CliSchemaNodeSchema.safeParse({
      path: ["weird-cmd"],
      parsed: false,
      explored: true,
      rawHelp: "some unparseable --help output",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.parsed).toBe(false)
      expect(r.data.rawHelp).toBe("some unparseable --help output")
    }
  })

  it("parses explored:false (ceiling/lazy — Fable Q4) with empty children", () => {
    const r = CliSchemaNodeSchema.safeParse({
      path: ["deeply", "nested", "cmd"],
      parsed: true,
      explored: false,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.explored).toBe(false)
      expect(r.data.subcommands).toEqual([])
    }
  })

  it("parses flags, positionals, and helpHash", () => {
    const r = CliSchemaNodeSchema.safeParse({
      path: ["pr", "create"],
      parsed: true,
      explored: true,
      flags: [{ name: "--title", alias: "-t", takesValue: true, description: "PR title" }],
      positionals: [{ name: "repo", description: "owner/repo" }],
      helpHash: "abc123",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.flags).toHaveLength(1)
      expect(r.data.positionals).toHaveLength(1)
      expect(r.data.helpHash).toBe("abc123")
    }
  })

  it("recursively parses nested subcommands as FULL nodes", () => {
    const tree: CliSchemaNode = {
      path: [],
      parsed: true,
      explored: true,
      flags: [],
      positionals: [],
      subcommands: [
        {
          path: ["pr"],
          parsed: true,
          explored: true,
          flags: [],
          positionals: [],
          subcommands: [
            {
              path: ["pr", "create"],
              parsed: true,
              explored: true,
              flags: [{ name: "--title", takesValue: true }],
              positionals: [],
              subcommands: [],
            },
            {
              path: ["pr", "list"],
              parsed: true,
              explored: false,
              flags: [],
              positionals: [],
              subcommands: [],
            },
          ],
        },
      ],
    }
    const r = CliSchemaNodeSchema.safeParse(tree)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.subcommands).toHaveLength(1)
      const pr = r.data.subcommands[0]
      expect(pr?.subcommands).toHaveLength(2)
      expect(pr?.subcommands[0]?.path).toEqual(["pr", "create"])
      expect(pr?.subcommands[0]?.flags[0]?.name).toBe("--title")
      expect(pr?.subcommands[1]?.explored).toBe(false)
    }
  })

  it("rejects a node missing required parsed/explored", () => {
    const r = CliSchemaNodeSchema.safeParse({ path: [] })
    expect(r.success).toBe(false)
  })
})

describe("ExtractedCliSchemaSchema — top-level wrapper", () => {
  const validRoot = {
    path: [],
    parsed: true,
    explored: true,
    flags: [],
    positionals: [],
    subcommands: [],
  }

  it("parses a minimal valid wrapper", () => {
    const r = ExtractedCliSchemaSchema.safeParse({
      binaryName: "gh",
      extractedAt: "2026-07-16T00:00:00.000Z",
      root: validRoot,
      truncated: false,
    })
    expect(r.success).toBe(true)
  })

  it("round-trips through JSON.stringify/parse unchanged", () => {
    const original = {
      binaryName: "gh",
      extractedAt: "2026-07-16T00:00:00.000Z",
      truncated: true,
      root: {
        path: [],
        parsed: true,
        explored: true,
        description: "GitHub CLI",
        flags: [],
        positionals: [],
        subcommands: [
          {
            path: ["pr"],
            parsed: false,
            explored: false,
            rawHelp: "usage: gh pr [flags]",
            flags: [],
            positionals: [],
            subcommands: [],
          },
        ],
      },
    }
    const parsedOriginal = ExtractedCliSchemaSchema.parse(original)
    const roundTripped = ExtractedCliSchemaSchema.parse(
      JSON.parse(JSON.stringify(parsedOriginal)) as unknown,
    )
    expect(roundTripped).toEqual(parsedOriginal)
  })

  it("rejects a wrapper missing `truncated`", () => {
    const r = ExtractedCliSchemaSchema.safeParse({
      binaryName: "gh",
      extractedAt: "2026-07-16T00:00:00.000Z",
      root: validRoot,
    })
    expect(r.success).toBe(false)
  })
})
