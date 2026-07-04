// SPDX-License-Identifier: AGPL-3.0-only
// Shared date formatting for verify/check captions. Pinned to UTC via a
// module-scope Intl instance so SSR (server) and hydration (client) produce a
// BYTE-IDENTICAL string — a locale/timezone-dependent format (e.g.
// toLocaleString) flickers on hydrate (inc-27 gotcha: docs/futures/gotchas.md).
// Extracted at the rule-of-three (credentials + apps both render "checked …").

const CHECKED_AT_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

/** "checked Jul 04, 2026, 18:11 UTC" — an honest, absolute, SSR-stable caption. */
export function formatCheckedAt(ms: number): string {
  return `checked ${CHECKED_AT_FORMAT.format(new Date(ms))} UTC`
}
