// SPDX-License-Identifier: AGPL-3.0-only
// Server-only settings mutation helpers — config-only writes (no DB, no store).
// Called exclusively from settings.functions.ts createServerFn handlers.
// Config writes use the core setMcpHost path (load → merge → atomic save).

import { getPaths, setMcpHost } from "@junction/core"

// ---------------------------------------------------------------------------
// Error message helper — map ConfigError kinds to human-readable strings.
// ---------------------------------------------------------------------------

function configErrorMessage(kind: string): string {
  switch (kind) {
    case "invalid":
      return "Invalid host — expected a hostname or hostname:port"
    case "lock-failed":
      return "Config is locked, try again"
    case "write-failed":
      return "Failed to save settings"
    case "read-failed":
      return "Failed to read settings"
    default:
      return "Operation failed"
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Persist or clear the mcpHost in the Junction config.
 * Pass `undefined` or `""` to clear (removes the key from saved JSON).
 */
export async function mutateSetMcpHost(
  host: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await setMcpHost(getPaths(), host)
  if (result.isErr()) {
    return { ok: false as const, error: configErrorMessage(result.error.kind) }
  }
  return { ok: true as const }
}
