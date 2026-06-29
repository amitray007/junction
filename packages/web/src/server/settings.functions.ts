// SPDX-License-Identifier: AGPL-3.0-only
// Settings mutation server function wrappers — POST endpoint for mcpHost write path.
// Routes MUST NOT import @junction/core or settings.server.ts directly.
//
// Pattern mirrors mutations.functions.ts exactly:
//   validator (pure: trim, allow empty for clear) → handler (assertLocalHost → thin server helper).

import { createServerFn } from "@tanstack/react-start"
import { assertLocalHost } from "./fn-guards.server.js"
import { mutateSetMcpHost } from "./settings.server.js"

// ---------------------------------------------------------------------------
// Server functions (POST — settings mutations)
// ---------------------------------------------------------------------------

export const setMcpHostFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const d = raw as Record<string, unknown>
    // Accept empty string (means CLEAR) — do NOT requireString here.
    // Trim to avoid storing leading/trailing whitespace.
    const host = typeof d.host === "string" ? d.host.trim() : undefined
    return { host }
  })
  .handler(async ({ data }) => {
    assertLocalHost()
    // Pass undefined when host is empty string (clear semantics)
    return mutateSetMcpHost(data.host === "" ? undefined : data.host)
  })
