// SPDX-License-Identifier: AGPL-3.0-only
// cli-command.ts — pure command-line tokenizer/serializer for the CLI guided form.
// CLIENT-SAFE: no @junction/core import, no I/O, no state. Used by BOTH the client
// (for the live argv preview, cosmetic/display-only) and the server (as the ONE
// authoritative transform when assembling a CliConnection to parse — see
// platform-mutations.server.ts). The server always re-derives argv from the raw
// commandLine string; it never trusts a client-sent pre-tokenized array.
//
// CliArgvSegment here is a LOCAL structural type mirroring
// @junction/core's CliArgvSegmentSchema shape exactly (not imported — this file
// must stay core-free). The server maps this local shape into the real
// core-imported type when it calls CliConnectionSchema.parse.

export type CliArgvSegment =
  | { kind: "literal"; value: string }
  | { kind: "arg"; name: string; prefix?: string }

const ARG_NAME_RE = /^[a-z][a-z0-9_]*$/

// ---------------------------------------------------------------------------
// tokenizeCommandLine — command-line text → argv segments
// ---------------------------------------------------------------------------

/**
 * Split a command-line string into whitespace-separated tokens, respecting
 * "..."/'...' quoted sections (a quoted section — including any internal
 * whitespace — is one token). Then classify each token:
 *   - exactly `$name` (name matches ^[a-z][a-z0-9_]*$)      → {kind:"arg", name}
 *   - `prefix$name` with a non-empty literal prefix          → {kind:"arg", name, prefix}
 *   - anything else                                          → {kind:"literal", value}
 */
export function tokenizeCommandLine(commandLine: string): CliArgvSegment[] {
  const tokens = splitTokens(commandLine)
  return tokens.map(classifyToken)
}

/** Split respecting "..."/'...' quoted sections; a quoted section is one token. */
function splitTokens(input: string): string[] {
  const tokens: string[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    // Skip leading whitespace
    while (i < n && /\s/.test(input[i] as string)) i++
    if (i >= n) break

    let token = ""
    while (i < n && !/\s/.test(input[i] as string)) {
      const ch = input[i] as string
      if (ch === '"' || ch === "'") {
        const quote = ch
        i++ // consume opening quote
        while (i < n && input[i] !== quote) {
          token += input[i]
          i++
        }
        if (i < n) i++ // consume closing quote
      } else {
        token += ch
        i++
      }
    }
    tokens.push(token)
  }

  return tokens
}

/** Match the whole token against `$name`, capturing an optional literal prefix. */
const ARG_TOKEN_RE = /^(.*)\$([a-z][a-z0-9_]*)$/

function classifyToken(token: string): CliArgvSegment {
  const match = ARG_TOKEN_RE.exec(token)
  if (match) {
    const [, prefix, name] = match as unknown as [string, string, string]
    // Guard: `name` must be the ENTIRE remainder after the last unescaped `$`,
    // and it must match the arg-name pattern (already enforced by the regex
    // char class). Reject if there's a stray `$` earlier in a way that would
    // make this ambiguous — not needed here since the regex is greedy on the
    // prefix and anchored at the end, so this always matches the last `$name`.
    if (ARG_NAME_RE.test(name)) {
      return prefix === "" ? { kind: "arg", name } : { kind: "arg", name, prefix }
    }
  }
  return { kind: "literal", value: token }
}

// ---------------------------------------------------------------------------
// argvToCommandLine — argv segments → command-line text (exact inverse)
// ---------------------------------------------------------------------------

/**
 * Serialize argv segments back into a command-line string. Exact inverse of
 * tokenizeCommandLine: literal → quoted (double-quotes) if it contains
 * whitespace, `$`, or a quote character; arg → (prefix ?? "") + "$" + name.
 * Joined with single spaces.
 */
export function argvToCommandLine(segments: CliArgvSegment[]): string {
  return segments.map(segmentToToken).join(" ")
}

function segmentToToken(segment: CliArgvSegment): string {
  if (segment.kind === "arg") {
    return `${segment.prefix ?? ""}$${segment.name}`
  }
  return quoteLiteralIfNeeded(segment.value)
}

/** Wrap in double quotes (escaping internal `"`) if the literal needs it to round-trip. */
function quoteLiteralIfNeeded(value: string): string {
  const needsQuoting = value === "" || /[\s$"']/.test(value)
  if (!needsQuoting) return value
  const escaped = value.replace(/"/g, '\\"')
  return `"${escaped}"`
}

// ---------------------------------------------------------------------------
// isReversible — detects command descriptors the guided form can't safely
// round-trip (edit-mode escape hatch — see platforms route CLI tool card).
// ---------------------------------------------------------------------------

export interface ReversibilityCheckTool {
  readonly argv: readonly CliArgvSegment[]
  readonly args: readonly { readonly name: string }[]
}

/**
 * A tool's argv is reversible through the guided command-line editor iff:
 *   - every {kind:"arg"} segment references a distinct arg name (no two argv
 *     segments naming the same arg — that can't map back to two independent
 *     command-line positions), AND
 *   - every {kind:"arg"} segment's name is present in the tool's declared args[].
 * Tools failing either check get a read-only notice + a per-tool JSON escape
 * hatch in the guided form (they are NOT auto-corrected).
 */
export function isReversible(tool: ReversibilityCheckTool): boolean {
  const declaredNames = new Set(tool.args.map((a) => a.name))
  const seenArgNames = new Set<string>()
  for (const segment of tool.argv) {
    if (segment.kind !== "arg") continue
    if (!declaredNames.has(segment.name)) return false
    if (seenArgNames.has(segment.name)) return false
    seenArgNames.add(segment.name)
  }
  return true
}

// ---------------------------------------------------------------------------
// argvToChips — the argv, projected for the live preview UI (display-only).
// ---------------------------------------------------------------------------

export interface ArgvPreviewChip {
  readonly kind: "literal" | "arg"
  readonly label: string
}

/** Project argv segments into display chips for the read-only preview row. */
export function argvToChips(segments: CliArgvSegment[]): ArgvPreviewChip[] {
  return segments.map((s) =>
    s.kind === "literal"
      ? { kind: "literal" as const, label: s.value }
      : { kind: "arg" as const, label: `${s.prefix ?? ""}$${s.name}` },
  )
}

// ---------------------------------------------------------------------------
// firstTokenIsAbsolutePath — the "green/red" live check under the preview.
// ---------------------------------------------------------------------------

/** True iff the first argv segment is a literal starting with "/". */
export function firstTokenIsAbsolutePath(segments: CliArgvSegment[]): boolean {
  const first = segments[0]
  return first !== undefined && first.kind === "literal" && first.value.startsWith("/")
}
