// SPDX-License-Identifier: AGPL-3.0-only
// Audit server function wrapper — GET endpoint for the /audit page (increment
// 32.6b). Routes MUST NOT import @junction/core or audit.server.ts directly.
//
// A DEDICATED file (not data.functions.ts) — this slice shares zero files with
// the 32.6a app-detail slice, keeping the two worktrees collision-free.
//
// The server-fn takes only the coarse tail bound (`since`/`limit`) — finer
// profile/key/tool/text filtering happens client-side in the table via
// useTableView (matches how /credentials filters client-side over a loaded
// set). If the log is huge, `since` narrows the read server-side.

import { createServerFn } from "@tanstack/react-start"
import { readAudit } from "./audit.server.js"
import { assertLocalHost } from "./fn-guards.server.js"

// Re-export types so route files can annotate useLoaderData() without a
// direct import from audit.server.ts (which is server-only by convention).
export type { AuditEntryDTO, AuditReadResult } from "./audit.server.js"

/** Sane default: a page-worth of the tail when the route doesn't narrow further. */
const DEFAULT_LIMIT = 200

export const getAudit = createServerFn({ method: "GET" })
  .validator((raw: unknown) => {
    const d = (raw ?? {}) as Record<string, unknown>
    const since = typeof d.since === "string" && d.since.trim() !== "" ? d.since : undefined
    const limit =
      typeof d.limit === "number" && Number.isFinite(d.limit) && d.limit > 0
        ? d.limit
        : DEFAULT_LIMIT
    return { since, limit }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    return readAudit(data)
  })
