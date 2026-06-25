// SPDX-License-Identifier: AGPL-3.0-only
// Shared DB-error primitive. dry.md: DRY primitives eagerly — this is the single
// driver-error → DbError mapping, not a generic Repository base (repos stay separate).

import type { DbError } from "../errors/index.js"

export function mapDbError(cause: unknown): DbError {
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof (cause as { code?: unknown }).code === "string" &&
    (cause as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  ) {
    return { kind: "constraint-violation", cause }
  }
  // Fallback: message substring (for drivers that don't expose .code)
  if (cause instanceof Error && cause.message.includes("UNIQUE")) {
    return { kind: "constraint-violation", cause }
  }
  return { kind: "query-failed", cause }
}
