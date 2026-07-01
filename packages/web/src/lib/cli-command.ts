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

// ---------------------------------------------------------------------------
// Shared CLI-tool shape — the arg-declaration + sandbox-policy fields that BOTH
// the client form-state (cli-form/convert.ts) and the server assembler
// (platform-mutations.server.ts) mirror. Defined once here (client-safe, no core
// import) so the two boundaries share one structural type instead of duplicating
// it. Mirrors core's CliArgSchema / CliPolicySchema shape (validated server-side).
// ---------------------------------------------------------------------------

export type CliArgType = "string" | "number" | "boolean" | "enum" | "path"

export interface CliArgInput {
  name: string
  description?: string
  type: CliArgType
  required: boolean
  enum?: string[]
  pattern?: string
  maxLength?: number
}

export interface CliPolicyInput {
  cwd: string
  readPaths: string[]
  writePaths: string[]
  network: { mode: "denied" } | { mode: "allow"; hosts: string[] }
  timeoutMs: number
  envAllow: Record<string, string>
}

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
  return splitTokens(commandLine).map(classifyToken)
}

/**
 * One whitespace-delimited token, with whether ANY of it came from inside a
 * quoted section. `quoted` is load-bearing: a token that was quoted is ALWAYS a
 * literal (quoting is how the operator says "this is not an arg slot"), so
 * `$foo` inside quotes stays a literal instead of being read as an arg. This is
 * what makes tokenize the exact inverse of argvToCommandLine.
 */
interface RawToken {
  readonly text: string
  readonly quoted: boolean
}

/**
 * Split respecting "..."/'...' quoted sections + backslash escapes. A quoted
 * section (incl. internal whitespace) is part of one token; inside double
 * quotes, `\"` and `\\` are escapes (so a literal containing a quote or a
 * backslash round-trips). A token is marked `quoted` if any part was quoted.
 */
function splitTokens(input: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    while (i < n && /\s/.test(input[i] as string)) i++
    if (i >= n) break

    let text = ""
    let quoted = false
    while (i < n && !/\s/.test(input[i] as string)) {
      const ch = input[i] as string
      if (ch === '"' || ch === "'") {
        const quote = ch
        quoted = true
        i++ // opening quote
        while (i < n && input[i] !== quote) {
          // Inside double quotes, honour \" and \\ escapes so quotes/backslashes
          // in a literal survive the round-trip (single quotes are literal-verbatim).
          if (quote === '"' && input[i] === "\\" && i + 1 < n) {
            const next = input[i + 1] as string
            if (next === '"' || next === "\\") {
              text += next
              i += 2
              continue
            }
          }
          text += input[i]
          i++
        }
        if (i < n) i++ // closing quote
      } else {
        text += ch
        i++
      }
    }
    tokens.push({ text, quoted })
  }

  return tokens
}

/** Match the whole token against `$name`, capturing an optional literal prefix. */
const ARG_TOKEN_RE = /^(.*)\$([a-z][a-z0-9_]*)$/

function classifyToken(token: RawToken): CliArgvSegment {
  // A quoted token is ALWAYS a literal — quoting is the operator's explicit
  // "not an arg slot" marker, so a literal like "$foo" round-trips as a literal.
  if (!token.quoted) {
    const match = ARG_TOKEN_RE.exec(token.text)
    if (match) {
      const [, prefix, name] = match as unknown as [string, string, string]
      if (ARG_NAME_RE.test(name)) {
        return prefix === "" ? { kind: "arg", name } : { kind: "arg", name, prefix }
      }
    }
  }
  return { kind: "literal", value: token.text }
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

/**
 * Wrap in double quotes if the literal needs it to round-trip. A literal needs
 * quoting when it's empty or contains whitespace, `$`, or a quote character.
 * Backslash and double-quote are escaped (matching splitTokens' `\\`/`\"`
 * un-escaping) so a literal containing either survives the round-trip.
 */
function quoteLiteralIfNeeded(value: string): string {
  const needsQuoting = value === "" || /[\s$"'\\]/.test(value)
  if (!needsQuoting) return value
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
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
 * A tool's argv is reversible through the guided command-line editor iff EVERY
 * segment round-trips through argvToCommandLine → tokenizeCommandLine:
 *   - every {kind:"arg"} references a DISTINCT arg name (two argv segments naming
 *     the same arg can't map back to two independent command-line positions),
 *   - every {kind:"arg"} name is present in the tool's declared args[], AND
 *   - every {kind:"arg"} prefix is "safe" — no whitespace / quote / `$` — because
 *     a prefix carrying those would re-tokenize into different segments.
 * (Literal contents no longer break reversibility — the tokenizer/serializer are
 * true inverses for literals via quoting + escaping. Prefix is the one arg field
 * the serializer emits UNQUOTED, so it's the remaining reversibility hazard.)
 * Tools failing any check get a read-only notice + a per-tool JSON escape hatch
 * in the guided form (they are NOT auto-corrected).
 */
const UNSAFE_PREFIX_RE = /[\s$"']/

export function isReversible(tool: ReversibilityCheckTool): boolean {
  const declaredNames = new Set(tool.args.map((a) => a.name))
  const seenArgNames = new Set<string>()
  for (const segment of tool.argv) {
    if (segment.kind !== "arg") continue
    if (!declaredNames.has(segment.name)) return false
    if (seenArgNames.has(segment.name)) return false
    if (segment.prefix !== undefined && UNSAFE_PREFIX_RE.test(segment.prefix)) return false
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
