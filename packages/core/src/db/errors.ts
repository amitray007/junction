// SPDX-License-Identifier: AGPL-3.0-only
// Shared DB-error primitive. dry.md: DRY primitives eagerly — this is the single
// driver-error → DbError mapping, not a generic Repository base (repos stay separate).

import type { DbError } from "../errors/index.js"

export function mapDbError(cause: unknown): DbError {
  if (cause instanceof Error) {
    const code =
      "code" in cause && typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code
        : ""

    // FK constraint (RESTRICT / NO ACTION): "FOREIGN KEY constraint failed".
    // Detect by message because older SQLite (bundled in better-sqlite3 ≤12)
    // may report SQLITE_CONSTRAINT_TRIGGER or SQLITE_CONSTRAINT_FOREIGNKEY
    // depending on the SQLite version — the message is stable across versions.
    // Classified as "in-use" so the CLI can surface a clean "remove sources first" message.
    if (cause.message === "FOREIGN KEY constraint failed") {
      return { kind: "in-use", cause }
    }

    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return { kind: "in-use", cause }
    }

    if (code.startsWith("SQLITE_CONSTRAINT")) {
      return { kind: "constraint-violation", cause }
    }

    // Fallback: message substring (for drivers that don't expose .code)
    if (cause.message.includes("UNIQUE")) {
      return { kind: "constraint-violation", cause }
    }
  }
  return { kind: "query-failed", cause }
}
