// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the sandboxed recursive --help extractor (increment 41.2).
// Parser tests run against REAL gh 2.95.0 --help fixtures; recursion tests
// use a FAKE Sandbox that returns canned help keyed by argv.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { SandboxError } from "../../errors/index.js"
import { err, okAsync, ResultAsync } from "../../result/index.js"
import type {
  Sandbox,
  SandboxCapabilities,
  SandboxPolicy,
  SandboxResult,
} from "../../sandbox/index.js"
import type { CliPolicy } from "../../schema/cli-connection.js"
import {
  DEFAULT_CEILING,
  type ExtractCeiling,
  extractCliSchema,
  genericHelpExtractor,
  probeNode,
} from "./extract.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, "__fixtures__")

async function loadFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES_DIR, name), "utf8")
}

// ---------------------------------------------------------------------------
// genericHelpExtractor — parser unit tests against real gh fixtures
// ---------------------------------------------------------------------------

describe("genericHelpExtractor.parseHelp — real gh fixtures", () => {
  it("parses gh-help-root.txt: usage, description, and multi-section subcommands", async () => {
    const raw = await loadFixture("gh-help-root.txt")
    const parsed = genericHelpExtractor.parseHelp(raw, [])

    expect(parsed.parsed).toBe(true)
    expect(parsed.usage).toBe("gh <command> <subcommand> [flags]")
    expect(parsed.description).toContain("Work seamlessly with GitHub")

    const names = parsed.subcommands.map((s) => s.name)
    // CORE COMMANDS
    expect(names).toContain("auth")
    expect(names).toContain("pr")
    expect(names).toContain("repo")
    expect(names).toContain("issue")
    // GITHUB ACTIONS COMMANDS
    expect(names).toContain("run")
    // ALIAS COMMANDS
    expect(names).toContain("co")
    // ADDITIONAL COMMANDS
    expect(names).toContain("api")

    const pr = parsed.subcommands.find((s) => s.name === "pr")
    expect(pr?.summary).toBe("Manage pull requests")
  })

  it("parses gh-help-pr.txt: usage + GENERAL/TARGETED command sections + flags", async () => {
    const raw = await loadFixture("gh-help-pr.txt")
    const parsed = genericHelpExtractor.parseHelp(raw, ["pr"])

    expect(parsed.parsed).toBe(true)
    expect(parsed.usage).toBe("gh pr <command> [flags]")
    const names = parsed.subcommands.map((s) => s.name)
    expect(names).toContain("create")
    expect(names).toContain("list")
    expect(names).toContain("checkout")
    expect(names).toContain("merge")

    // FLAGS section: -R, --repo [HOST/]OWNER/REPO — has a value placeholder.
    const repoFlag = parsed.flags.find((f) => f.name === "--repo")
    expect(repoFlag).toBeDefined()
    expect(repoFlag?.alias).toBe("-R")
    expect(repoFlag?.takesValue).toBe(true)
  })

  it("parses gh-help-pr-create.txt: --title takesValue with -t alias; --draft/--dry-run booleans", async () => {
    const raw = await loadFixture("gh-help-pr-create.txt")
    const parsed = genericHelpExtractor.parseHelp(raw, ["pr", "create"])

    expect(parsed.parsed).toBe(true)
    expect(parsed.usage).toBe("gh pr create [flags]")

    const title = parsed.flags.find((f) => f.name === "--title")
    expect(title).toBeDefined()
    expect(title?.alias).toBe("-t")
    expect(title?.takesValue).toBe(true)

    const draft = parsed.flags.find((f) => f.name === "--draft")
    expect(draft).toBeDefined()
    expect(draft?.alias).toBe("-d")
    expect(draft?.takesValue).toBe(false)

    const dryRun = parsed.flags.find((f) => f.name === "--dry-run")
    expect(dryRun).toBeDefined()
    expect(dryRun?.alias).toBeUndefined()
    expect(dryRun?.takesValue).toBe(false)

    // No subcommands on a leaf node.
    expect(parsed.subcommands).toEqual([])
  })

  it("parses gh-help-pr-list.txt: usage + flags incl. --json/--limit with value placeholders", async () => {
    const raw = await loadFixture("gh-help-pr-list.txt")
    const parsed = genericHelpExtractor.parseHelp(raw, ["pr", "list"])

    expect(parsed.parsed).toBe(true)
    expect(parsed.usage).toBe("gh pr list [flags]")

    const limit = parsed.flags.find((f) => f.name === "--limit")
    expect(limit).toBeDefined()
    expect(limit?.alias).toBe("-L")
    expect(limit?.takesValue).toBe(true)

    const draft = parsed.flags.find((f) => f.name === "--draft")
    expect(draft).toBeDefined()
    expect(draft?.takesValue).toBe(false)
  })

  it("a garbage help string yields parsed:false and never throws", () => {
    const garbage = "\x00\x01 completely unstructured noise !!! ### @@@ \n\n\t\t"
    expect(() => genericHelpExtractor.parseHelp(garbage, [])).not.toThrow()
    const parsed = genericHelpExtractor.parseHelp(garbage, [])
    expect(parsed.parsed).toBe(false)
    expect(parsed.subcommands).toEqual([])
    expect(parsed.flags).toEqual([])
  })

  it("an empty string yields parsed:false and never throws", () => {
    expect(() => genericHelpExtractor.parseHelp("", [])).not.toThrow()
    expect(genericHelpExtractor.parseHelp("", []).parsed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fake Sandbox — canned help keyed by argv, for recursion + policy tests
// ---------------------------------------------------------------------------

type CannedResponse = { help: string } | { spawnFail: true } | { timeout: true }

/** Records every policy passed to runCommand, for the safe-probe assertions. */
class FakeSandbox implements Sandbox {
  public readonly policiesSeen: SandboxPolicy[] = []
  public runCommandCallCount = 0

  constructor(
    private readonly responses: Map<string, CannedResponse>,
    private readonly defaultHelp = "",
  ) {}

  capabilities(): SandboxCapabilities {
    return { command: "seatbelt", script: "none" }
  }

  runCommand(
    argv: readonly string[],
    policy: SandboxPolicy,
  ): ResultAsync<SandboxResult, SandboxError> {
    this.runCommandCallCount++
    this.policiesSeen.push(policy)
    const key = argv.join(" ")
    const canned = this.responses.get(key)

    if (canned && "spawnFail" in canned) {
      return new ResultAsync(
        Promise.resolve(
          err<SandboxResult, SandboxError>({ kind: "spawn-failed", cause: new Error("boom") }),
        ),
      )
    }
    if (canned && "timeout" in canned) {
      return new ResultAsync(
        Promise.resolve(
          err<SandboxResult, SandboxError>({ kind: "timed-out", timeoutMs: policy.timeoutMs }),
        ),
      )
    }

    const help = canned && "help" in canned ? canned.help : this.defaultHelp
    const result: SandboxResult = {
      stdout: help,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      outputCapped: false,
    }
    return okAsync(result)
  }

  runScript() {
    throw new Error("not used by extract.ts")
  }
}

function fakePolicy(overrides: Partial<CliPolicy> = {}): CliPolicy {
  return {
    cwd: "/tmp/junction-test",
    readPaths: ["/tmp/junction-test"],
    writePaths: ["/tmp/junction-test"],
    allowNet: ["api.github.com:443"],
    timeoutMs: 60_000,
    envAllow: { SOME_STATIC: "value" },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// probeNode — single-node test
// ---------------------------------------------------------------------------

describe("probeNode", () => {
  it("probes a single node and returns a parsed CliSchemaNode", async () => {
    const rootHelp = await loadFixture("gh-help-root.txt")
    const sandbox = new FakeSandbox(new Map([["/usr/bin/gh --help", { help: rootHelp }]]))

    const result = await probeNode({
      binaryPath: "/usr/bin/gh",
      policy: fakePolicy(),
      sandbox,
      path: [],
    })

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      const node = result.value
      expect(node.path).toEqual([])
      expect(node.explored).toBe(true)
      expect(node.parsed).toBe(true)
      expect(node.usage).toBe("gh <command> <subcommand> [flags]")
      expect(node.rawHelp).toBeDefined()
      expect(node.helpHash).toBeDefined()
      expect(node.subcommands).toEqual([]) // probeNode does not itself recurse
    }
  })

  it("never drops the node on spawn failure — parsed:false, explored:true, rawHelp kept", async () => {
    // probeNode's contract: SandboxError propagates as Err for a hard refusal,
    // but a plain SandboxResult with empty/garbage output still yields Ok.
    const sandbox = new FakeSandbox(new Map([["/usr/bin/gh --help", { help: "" }]]))
    const result = await probeNode({
      binaryPath: "/usr/bin/gh",
      policy: fakePolicy(),
      sandbox,
      path: [],
    })
    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.parsed).toBe(false)
      expect(result.value.explored).toBe(true)
      expect(result.value.rawHelp).toBe("")
    }
  })
})

// ---------------------------------------------------------------------------
// extractCliSchema — recursion, ceilings, loop detection
// ---------------------------------------------------------------------------

describe("extractCliSchema — safe-probe policy (Fable Q3)", () => {
  it("derives a probe policy with allowNet:[], writePaths:[], and no secret-shaped env key", async () => {
    const rootHelp = "Root.\n\nUSAGE\n  gh <command>\n\nFLAGS\n  --help   Show help\n"
    const sandbox = new FakeSandbox(new Map([["/usr/bin/gh --help", { help: rootHelp }]]))

    const result = await extractCliSchema({
      binaryPath: "/usr/bin/gh",
      policy: fakePolicy({ allowNet: ["api.github.com:443"], writePaths: ["/tmp/junction-test"] }),
      sandbox,
    })

    expect(result.isOk()).toBe(true)
    expect(sandbox.policiesSeen.length).toBeGreaterThan(0)
    for (const policy of sandbox.policiesSeen) {
      expect(policy.allowNet).toEqual([])
      expect(policy.writePaths).toEqual([])
      for (const key of Object.keys(policy.env)) {
        expect(/_TOKEN$|_SECRET$|_KEY$/.test(key)).toBe(false)
      }
    }
  })

  it("timeoutMs is min(perProbeTimeoutMs, policy.timeoutMs)", async () => {
    const rootHelp = "Root.\n\nUSAGE\n  gh <command>\n"
    const sandbox = new FakeSandbox(new Map([["/usr/bin/gh --help", { help: rootHelp }]]))
    const ceiling: ExtractCeiling = { ...DEFAULT_CEILING, perProbeTimeoutMs: 2_000 }

    await extractCliSchema({
      binaryPath: "/usr/bin/gh",
      policy: fakePolicy({ timeoutMs: 60_000 }),
      sandbox,
      ceiling,
    })

    expect(sandbox.policiesSeen[0]?.timeoutMs).toBe(2_000)
  })
})

describe("extractCliSchema — recursion + ceilings (Fable Q4)", () => {
  it("recurses into discovered subcommands and attaches them as full child nodes", async () => {
    const rootHelp = [
      "Root tool.",
      "",
      "USAGE",
      "  tool <command>",
      "",
      "COMMANDS",
      "  foo:   Do foo things",
      "  bar:   Do bar things",
      "",
    ].join("\n")
    const fooHelp = [
      "Foo help.",
      "",
      "USAGE",
      "  tool foo [flags]",
      "",
      "FLAGS",
      "  --x   X flag",
      "",
    ].join("\n")
    const barHelp = "Bar help.\n\nUSAGE\n  tool bar [flags]\n"

    const sandbox = new FakeSandbox(
      new Map([
        ["/usr/bin/tool --help", { help: rootHelp }],
        ["/usr/bin/tool foo --help", { help: fooHelp }],
        ["/usr/bin/tool bar --help", { help: barHelp }],
      ]),
    )

    const result = await extractCliSchema({
      binaryPath: "/usr/bin/tool",
      policy: fakePolicy(),
      sandbox,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const root = result.value.root
    expect(root.parsed).toBe(true)
    expect(root.subcommands).toHaveLength(2)

    const foo = root.subcommands.find((n) => n.path.join(" ") === "foo")
    expect(foo).toBeDefined()
    expect(foo?.explored).toBe(true)
    expect(foo?.parsed).toBe(true)
    expect(foo?.flags.some((f) => f.name === "--x")).toBe(true)

    const bar = root.subcommands.find((n) => n.path.join(" ") === "bar")
    expect(bar?.explored).toBe(true)
    expect(result.value.truncated).toBe(false)
  })

  it("caps recursion at maxDepth — deeper nodes stay explored:false and truncated is set", async () => {
    // A chain: root -> a -> b -> c -> ... each level has exactly one child "next".
    function helpFor(label: string, hasChild: boolean): string {
      const lines = [`${label} help.`, "", "USAGE", `  tool ${label} [flags]`, ""]
      if (hasChild) {
        lines.push("COMMANDS", "  next:   Go deeper", "")
      }
      return lines.join("\n")
    }

    const responses = new Map<string, CannedResponse>()
    responses.set("/usr/bin/tool --help", { help: helpFor("root", true) })
    let argvPath: string[] = []
    for (let depth = 0; depth < 10; depth++) {
      argvPath = [...argvPath, "next"]
      responses.set(`/usr/bin/tool ${argvPath.join(" ")} --help`, {
        help: helpFor(argvPath.join("-"), true),
      })
    }
    const sandbox = new FakeSandbox(responses)

    const ceiling: ExtractCeiling = {
      ...DEFAULT_CEILING,
      maxDepth: 2,
      maxProbes: 400,
      wallClockMs: 300_000,
    }
    const result = await extractCliSchema({
      binaryPath: "/usr/bin/tool",
      policy: fakePolicy(),
      sandbox,
      ceiling,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.truncated).toBe(true)

    // Walk down: root (depth0) -> next (depth1, explored) -> next (depth2, NOT explored — ceiling)
    const depth1 = result.value.root.subcommands.find((n) => n.path.join(" ") === "next")
    expect(depth1?.explored).toBe(true)
    const depth2 = depth1?.subcommands.find((n) => n.path.join(" ") === "next next")
    // depth2 was enqueued at item.depth=1 (< maxDepth=2), so it IS explored;
    // its own children (depth 2, not < 2) are the ones capped.
    expect(depth2?.explored).toBe(true)
    const depth3 = depth2?.subcommands.find((n) => n.path.join(" ") === "next next next")
    expect(depth3?.explored).toBe(false)
  })

  it("caps recursion at maxProbes — unreached nodes stay explored:false and truncated is set", async () => {
    const rootHelp = [
      "Root.",
      "",
      "USAGE",
      "  tool <command>",
      "",
      "COMMANDS",
      "  a:   A cmd",
      "  b:   B cmd",
      "  c:   C cmd",
      "  d:   D cmd",
      "",
    ].join("\n")
    const responses = new Map<string, CannedResponse>([
      ["/usr/bin/tool --help", { help: rootHelp }],
    ])
    for (const name of ["a", "b", "c", "d"]) {
      responses.set(`/usr/bin/tool ${name} --help`, {
        help: `${name} help.\n\nUSAGE\n  tool ${name}\n`,
      })
    }
    const sandbox = new FakeSandbox(responses)

    // maxProbes:1 → only the root probe runs; every child stays unreached.
    const ceiling: ExtractCeiling = { ...DEFAULT_CEILING, maxProbes: 1 }
    const result = await extractCliSchema({
      binaryPath: "/usr/bin/tool",
      policy: fakePolicy(),
      sandbox,
      ceiling,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.truncated).toBe(true)
    expect(sandbox.runCommandCallCount).toBe(1)
    for (const child of result.value.root.subcommands) {
      expect(child.explored).toBe(false)
    }
  })

  it("respects wallClockMs — stops enqueueing once the wall clock is exceeded", async () => {
    const rootHelp = [
      "Root.",
      "",
      "USAGE",
      "  tool <command>",
      "",
      "COMMANDS",
      "  a:   A cmd",
      "",
    ].join("\n")
    const responses = new Map<string, CannedResponse>([
      ["/usr/bin/tool --help", { help: rootHelp }],
      ["/usr/bin/tool a --help", { help: "a help.\n\nUSAGE\n  tool a\n" }],
    ])
    const sandbox = new FakeSandbox(responses)

    // wallClockMs:0 → elapsed() is already >= 0 by the time withinCeiling is
    // checked, so no child should ever be enqueued (root is always probed once).
    const ceiling: ExtractCeiling = { ...DEFAULT_CEILING, wallClockMs: 0 }
    const result = await extractCliSchema({
      binaryPath: "/usr/bin/tool",
      policy: fakePolicy(),
      sandbox,
      ceiling,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    expect(result.value.truncated).toBe(true)
    const a = result.value.root.subcommands.find((n) => n.path.join(" ") === "a")
    expect(a?.explored).toBe(false)
  })

  it("loop detection: identical help text to an ancestor stops that branch from recursing", async () => {
    // root -> loop (help IDENTICAL to root's, modulo whitespace) -> would list "loop" again,
    // but loop detection must stop before enqueueing loop's own "loop" child.
    const rootHelp = [
      "Cyclic tool.",
      "",
      "USAGE",
      "  tool <command>",
      "",
      "COMMANDS",
      "  loop:   Enter the loop",
      "",
    ].join("\n")
    const sandbox = new FakeSandbox(
      new Map([
        ["/usr/bin/tool --help", { help: rootHelp }],
        // Same normalized text as root (loop detection hashes normalized rawHelp).
        ["/usr/bin/tool loop --help", { help: rootHelp }],
      ]),
    )

    const result = await extractCliSchema({
      binaryPath: "/usr/bin/tool",
      policy: fakePolicy(),
      sandbox,
    })
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return

    const loopNode = result.value.root.subcommands.find((n) => n.path.join(" ") === "loop")
    expect(loopNode?.explored).toBe(true) // it WAS probed
    expect(loopNode?.subcommands).toEqual([]) // but not recursed into again
    // Only 2 probes total: root + loop (the cycle never re-enqueues "loop loop").
    expect(sandbox.runCommandCallCount).toBe(2)
  })

  it("never aborts on a per-node spawn failure — absorbs it into a parsed:false/explored:false node", async () => {
    const rootHelp = [
      "Root.",
      "",
      "USAGE",
      "  tool <command>",
      "",
      "COMMANDS",
      "  broken:   Will fail to probe",
      "",
    ].join("\n")
    const sandbox = new FakeSandbox(
      new Map<string, CannedResponse>([
        ["/usr/bin/tool --help", { help: rootHelp }],
        ["/usr/bin/tool broken --help", { spawnFail: true }],
      ]),
    )

    const result = await extractCliSchema({
      binaryPath: "/usr/bin/tool",
      policy: fakePolicy(),
      sandbox,
    })
    // extractCliSchema itself must still resolve Ok — only a ROOT refusal propagates as Err.
    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value.truncated).toBe(true)
    const broken = result.value.root.subcommands.find((n) => n.path.join(" ") === "broken")
    expect(broken?.parsed).toBe(false)
  })

  it("propagates Err when the ROOT probe itself hits a hard sandbox refusal", async () => {
    const sandbox = new FakeSandbox(
      new Map<string, CannedResponse>([["/usr/bin/tool --help", { spawnFail: true }]]),
    )
    const result = await extractCliSchema({
      binaryPath: "/usr/bin/tool",
      policy: fakePolicy(),
      sandbox,
    })
    expect(result.isErr()).toBe(true)
  })
})
