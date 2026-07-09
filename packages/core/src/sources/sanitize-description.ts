// SPDX-License-Identifier: AGPL-3.0-only
// sanitizeDescription — neutralize prompt-injection vectors in an upstream tool description
// BEFORE it reaches the calling agent. NFKC normalize + strip control/format chars (char-code
// loop — NEVER a regex; Biome mangles control-char ranges, gotchas.md) + length cap.
//
// SCOPE (increment 32.5 §0): this is the ONE enforcement point for the "tool poisoning" class
// — a malicious/compromised upstream source stuffing a tool DESCRIPTION with hidden
// instructions, invisible Unicode, or control characters aimed at steering the calling agent.
// It is applied at the proxy chokepoint (proxy.ts listTools), covering every source kind.
//
// DEFERRED: hash-pinning ("rug pull" detection — a previously-seen tool's description/schema
// silently changing between calls) is out of scope this increment; see docs/futures/revisit-when.md.

/**
 * Max description length surfaced to the agent. A real tool description is short; a longer one
 * is either accidental bloat or a hidden-instruction payload. Truncated with an ellipsis marker.
 */
export const DESCRIPTION_MAX_CHARS = 2048 // tune with review; generous for legit tools, caps abuse

export interface SanitizedDescription {
  text: string
  changed: boolean
  truncated: boolean
  strippedSuspicious: boolean
}

// ---------------------------------------------------------------------------
// isStrippable — explicit code-point predicate, NO regex (Biome control-char gotcha)
// ---------------------------------------------------------------------------

/**
 * The invisible "format" class most abused for hidden-instruction smuggling:
 * zero-width spaces/joiners, directional marks, bidi overrides/isolates, the
 * word joiner, BOM/ZWNBSP, and the interlinear annotation anchors.
 */
const FORMAT_CHAR_CODEPOINTS = new Set<number>([
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x202a, // LEFT-TO-RIGHT EMBEDDING
  0x202b, // RIGHT-TO-LEFT EMBEDDING
  0x202c, // POP DIRECTIONAL FORMATTING
  0x202d, // LEFT-TO-RIGHT OVERRIDE
  0x202e, // RIGHT-TO-LEFT OVERRIDE
  0x2060, // WORD JOINER
  0x2066, // LEFT-TO-RIGHT ISOLATE
  0x2067, // RIGHT-TO-LEFT ISOLATE
  0x2068, // FIRST STRONG ISOLATE
  0x2069, // POP DIRECTIONAL ISOLATE
  0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
  0xfff9, // INTERLINEAR ANNOTATION ANCHOR
  0xfffa, // INTERLINEAR ANNOTATION SEPARATOR
  0xfffb, // INTERLINEAR ANNOTATION TERMINATOR
])

/**
 * Explicit predicate for "must be stripped" code points — comparisons + a Set,
 * no regex anywhere (Biome's noControlCharactersInRegex auto-fix mangles
 * control-char ranges in regex literals; see docs/futures/gotchas.md).
 *
 * Strips: C0 controls 0x00–0x1F (INCLUDING \t \n \r — FROZEN DECISION: a tool
 * description is prose, and multi-line structure is exactly what an injection
 * uses to fake a "SYSTEM:" block), DEL 0x7F, C1 controls 0x80–0x9F, and the
 * invisible format class above.
 */
function isStrippable(cp: number): boolean {
  if (cp <= 0x1f) return true // C0 controls, incl. \t \n \r
  if (cp === 0x7f) return true // DEL
  if (cp >= 0x80 && cp <= 0x9f) return true // C1 controls
  return FORMAT_CHAR_CODEPOINTS.has(cp)
}

/**
 * Whitespace-acting C0 controls (\t \n \r, and \v \f for completeness) are
 * stripped as controls (isStrippable above) but must leave a WORD-BOUNDARY
 * space behind — otherwise "Line one\nLine two" collapses to the glued
 * "Line oneLine two" instead of "Line one Line two". Other stripped controls
 * (NUL, BEL, ESC, DEL, C1, invisible-format chars) are pure deletions — they
 * never separated words in legitimate text, so no space is substituted.
 */
function isWhitespaceControl(cp: number): boolean {
  return cp === 0x09 || cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d
}

// ---------------------------------------------------------------------------
// collapseWhitespace — cosmetic ASCII/Unicode whitespace collapse (no regex)
// ---------------------------------------------------------------------------

/**
 * Collapse runs of whitespace to a single space and trim the ends. \t \n \r
 * were already removed as control chars above; this handles the plain space
 * (0x20) and any Unicode space NFKC may have produced. Purely cosmetic — does
 * NOT set strippedSuspicious.
 */
function isWhitespace(cp: number): boolean {
  // Common Unicode space separators (Zs) plus the ASCII space. No regex —
  // consistent with the file-wide char-code-loop discipline.
  if (cp === 0x20) return true
  if (cp === 0xa0) return true // NO-BREAK SPACE
  if (cp >= 0x2000 && cp <= 0x200a) return true // EN QUAD..HAIR SPACE
  if (cp === 0x202f) return true // NARROW NO-BREAK SPACE
  if (cp === 0x205f) return true // MEDIUM MATHEMATICAL SPACE
  if (cp === 0x3000) return true // IDEOGRAPHIC SPACE
  return false
}

function collapseWhitespace(s: string): string {
  let out = ""
  let inRun = false
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (isWhitespace(cp)) {
      if (!inRun) out += " "
      inRun = true
    } else {
      out += ch
      inRun = false
    }
  }
  // Trim leading/trailing single space left by the collapse (no regex — plain
  // char-code checks on the ends).
  let start = 0
  let end = out.length
  while (start < end && out.charCodeAt(start) === 0x20) start++
  while (end > start && out.charCodeAt(end - 1) === 0x20) end--
  return out.slice(start, end)
}

// ---------------------------------------------------------------------------
// sanitizeDescription — pure
// ---------------------------------------------------------------------------

export function sanitizeDescription(raw: string): SanitizedDescription {
  // 1) NFKC normalize (collapse compatibility/confusable forms).
  const normalized = raw.normalize("NFKC")

  // 2) Strip control + format chars via a CHAR-CODE LOOP (no regex — Biome gotcha).
  //    Whitespace-acting controls (\t \n \r \v \f) leave a space behind so word
  //    boundaries survive into the collapse step below; other stripped controls
  //    (NUL, BEL, ESC, DEL, C1, invisible-format chars) are pure deletions.
  let out = ""
  let strippedSuspicious = false
  for (const ch of normalized) {
    // iterate by code POINT (handles astral)
    const cp = ch.codePointAt(0) as number
    if (isStrippable(cp)) {
      strippedSuspicious = true
      if (isWhitespaceControl(cp)) out += " "
      continue
    }
    out += ch
  }

  // 3) Collapse whitespace runs → single space; trim. Cosmetic — does NOT set
  //    strippedSuspicious.
  out = collapseWhitespace(out)

  // 4) Length cap — ASTRAL-SAFE truncation by code point, never a mid-surrogate slice.
  const cps = Array.from(out) // array of code points
  const truncated = cps.length > DESCRIPTION_MAX_CHARS
  const capped = truncated ? `${cps.slice(0, DESCRIPTION_MAX_CHARS - 1).join("")}…` : out

  return { text: capped, changed: capped !== raw, truncated, strippedSuspicious }
}
