// SPDX-License-Identifier: AGPL-3.0-only
// ExtractedCliSchema — the persisted recursive --help tree for a Full CLI
// access platform (design spec docs/specs/2026-07-16-cli-exploratory-mode.md,
// Fable Q2/Q4/Q5). Data only — no extractor/provider logic lives here.
//
// Fable Q5 (binding): ONE schema tree, always present. Every node carries
// parsed:true|false; a node is NEVER dropped even if the generic parser
// failed on it or it wasn't (yet) probed. rawHelp is always persisted; the
// `help` MCP tool (41.3) decides when to surface it to the agent — that
// projection policy does not live in this file.

import { z } from "zod"

// ---------------------------------------------------------------------------
// CliFlag — one flag documented on a schema node
// ---------------------------------------------------------------------------

export const CliFlagSchema = z.object({
  /** Long flag form, e.g. "--title". */
  name: z.string(),
  /** Short alias, e.g. "-t". */
  alias: z.string().optional(),
  /** Whether the flag takes a value (vs. a boolean switch). */
  takesValue: z.boolean(),
  description: z.string().optional(),
})

export type CliFlag = z.infer<typeof CliFlagSchema>

// ---------------------------------------------------------------------------
// CliSchemaNode — one node (root or subcommand) in the extracted --help tree
// ---------------------------------------------------------------------------

/**
 * One node in the extracted command tree. Recursive via subcommands — declared
 * explicitly because z.lazy() defeats z.infer's recursive inference.
 *
 * Fable Q4 (probe ceiling): explored:false marks a node the extractor decided
 * not to (yet) recurse into (depth/probe/time ceiling hit, or loop-detected).
 * Such a node is never dropped — it is persisted with empty flags/positionals/
 * subcommands and probed lazily on first `help` call under the same limits.
 *
 * Fable Q5: parsed:false means the generic best-effort parser could not
 * extract structure from this node's raw help text. rawHelp is always stored;
 * it is surfaced to the agent only when parsed is false (41.3 concern).
 */
export interface CliSchemaNode {
  /** Subcommand path from the binary root, e.g. ["pr","create"]; [] = root. */
  path: string[]
  /** false → the generic parser failed to extract structure for this node. */
  parsed: boolean
  /** false → ceiling/lazy: not yet probed (Fable Q4). */
  explored: boolean
  description?: string
  usage?: string
  flags: CliFlag[]
  positionals: { name: string; description?: string }[]
  /** FULL child nodes on disk — the `help` tool's shallow name+summary index is a separate projection (41.3), not this shape. */
  subcommands: CliSchemaNode[]
  /** Raw --help text. Always persisted; returned to the agent only when parsed:false. */
  rawHelp?: string
  /** Hash of normalized help text — used for ancestor-loop detection during extraction (Fable Q4). */
  helpHash?: string
}

export const CliSchemaNodeSchema: z.ZodType<CliSchemaNode> = z.lazy(() =>
  z.object({
    path: z.array(z.string()),
    parsed: z.boolean(),
    explored: z.boolean(),
    description: z.string().optional(),
    usage: z.string().optional(),
    flags: z.array(CliFlagSchema).default([]),
    positionals: z
      .array(z.object({ name: z.string(), description: z.string().optional() }))
      .default([]),
    subcommands: z.array(CliSchemaNodeSchema).default([]),
    rawHelp: z.string().optional(),
    helpHash: z.string().optional(),
  }),
)

// ---------------------------------------------------------------------------
// ExtractedCliSchema — the top-level persisted wrapper
// ---------------------------------------------------------------------------

export const ExtractedCliSchemaSchema = z.object({
  /** The resolved binary's display name, e.g. "gh". */
  binaryName: z.string(),
  /** ISO-8601 timestamp of when extraction ran. */
  extractedAt: z.string(),
  root: CliSchemaNodeSchema,
  /** true if a probe/depth/time ceiling was hit during extraction (Fable Q4) — some nodes may be explored:false. */
  truncated: z.boolean(),
})

export type ExtractedCliSchema = z.infer<typeof ExtractedCliSchemaSchema>
