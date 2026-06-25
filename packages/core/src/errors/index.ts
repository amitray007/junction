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
