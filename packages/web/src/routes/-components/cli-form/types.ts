// SPDX-License-Identifier: AGPL-3.0-only
// Shared client-side form-state types for the CLI guided form.
// Mirrors packages/web/src/server/platform-mutations.server.ts's CliConnectionInput
// exactly (that's what gets sent over the wire) plus a client-only `id` for stable
// React keys across add/remove/reorder (never sent to the server).

export type CliArgType = "string" | "number" | "boolean" | "enum" | "path"

export interface CliToolArgFormState {
  /** Client-only stable key — not sent to the server. */
  readonly key: string
  name: string
  description: string
  type: CliArgType
  required: boolean
  enumValues: string[]
  pattern: string
  maxLength: string
}

export type CliNetworkFormState = { mode: "denied" } | { mode: "allow"; hosts: string[] }

export interface CliPolicyFormState {
  cwd: string
  readPaths: string[]
  writePaths: string[]
  network: CliNetworkFormState
  timeoutMs: string
  envAllow: Array<{ key: string; value: string }>
}

export interface CliToolFormState {
  readonly key: string
  name: string
  description: string
  commandLine: string
  args: CliToolArgFormState[]
  policy: CliPolicyFormState
  /** True when this tool's descriptor couldn't round-trip through the guided form (edit mode). */
  advanced: boolean
  /** The raw tool JSON — only meaningful when `advanced` is true (the JSON escape hatch). */
  rawJson: string
}

export interface CliConnectionFormState {
  tools: CliToolFormState[]
  credentialEnvVar: string
}

let keyCounter = 0
/** Client-only unique key generator for list items (tools/args) — not persisted. */
export function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${keyCounter}`
}

export function emptyPolicy(): CliPolicyFormState {
  return {
    cwd: "",
    readPaths: [],
    writePaths: [],
    network: { mode: "denied" },
    timeoutMs: "15000",
    envAllow: [],
  }
}

export function emptyTool(): CliToolFormState {
  return {
    key: nextKey("tool"),
    name: "",
    description: "",
    commandLine: "",
    args: [],
    policy: emptyPolicy(),
    advanced: false,
    rawJson: "",
  }
}

export function emptyConnection(): CliConnectionFormState {
  return { tools: [emptyTool()], credentialEnvVar: "" }
}
