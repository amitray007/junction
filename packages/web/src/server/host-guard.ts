// SPDX-License-Identifier: AGPL-3.0-only
// Pure loopback Host-header check — DNS-rebinding / CSRF defense.
// Used by data.functions.ts (server-fn guard). serve.mjs keeps its own inline copy
// because it's plain .mjs loading the BUILT bundle and can't import this TS source
// at runtime — the two are an intentional, tested 2-layer guard (rule of three not hit).

/**
 * True iff the Host header names the loopback interface (127.0.0.1, localhost, or
 * the IPv6 loopback [::1]). Case-insensitive. Empty/missing → false (fail closed).
 * Exact hostname match — no suffix bypass (e.g. "127.0.0.1.evil.com" → false).
 */
export function isLocalHost(hostHeader: string | null | undefined): boolean {
  const h = (hostHeader ?? "").toLowerCase()
  const hostname = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : (h.split(":")[0] ?? "")
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
}
