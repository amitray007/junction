// SPDX-License-Identifier: AGPL-3.0-only
// naming.ts — shared operation-name helpers for tools.ts and http.ts.

/** Sanitize an operationId to ^[a-zA-Z0-9_-]{1,64}$. */
export function sanitizeOperationId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

/** Derive a fallback name from HTTP method + path (used when operationId is absent). */
export function deriveNameFromMethodPath(method: string, path: string): string {
  const pathPart = path
    .replace(/^\//, "")
    .replace(/\//g, "_")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
  const raw = `${method}_${pathPart}`
  return raw.slice(0, 60) // leave 4 chars for dedup suffix
}
