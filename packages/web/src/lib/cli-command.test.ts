// SPDX-License-Identifier: AGPL-3.0-only
// Unit + round-trip tests for cli-command.ts's tokenizer/serializer.
// Round-trip property: tokenizeCommandLine(argvToCommandLine(argv)) deep-equals argv.
// Fixtures cover: the ripgrep seed descriptor, a literal with an internal space
// (must round-trip through quoting), a prefixed arg, and a literal containing a
// literal "$" (must NOT be misparsed as an arg reference).

import { describe, expect, it } from "vitest"
import {
  argvToChips,
  argvToCommandLine,
  type CliArgvSegment,
  firstTokenIsAbsolutePath,
  isReversible,
  tokenizeCommandLine,
} from "./cli-command.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Terse literal-segment constructor for the adversarial round-trip fixtures. */
const lit = (value: string): CliArgvSegment => ({ kind: "literal", value })

const RIPGREP_ARGV: CliArgvSegment[] = [
  { kind: "literal", value: "/opt/homebrew/bin/rg" },
  { kind: "literal", value: "--json" },
  { kind: "arg", name: "pattern" },
]

const SPACE_LITERAL_ARGV: CliArgvSegment[] = [
  { kind: "literal", value: "/usr/bin/env" },
  { kind: "literal", value: "hello world" },
]

const PREFIXED_ARG_ARGV: CliArgvSegment[] = [
  { kind: "literal", value: "/usr/bin/tool" },
  { kind: "arg", name: "file", prefix: "--out=" },
]

const DOLLAR_LITERAL_ARGV: CliArgvSegment[] = [
  { kind: "literal", value: "/bin/echo" },
  { kind: "literal", value: "$5.00" },
]

// ---------------------------------------------------------------------------
// tokenizeCommandLine — direct unit tests
// ---------------------------------------------------------------------------

describe("tokenizeCommandLine", () => {
  it("parses the first token as the absolute binary path literal", () => {
    const result = tokenizeCommandLine("/opt/homebrew/bin/rg --json $pattern")
    expect(result[0]).toEqual({ kind: "literal", value: "/opt/homebrew/bin/rg" })
  })

  it("parses multiple literal args and a trailing $name arg slot", () => {
    const result = tokenizeCommandLine("/opt/homebrew/bin/rg --json $pattern")
    expect(result).toEqual(RIPGREP_ARGV)
  })

  it("parses a quoted literal containing an internal space as one token", () => {
    const result = tokenizeCommandLine('/usr/bin/env "hello world"')
    expect(result).toEqual(SPACE_LITERAL_ARGV)
  })

  it("parses single-quoted literals the same as double-quoted", () => {
    const result = tokenizeCommandLine("/usr/bin/env 'hello world'")
    expect(result).toEqual(SPACE_LITERAL_ARGV)
  })

  it("parses a prefixed arg token (--out=$file)", () => {
    const result = tokenizeCommandLine("/usr/bin/tool --out=$file")
    expect(result).toEqual(PREFIXED_ARG_ARGV)
  })

  it("does not misparse a literal containing a literal $ as an arg reference", () => {
    const result = tokenizeCommandLine("/bin/echo $5.00")
    // "$5.00" does not match ^[a-z][a-z0-9_]*$ after the $, so it must stay literal.
    expect(result).toEqual(DOLLAR_LITERAL_ARGV)
  })

  it("handles multiple whitespace-separated args", () => {
    const result = tokenizeCommandLine("/usr/bin/tool  --flag   $one $two")
    expect(result).toEqual([
      { kind: "literal", value: "/usr/bin/tool" },
      { kind: "literal", value: "--flag" },
      { kind: "arg", name: "one" },
      { kind: "arg", name: "two" },
    ])
  })

  it("returns an empty array for an empty/whitespace-only command line", () => {
    expect(tokenizeCommandLine("")).toEqual([])
    expect(tokenizeCommandLine("   ")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// argvToCommandLine — direct unit tests
// ---------------------------------------------------------------------------

describe("argvToCommandLine", () => {
  it("serializes literal + arg segments back into a command line", () => {
    expect(argvToCommandLine(RIPGREP_ARGV)).toBe("/opt/homebrew/bin/rg --json $pattern")
  })

  it("quotes a literal containing whitespace", () => {
    expect(argvToCommandLine(SPACE_LITERAL_ARGV)).toBe('/usr/bin/env "hello world"')
  })

  it("serializes a prefixed arg as prefix + $name", () => {
    expect(argvToCommandLine(PREFIXED_ARG_ARGV)).toBe("/usr/bin/tool --out=$file")
  })

  it("quotes a literal containing a literal $ so it round-trips as a literal", () => {
    const line = argvToCommandLine(DOLLAR_LITERAL_ARGV)
    // Must be quoted (contains $) so tokenize doesn't misparse it as an arg ref.
    expect(line).toBe('/bin/echo "$5.00"')
  })
})

// ---------------------------------------------------------------------------
// Round-trip property: tokenize(serialize(argv)) === argv
// ---------------------------------------------------------------------------

describe("round-trip: tokenizeCommandLine(argvToCommandLine(argv)) === argv", () => {
  const fixtures: Array<{ name: string; argv: CliArgvSegment[] }> = [
    { name: "ripgrep seed descriptor", argv: RIPGREP_ARGV },
    { name: "literal with internal space", argv: SPACE_LITERAL_ARGV },
    { name: "prefixed arg", argv: PREFIXED_ARG_ARGV },
    { name: "literal containing a literal $", argv: DOLLAR_LITERAL_ARGV },
    // Adversarial cases the original fixture set omitted (found by the inc-26
    // wave-3 correctness review — the tokenizer was NOT a true inverse for these):
    // a literal that looks like a $name-slot must stay a literal (was mis-read as
    // an arg → the argument silently vanished at execution on the edit path).
    { name: "literal that looks like $name", argv: [lit("/bin/echo"), lit("$foo")] },
    // a literal that looks like a prefixed arg must stay a literal.
    { name: "literal that looks like --out=$file", argv: [lit("/bin/echo"), lit("--out=$file")] },
    // a literal containing a double quote (serializer escapes \", tokenizer un-escapes).
    { name: "literal containing a double quote", argv: [lit("/bin/echo"), lit('a"b')] },
    // a literal containing a backslash (serializer escapes \\, tokenizer un-escapes).
    { name: "literal containing a backslash", argv: [lit("/bin/echo"), lit("a\\b")] },
    // a literal containing a single quote.
    { name: "literal containing a single quote", argv: [lit("/bin/echo"), lit("it's")] },
    // an empty-string literal round-trips as an empty literal (core rejects it later,
    // but the tokenizer must not silently drop or transform it).
    { name: "empty-string literal", argv: [lit("/bin/echo"), lit("")] },
  ]

  for (const { name, argv } of fixtures) {
    it(`round-trips: ${name}`, () => {
      const line = argvToCommandLine(argv)
      const reparsed = tokenizeCommandLine(line)
      expect(reparsed).toEqual(argv)
    })
  }
})

// ---------------------------------------------------------------------------
// isReversible
// ---------------------------------------------------------------------------

describe("isReversible", () => {
  it("is reversible when every arg segment references a distinct declared arg", () => {
    expect(
      isReversible({
        argv: RIPGREP_ARGV,
        args: [{ name: "pattern" }],
      }),
    ).toBe(true)
  })

  it("is NOT reversible when an arg segment references an undeclared arg", () => {
    expect(
      isReversible({
        argv: RIPGREP_ARGV,
        args: [], // "pattern" referenced by argv but not declared
      }),
    ).toBe(false)
  })

  it("is NOT reversible when two argv segments reference the same arg name", () => {
    expect(
      isReversible({
        argv: [
          { kind: "literal", value: "/bin/tool" },
          { kind: "arg", name: "x" },
          { kind: "arg", name: "x" },
        ],
        args: [{ name: "x" }],
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// firstTokenIsAbsolutePath
// ---------------------------------------------------------------------------

describe("firstTokenIsAbsolutePath", () => {
  it("is true when the first segment is a literal starting with /", () => {
    expect(firstTokenIsAbsolutePath(RIPGREP_ARGV)).toBe(true)
  })

  it("is false when the first segment is an arg slot", () => {
    expect(firstTokenIsAbsolutePath([{ kind: "arg", name: "pattern" }])).toBe(false)
  })

  it("is false when the first literal does not start with /", () => {
    expect(firstTokenIsAbsolutePath([{ kind: "literal", value: "rg" }])).toBe(false)
  })

  it("is false for an empty argv", () => {
    expect(firstTokenIsAbsolutePath([])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// argvToChips
// ---------------------------------------------------------------------------

describe("argvToChips", () => {
  it("projects literal and arg segments into labeled chips", () => {
    expect(argvToChips(RIPGREP_ARGV)).toEqual([
      { kind: "literal", label: "/opt/homebrew/bin/rg" },
      { kind: "literal", label: "--json" },
      { kind: "arg", label: "$pattern" },
    ])
  })

  it("includes the prefix in a prefixed arg chip's label", () => {
    expect(argvToChips(PREFIXED_ARG_ARGV)).toEqual([
      { kind: "literal", label: "/usr/bin/tool" },
      { kind: "arg", label: "--out=$file" },
    ])
  })
})
