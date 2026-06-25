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
  | { kind: "query-failed"; cause: unknown }

export type CredentialError =
  | { kind: "store-unavailable"; cause: unknown }
  | { kind: "decrypt-failed"; cause: unknown }
  | { kind: "key-unavailable"; cause: unknown }
  | { kind: "io-failed"; cause: unknown }

export type SandboxError =
  | { kind: "runtime-unavailable"; runtime: "deno"; cause?: unknown }
  | { kind: "unsupported-platform"; platform: string }
  | { kind: "policy-invalid"; reason: string }
  | { kind: "spawn-failed"; cause: unknown }
  | { kind: "timed-out"; timeoutMs: number }
