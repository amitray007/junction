// SPDX-License-Identifier: AGPL-3.0-only
// argKeys / hashArgs — pure, value-free summaries of a tool call's args for
// audit correlation (increment 31 §0 decision 1 + A4).
//
// HONEST FRAMING (do NOT overclaim): the hash is for CORRELATION/DEDUP, NOT
// confidentiality. For a LOW-entropy args object (e.g. {enabled:true},
// {status:"open"}) the unsalted hash IS brute-forceable — an attacker can
// enumerate the few possible objects and match hashes, effectively reversing
// a low-entropy value. This is acceptable because (a) a real secret arg is
// high-entropy (safe against this), and (b) the actual protection this
// increment relies on is that VALUES ARE NEVER LOGGED, not the hash's
// one-wayness. Never describe this hash as "not reversible" — it is
// reversible for low-entropy inputs by design of any unsalted hash.
//
// Neither function ever returns an argument VALUE — only key names or a hash.

import { createHash } from "node:crypto"

/** Stable sentinel hash for an empty (or absent) args object. */
const EMPTY_ARGS_SENTINEL = createHash("sha256").update("{}").digest("hex")

/** Sorted arg key names — never values. */
export function argKeys(args: Record<string, unknown>): string[] {
  return Object.keys(args).sort()
}

/**
 * SHA-256 hex of a STABLE JSON serialization of `args` — sorted keys so the
 * same logical args object hashes identically regardless of key order.
 * Never returns or serializes any value beyond what feeds the digest; the
 * digest itself is the only output.
 */
export function hashArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  if (keys.length === 0) return EMPTY_ARGS_SENTINEL

  const stable: Record<string, unknown> = {}
  for (const key of keys) {
    stable[key] = args[key]
  }
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex")
}
