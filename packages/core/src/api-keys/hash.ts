// SPDX-License-Identifier: AGPL-3.0-only
// sha256Hex — the single hashing primitive for junction API-key secrets.
// junction keys are junction's OWN secrets (not a replayed upstream credential),
// so one-way SHA-256 is correct — no KDF, no credential-store reuse (§0/§2.1).

import { createHash } from "node:crypto"

/** Hex-encoded SHA-256 digest of the input string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}
