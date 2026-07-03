// SPDX-License-Identifier: AGPL-3.0-only
// formatUpstreamError — the shared UpstreamError → human string mapping used by
// every surface that runs a source (cli `debug`, web probe/call). Extracted here
// (increment 28) once a 2nd identical copy appeared: the 14 non-tool-not-found
// cases are byte-identical across callers.
//
// The ONE case that legitimately differs is `tool-not-found`, and the difference
// is SECURITY-RELEVANT, so it is injected rather than hard-coded:
//   - cli `debug` (platform-scoped) shows the tool name — useful for debugging.
//   - web probe/call (profile-scoped) collapses it to a generic string, because
//     the profile proxy returns tool-not-found IDENTICALLY for "no such tool" /
//     "denied by toolFilter" / "namespaced name too long" — revealing the name
//     would leak the filter's existence/shape.
// Keeping the map shared but the one message injectable removes the real
// duplication without collapsing that deliberate disclosure difference.

import type { UpstreamError } from "@junction/core"

/**
 * Format an UpstreamError as a human-readable string.
 *
 * @param e - the error to format.
 * @param opts.toolNotFoundMessage - the message for `tool-not-found`. Defaults to
 *   the disclosing form (`tool not found: "<name>"`). Pass a fixed generic string
 *   (e.g. `"tool not found"`) from a profile-scoped / untrusted-facing surface to
 *   avoid leaking whether a filtered tool exists.
 */
export function formatUpstreamError(
  e: UpstreamError,
  opts?: { toolNotFoundMessage?: (name: string) => string },
): string {
  switch (e.kind) {
    case "binary-not-found":
      return `stdio binary not found: "${e.command}" — install it or check the command path`
    case "connect-failed":
      return `connect failed: ${String(e.cause)}`
    case "auth-failed":
      return e.cause !== undefined
        ? `authentication failed: ${String(e.cause)}`
        : "authentication failed (check the credential token)"
    case "upstream-unavailable":
      return `upstream unavailable: ${String(e.cause)}`
    case "tool-not-found":
      return opts?.toolNotFoundMessage?.(e.name) ?? `tool not found: "${e.name}"`
    case "call-failed":
      return `tool call failed: ${String(e.cause)}`
    case "namespace-too-long":
      return `namespaced tool name exceeds 64 chars: "${e.name}"`
    case "invalid-tool-name":
      return `upstream tool name contains MCP-illegal characters: "${e.name}"`
    case "timed-out":
      return `upstream timed out after ${e.ms}ms`
    case "unsupported-source-kind":
      return `platform kind "${e.platformKind}" is not yet supported`
    case "spec-parse-failed":
      return `openapi spec parse failed: ${String(e.cause)}`
    case "spec-fetch-failed":
      return `openapi spec fetch failed: ${String(e.cause)}`
    case "invalid-args":
      return `invalid tool arguments: ${e.reason}`
    case "response-too-large":
      return `upstream response exceeded ${e.limit} byte limit`
    case "too-many-tools":
      return `spec has too many operations (${e.count}); cap is ${e.cap}`
    case "needs-reauth":
      return `connection expired — reconnect this account (run: junction connect ${e.platformId} --account ${e.account})`
    default: {
      // Exhaustiveness guard: compile error if a new UpstreamError kind is added
      // without a corresponding case here (docs/rules/typescript.md — switch + never).
      const _: never = e
      return `unknown upstream error: ${String((_ as UpstreamError).kind)}`
    }
  }
}
