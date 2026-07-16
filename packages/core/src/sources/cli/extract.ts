// SPDX-License-Identifier: AGPL-3.0-only
// Sandboxed recursive --help extractor — "Junction learns the CLI once"
// (docs/specs/2026-07-16-cli-exploratory-mode.md §4 Layer 2, §5 Q3/Q4/Q5).
//
// SECURITY-CRITICAL: read docs/methods/41.2-cli-help-extractor.md before editing.
//
// Safe-probe policy (Fable Q3 — binding): every probe is
// `<binaryPath> [...path] --help` run under a policy DERIVED from the
// platform CliPolicy but HARDENED to the safe-probe class: allowNet:[], no
// credential env (never call prepareCredential; env carries only non-secret
// envAllow statics, never a *_TOKEN/_SECRET/_KEY key), writePaths:[], and
// timeoutMs = min(ceiling.perProbeTimeoutMs, policy.timeoutMs). This is the
// invocation class Fable ruled safe (pinned binary + --help + no creds + no
// net + read-only). The "cli not-verifiable" rule
// (packages/source-runtime/src/verify-credential.ts:246) now scopes to
// credentialed+networked invocations only — this safe-probe class is exempt.
//
// Recursion (Fable Q4 — binding): bounded by depth/probe-count/wall-clock;
// loop-detected via a normalized-help hash compared against ANCESTORS only;
// ceilings never abort — unreached nodes persist as explored:false and are
// probed lazily later (probeNode) under the same limits.
//
// Parser (Fable Q5 — binding): best-effort; a node is NEVER dropped and
// extraction NEVER throws. Total parse failure → parsed:false + rawHelp kept.
//
// Sandbox-always: extraction NEVER shells out directly — every probe goes
// through the injected Sandbox.runCommand. No child_process import here.

import { createHash } from "node:crypto"
import type { SandboxError } from "../../errors/index.js"
import { err, ok, type Result, ResultAsync } from "../../result/index.js"
import type { Sandbox, SandboxPolicy } from "../../sandbox/index.js"
import type { CliPolicy } from "../../schema/cli-connection.js"
import type { CliFlag, CliSchemaNode, ExtractedCliSchema } from "../../schema/cli-schema.js"

// ---------------------------------------------------------------------------
// ExtractCeiling — bounds on the recursive probe (Fable Q4)
// ---------------------------------------------------------------------------

export type ExtractCeiling = {
  maxDepth: number
  maxProbes: number
  perProbeTimeoutMs: number
  wallClockMs: number
}

export const DEFAULT_CEILING: ExtractCeiling = {
  maxDepth: 5,
  maxProbes: 400,
  perProbeTimeoutMs: 10_000,
  wallClockMs: 300_000,
}

// ---------------------------------------------------------------------------
// ParsedHelpNode — the generic parser's pure output shape
// ---------------------------------------------------------------------------

/** Pure parse result for one node's raw --help text. Never thrown; always returned. */
export interface ParsedHelpNode {
  parsed: boolean
  description?: string
  usage?: string
  flags: CliFlag[]
  positionals: { name: string; description?: string }[]
  /** Discovered subcommand names + one-line summaries (not full nodes — recursion builds those). */
  subcommands: { name: string; summary?: string }[]
}

function emptyParsedHelpNode(): ParsedHelpNode {
  return { parsed: false, flags: [], positionals: [], subcommands: [] }
}

// ---------------------------------------------------------------------------
// HelpExtractor — pluggable parser interface (Junction core stays LLM-free)
// ---------------------------------------------------------------------------

export interface HelpExtractor {
  /** Parse one node's raw --help text into structured fields. Returns parsed:false + rawHelp on failure. */
  parseHelp(rawHelp: string, path: string[]): ParsedHelpNode
}

// ---------------------------------------------------------------------------
// genericHelpExtractor — best-effort parser for common CLI --help conventions
// (gh/git/docker/kubectl style: USAGE, Commands:/CORE COMMANDS/etc sections,
// Flags:/FLAGS/Options: sections). Pure function over a string — no I/O.
// ---------------------------------------------------------------------------

// Section headers that introduce a subcommand-listing block. gh's --help
// output uses several distinctly-named sections for the same structural
// purpose (CORE COMMANDS, GITHUB ACTIONS COMMANDS, ALIAS COMMANDS, etc) — we
// treat ANY all-caps header ending in "COMMANDS" as a subcommand section, plus
// the common lowercase git/docker/kubectl spellings.
const COMMAND_SECTION_RE = /^(?:[A-Z0-9-]+ )*COMMANDS$|^(Available )?Commands:$|^SUBCOMMANDS$/

// Section headers that introduce a flag-listing block.
const FLAGS_SECTION_RE = /^(FLAGS|INHERITED FLAGS|Flags:|Options:|Global Options:)$/

// Any other all-caps or "Title:" section header — used to detect the END of
// the current section (commands/flags run until the next header or blank-run).
const GENERIC_SECTION_HEADER_RE = /^[A-Z][A-Za-z0-9 /-]*:?$/

const USAGE_HEADER_RE = /^(USAGE|Usage:)$/

/** True if `line` (already trimmed) looks like a new top-level section header. */
function isSectionHeader(line: string): boolean {
  if (line === "") return false
  // A section header has no leading whitespace in the ORIGINAL line — callers
  // pass the untrimmed line's leading-whitespace test separately; here we just
  // check the textual shape.
  return (
    USAGE_HEADER_RE.test(line) ||
    COMMAND_SECTION_RE.test(line) ||
    FLAGS_SECTION_RE.test(line) ||
    GENERIC_SECTION_HEADER_RE.test(line)
  )
}

/** Parse one "name:   summary" or "name   summary" command-listing row. Returns null if it doesn't look like one. */
function parseCommandRow(line: string): { name: string; summary?: string } | null {
  const trimmed = line.trim()
  if (trimmed === "") return null
  // gh style: "auth:          Authenticate gh and git with GitHub"
  const colonMatch = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(trimmed)
  if (colonMatch?.[1]) {
    return { name: colonMatch[1], summary: colonMatch[2] || undefined }
  }
  // git/docker style: "commit      Record changes to the repository" (2+ space gap, no colon)
  const gapMatch = /^([a-zA-Z][a-zA-Z0-9_-]*)\s{2,}(.*)$/.exec(trimmed)
  if (gapMatch?.[1]) {
    return { name: gapMatch[1], summary: gapMatch[2] || undefined }
  }
  return null
}

/**
 * Parse one flag-listing row. Handles:
 *   "  -a, --assignee login   Description"   (alias, name, value-placeholder → takesValue:true)
 *   "      --dry-run          Description"   (no alias, no placeholder → takesValue:false)
 *   "  -d, --draft            Description"   (alias, no placeholder → takesValue:false)
 * Returns null if the line doesn't look like a flag row.
 */
function parseFlagRow(line: string): CliFlag | null {
  const trimmed = line.trim()
  if (trimmed === "") return null
  if (!trimmed.startsWith("-")) return null

  // Split the flag token(s) from the description by a 2+-space gap.
  const gapIdx = trimmed.search(/\s{2,}/)
  const tokenPart = gapIdx === -1 ? trimmed : trimmed.slice(0, gapIdx)
  const restPart = gapIdx === -1 ? "" : trimmed.slice(gapIdx).trim()

  // tokenPart looks like: "-a, --assignee login" or "--dry-run" or "-t, --title string"
  const parts = tokenPart.split(",").map((p) => p.trim())
  let alias: string | undefined
  let name: string | undefined
  let valuePlaceholder = false
  const description = restPart || undefined

  for (const part of parts) {
    const m = /^(-{1,2}[A-Za-z0-9-]+)(?:[= ](.+))?$/.exec(part)
    if (!m) continue
    const flagToken = m[1]
    if (!flagToken) continue
    const valueToken = m[2]
    if (flagToken.startsWith("--")) {
      name = flagToken
    } else {
      alias = flagToken
    }
    if (valueToken !== undefined && valueToken.trim() !== "") {
      valuePlaceholder = true
    }
  }

  if (name === undefined && alias === undefined) return null
  // Fallback: if only an alias was found (rare), use it as name too so the
  // node still carries a usable identifier — never drop a discovered flag.
  const finalName = name ?? alias
  if (finalName === undefined) return null

  return {
    name: finalName,
    ...(name !== undefined && alias !== undefined ? { alias } : {}),
    takesValue: valuePlaceholder,
    ...(description !== undefined ? { description } : {}),
  }
}

export const genericHelpExtractor: HelpExtractor = {
  parseHelp(rawHelp: string): ParsedHelpNode {
    try {
      if (typeof rawHelp !== "string" || rawHelp.trim() === "") {
        return emptyParsedHelpNode()
      }

      const lines = rawHelp.split("\n")
      let usage: string | undefined
      let description: string | undefined
      const subcommands: { name: string; summary?: string }[] = []
      const flags: CliFlag[] = []

      // Description: the leading non-blank paragraph before the first section header.
      const descLines: string[] = []
      let i = 0
      while (i < lines.length) {
        const raw = lines[i] ?? ""
        const trimmed = raw.trim()
        if (trimmed === "") {
          if (descLines.length > 0) break
          i++
          continue
        }
        if (isSectionHeader(trimmed)) break
        descLines.push(trimmed)
        i++
      }
      if (descLines.length > 0) {
        description = descLines.join(" ")
      }

      // Walk remaining lines, section by section.
      let mode: "none" | "usage" | "commands" | "flags" = "none"
      for (; i < lines.length; i++) {
        const raw = lines[i] ?? ""
        const trimmed = raw.trim()

        if (trimmed === "") {
          // Blank line ends the current listing section (but not "none").
          if (mode !== "none") mode = "none"
          continue
        }

        if (USAGE_HEADER_RE.test(trimmed)) {
          mode = "usage"
          continue
        }
        if (COMMAND_SECTION_RE.test(trimmed)) {
          mode = "commands"
          continue
        }
        if (FLAGS_SECTION_RE.test(trimmed)) {
          mode = "flags"
          continue
        }
        if (GENERIC_SECTION_HEADER_RE.test(trimmed) && trimmed === trimmed.toUpperCase()) {
          // An unrecognized ALL-CAPS header (EXAMPLES, ARGUMENTS, LEARN MORE, ...) —
          // stop listing under it; we don't parse its body.
          mode = "none"
          continue
        }

        if (mode === "usage") {
          // First non-blank usage line; keep only the first (gh/git emit one line).
          if (usage === undefined) usage = trimmed
          continue
        }
        if (mode === "commands") {
          const row = parseCommandRow(raw)
          if (row) subcommands.push(row)
          continue
        }
        if (mode === "flags") {
          const flag = parseFlagRow(raw)
          if (flag) flags.push(flag)
        }
        // mode === "none" — ignore (examples/prose/etc).
      }

      const hasStructure = usage !== undefined || subcommands.length > 0 || flags.length > 0
      if (!hasStructure) {
        return emptyParsedHelpNode()
      }

      return {
        parsed: true,
        ...(description !== undefined ? { description } : {}),
        ...(usage !== undefined ? { usage } : {}),
        flags,
        positionals: [],
        subcommands,
      }
    } catch {
      // Fable Q5: NEVER throw. Total failure → parsed:false, caller keeps rawHelp.
      return emptyParsedHelpNode()
    }
  },
}

// ---------------------------------------------------------------------------
// Help-hash — normalized rawHelp hash for ancestor-loop detection (Fable Q4)
// ---------------------------------------------------------------------------

function normalizeHelpText(rawHelp: string): string {
  return rawHelp.trim().replace(/\s+/g, " ")
}

function computeHelpHash(rawHelp: string): string {
  return createHash("sha256").update(normalizeHelpText(rawHelp), "utf8").digest("hex")
}

// ---------------------------------------------------------------------------
// Safe-probe policy derivation (Fable Q3 — binding)
// ---------------------------------------------------------------------------

function deriveProbePolicy(policy: CliPolicy, ceiling: ExtractCeiling): SandboxPolicy {
  return {
    cwd: policy.cwd,
    readPaths: policy.readPaths,
    // Read-only: no writes permitted for a --help probe, regardless of the
    // platform policy's writePaths (which may grant writes for real execute calls).
    writePaths: [],
    // No network — a --help probe never needs it, and this is the hard
    // safe-probe guarantee Fable ruled on.
    allowNet: [],
    // No credential env — never call prepareCredential; only non-secret
    // envAllow statics ride along (validatePolicy still denylists secret-shaped keys).
    env: { ...policy.envAllow },
    timeoutMs: Math.min(ceiling.perProbeTimeoutMs, policy.timeoutMs),
  }
}

// ---------------------------------------------------------------------------
// probeNode — single-node lazy probe (Fable Q4: used for on-demand exploration
// of an explored:false node, and internally by extractCliSchema's recursion)
// ---------------------------------------------------------------------------

/**
 * Probe exactly one node's --help text and parse it. NEVER throws and NEVER
 * propagates a spawn/timeout failure as an Err — per Fable Q5 a node is never
 * dropped: a failed spawn/timeout still yields an Ok node with parsed:false
 * and whatever rawHelp (possibly empty) came back. The Err channel is
 * reserved for a policy-invalid refusal (a hardening bug in this file, not a
 * runtime CLI condition) or a sandbox-unavailable/unsupported-platform
 * refusal — conditions the caller cannot route around by trying a different
 * argv.
 */
export function probeNode(args: {
  binaryPath: string
  policy: CliPolicy
  sandbox: Sandbox
  path: string[]
  extractor?: HelpExtractor
  ceiling?: ExtractCeiling
}): ResultAsync<CliSchemaNode, SandboxError> {
  const ceiling = args.ceiling ?? DEFAULT_CEILING
  const extractor = args.extractor ?? genericHelpExtractor
  const probePolicy = deriveProbePolicy(args.policy, ceiling)
  const argv = [args.binaryPath, ...args.path, "--help"]

  return args.sandbox.runCommand(argv, probePolicy).andThen((result) => {
    // A hard sandbox-level refusal (policy-invalid / unsupported-platform /
    // runtime-unavailable) never reaches here — runCommand already rejects
    // those before spawning, and THOSE are the only errors we propagate.
    const rawHelp = (result.stdout + result.stderr).trim()
    const parsedNode = extractor.parseHelp(rawHelp, args.path)
    const node: CliSchemaNode = {
      path: args.path,
      parsed: parsedNode.parsed,
      explored: true,
      ...(parsedNode.description !== undefined ? { description: parsedNode.description } : {}),
      ...(parsedNode.usage !== undefined ? { usage: parsedNode.usage } : {}),
      flags: parsedNode.flags,
      positionals: parsedNode.positionals,
      subcommands: [],
      rawHelp,
      helpHash: computeHelpHash(rawHelp),
    }
    return new ResultAsync(Promise.resolve(ok<CliSchemaNode, SandboxError>(node)))
  })
}

// ---------------------------------------------------------------------------
// extractCliSchema — bounded recursive extraction from root (Fable Q4)
// ---------------------------------------------------------------------------

type QueueItem = { path: string[]; depth: number; ancestorHashes: string[] }

export function extractCliSchema(args: {
  binaryPath: string
  policy: CliPolicy
  sandbox: Sandbox
  extractor?: HelpExtractor
  ceiling?: ExtractCeiling
}): ResultAsync<ExtractedCliSchema, SandboxError> {
  const ceiling = args.ceiling ?? DEFAULT_CEILING
  const extractor = args.extractor ?? genericHelpExtractor
  const startTime = performance.now()

  // Map from joined path ("" for root, "pr/create" for nested) to the node,
  // built up as probes complete — lets us attach children to their parent
  // regardless of probe order.
  const nodesByPath = new Map<string, CliSchemaNode>()
  let truncated = false
  let probeCount = 0

  function pathKey(path: string[]): string {
    return path.join(" ")
  }

  function elapsed(): number {
    return performance.now() - startTime
  }

  function withinCeiling(depth: number): boolean {
    return (
      depth < ceiling.maxDepth && probeCount < ceiling.maxProbes && elapsed() < ceiling.wallClockMs
    )
  }

  // The FIRST probe (the root) is special: if the sandbox refuses at this
  // hard-boundary level (policy-invalid / unsupported-platform /
  // runtime-unavailable), NO probe for this binary can ever succeed — that
  // is a caller-configuration problem, not a per-node CLI condition, so it
  // is the one case extractCliSchema propagates as Err. Every subsequent
  // probe failure (spawn-failed/timed-out on an individual subcommand) is
  // instead absorbed into a parsed:false/explored:false node — Fable Q4/Q5:
  // never abort, always return a schema.
  let rootRefusal: SandboxError | undefined

  async function run(): Promise<CliSchemaNode> {
    const queue: QueueItem[] = [{ path: [], depth: 0, ancestorHashes: [] }]
    let isFirstProbe = true

    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) break

      const probeResult = await probeNode({
        binaryPath: args.binaryPath,
        policy: args.policy,
        sandbox: args.sandbox,
        path: item.path,
        extractor,
        ceiling,
      })
      probeCount++

      if (probeResult.isErr()) {
        if (isFirstProbe) {
          rootRefusal = probeResult.error
          break
        }
        // A non-root probe hit a hard sandbox refusal — surface a stub node
        // (explored:false, parsed:false) rather than lose the branch, and mark
        // the whole extraction truncated. Never abort past the root.
        truncated = true
        nodesByPath.set(pathKey(item.path), {
          path: item.path,
          parsed: false,
          explored: false,
          flags: [],
          positionals: [],
          subcommands: [],
        })
        isFirstProbe = false
        continue
      }
      isFirstProbe = false

      const node = probeResult.value
      const helpHash = node.helpHash

      // Loop detection: if this node's help text hashes identically to any
      // ANCESTOR's, do not recurse into its subcommands — but the node
      // itself IS explored (we did probe it).
      const isLoop = helpHash !== undefined && item.ancestorHashes.includes(helpHash)

      // Re-parse subcommand names from the raw help via the extractor (we
      // need the shallow name/summary list, which probeNode's CliSchemaNode
      // shape doesn't carry — only genericHelpExtractor's ParsedHelpNode
      // does). Cheap: pure re-parse of text already in memory, no re-probe.
      const parsedForChildren = extractor.parseHelp(node.rawHelp ?? "", item.path)

      if (isLoop || parsedForChildren.subcommands.length === 0) {
        nodesByPath.set(pathKey(item.path), node)
        continue
      }

      const childNodes: CliSchemaNode[] = []
      const nextAncestorHashes =
        helpHash !== undefined ? [...item.ancestorHashes, helpHash] : item.ancestorHashes

      for (const child of parsedForChildren.subcommands) {
        const childPath = [...item.path, child.name]
        // Unexplored placeholder for this child — replaced once its queued probe
        // completes. Kept so subcommands[] order is stable and every discovered
        // child is present even if the queue never reaches it (ceiling hit
        // mid-flight). Identical shape whether we queue it or defer it as truncated.
        const unexplored: CliSchemaNode = {
          path: childPath,
          parsed: false,
          explored: false,
          ...(child.summary !== undefined ? { description: child.summary } : {}),
          flags: [],
          positionals: [],
          subcommands: [],
        }
        if (withinCeiling(item.depth)) {
          queue.push({ path: childPath, depth: item.depth + 1, ancestorHashes: nextAncestorHashes })
        } else {
          truncated = true
        }
        childNodes.push(unexplored)
      }

      nodesByPath.set(pathKey(item.path), { ...node, subcommands: childNodes })
    }

    // Wall-clock/probe-count ceiling may have left queued items unreached —
    // those are still represented as explored:false placeholders attached to
    // their parent above, so nothing is lost; just mark truncated if the
    // queue drained early due to a ceiling rather than exhaustion.
    if (queue.length > 0) truncated = true

    // Stitch the final tree: walk from root, replacing each node's
    // subcommands with the CURRENT (possibly-probed) version from
    // nodesByPath, falling back to the placeholder already stored on the
    // parent if a child was never dequeued.
    function stitch(path: string[]): CliSchemaNode {
      const stored = nodesByPath.get(pathKey(path))
      if (!stored) {
        // Should not happen (root is always probed first) — defensive fallback.
        return { path, parsed: false, explored: false, flags: [], positionals: [], subcommands: [] }
      }
      return {
        ...stored,
        subcommands: stored.subcommands.map((child) => {
          const resolved = nodesByPath.get(pathKey(child.path))
          return resolved ? stitch(child.path) : child
        }),
      }
    }

    return stitch([])
  }

  return new ResultAsync(
    run().then((root): Result<ExtractedCliSchema, SandboxError> => {
      if (rootRefusal !== undefined) {
        return err(rootRefusal)
      }
      return ok({
        binaryName: args.binaryPath.split("/").pop() ?? args.binaryPath,
        extractedAt: new Date().toISOString(),
        root,
        truncated,
      })
    }),
  )
}
