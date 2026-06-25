// SPDX-License-Identifier: AGPL-3.0-only
// Discriminated-union domain errors — factor-on-first-use per docs/principles/dry.md

export type PathsError = { kind: "home-unresolvable"; cause: unknown }

export type ConfigError =
  | { kind: "read-failed"; cause: unknown }
  | { kind: "invalid"; issues: string[] }
  | { kind: "write-failed"; cause: unknown }
  | { kind: "lock-failed"; cause: unknown }

export type DbError =
  | { kind: "migration-failed"; cause: unknown }
  | { kind: "constraint-violation"; cause: unknown }
  | { kind: "not-found"; entity: string; id: string }
  | { kind: "duplicate-namespace"; namespace: string }
  | { kind: "query-failed"; cause: unknown }

export type CredentialError =
  | { kind: "store-unavailable"; cause: unknown }
  | { kind: "decrypt-failed"; cause: unknown }
  | { kind: "key-unavailable"; cause: unknown }
  | { kind: "io-failed"; cause: unknown }
  | { kind: "invalid-input"; reason: string }

export type SandboxError =
  | { kind: "runtime-unavailable"; runtime: "deno"; cause?: unknown }
  | { kind: "unsupported-platform"; platform: string }
  | { kind: "policy-invalid"; reason: string }
  | { kind: "spawn-failed"; cause: unknown }
  | { kind: "timed-out"; timeoutMs: number }

/**
 * Errors from connecting to or calling an upstream MCP source.
 * Consumed by the mcp-client package and by the CLI's debug formatter.
 * Defined in core so the CLI can import the type without depending on mcp-client.
 */
export type UpstreamError =
  | { kind: "binary-not-found"; command: string }
  | { kind: "connect-failed"; cause: unknown }
  | { kind: "auth-failed"; cause?: unknown }
  | { kind: "upstream-unavailable"; cause: unknown }
  | { kind: "tool-not-found"; name: string }
  | { kind: "call-failed"; cause: unknown }
  | { kind: "namespace-too-long"; name: string }
  | { kind: "invalid-tool-name"; name: string }
  | { kind: "timed-out"; ms: number }
