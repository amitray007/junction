// SPDX-License-Identifier: AGPL-3.0-only
// Conversion between the CLI guided form's client state and the wire shapes:
// CliConnectionFormState → CliConnectionInput (submit), and the platform-detail
// DTO's cliTools → CliConnectionFormState (edit-mode pre-fill).

import { argvToCommandLine } from "../../../lib/cli-command.js"
import type { CliToolArgInput, CliToolInput } from "../../../server/platform-mutations.functions.js"
import type {
  CliArgType,
  CliConnectionFormState,
  CliEnvAllowFormState,
  CliPathFormState,
  CliPolicyFormState,
  CliToolArgFormState,
  CliToolFormState,
} from "./types.js"
import { emptyEnvAllowRow, emptyPathRow, nextKey } from "./types.js"

// ---------------------------------------------------------------------------
// Form state → wire input (submit path)
// ---------------------------------------------------------------------------

function toArgInput(arg: CliToolArgFormState): CliToolArgInput {
  return {
    name: arg.name.trim(),
    description: arg.description.trim() || undefined,
    type: arg.type,
    required: arg.required,
    enum: arg.type === "enum" ? arg.enumValues : undefined,
    pattern: arg.pattern.trim() || undefined,
    maxLength: arg.maxLength.trim() ? Number(arg.maxLength) : undefined,
  }
}

function toEnvAllowRecord(entries: CliEnvAllowFormState[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { key, value } of entries) {
    if (key.trim()) out[key.trim()] = value
  }
  return out
}

/** Strip client-only stable ids and blank entries from a path-row list (form → wire). */
function toPathArray(paths: CliPathFormState[]): string[] {
  return paths.map((p) => p.value.trim()).filter(Boolean)
}

function toPolicyInput(policy: CliPolicyFormState): CliToolInput["policy"] {
  return {
    cwd: policy.cwd.trim(),
    readPaths: toPathArray(policy.readPaths),
    writePaths: toPathArray(policy.writePaths),
    network:
      policy.network.mode === "allow"
        ? { mode: "allow", hosts: toPathArray(policy.network.hosts) }
        : { mode: "denied" },
    timeoutMs: Number(policy.timeoutMs) || 15_000,
    envAllow: toEnvAllowRecord(policy.envAllow),
  }
}

/**
 * Convert one tool's form state to the wire CliToolInput. For an `advanced`
 * tool (the JSON escape hatch), the parsed rawJson becomes `advancedTool` —
 * the server uses it verbatim instead of tokenizing commandLine (see
 * platform-mutations.server.ts assembleCliConnection). A parse failure here
 * surfaces as a thrown SyntaxError; the caller (the route's submit handler)
 * catches it and shows a field error rather than letting it reach the server.
 */
export function toToolInput(tool: CliToolFormState): CliToolInput {
  if (tool.advanced) {
    return {
      name: tool.name.trim(),
      description: tool.description.trim() || undefined,
      commandLine: "",
      args: [],
      policy: toPolicyInput(tool.policy),
      advancedTool: JSON.parse(tool.rawJson),
    }
  }
  return {
    name: tool.name.trim(),
    description: tool.description.trim() || undefined,
    commandLine: tool.commandLine,
    args: tool.args.map(toArgInput),
    policy: toPolicyInput(tool.policy),
  }
}

export function toConnectionInput(state: CliConnectionFormState) {
  return {
    tools: state.tools.map(toToolInput),
    credentialEnvVar: state.credentialEnvVar.trim() || undefined,
  }
}

// ---------------------------------------------------------------------------
// Platform-detail DTO → form state (edit-mode pre-fill)
// ---------------------------------------------------------------------------

export interface CliToolDetailLike {
  name: string
  description?: string
  commandLine: string
  args: Array<{
    name: string
    description?: string
    type: CliArgType
    required: boolean
    enum?: string[]
    pattern?: string
    maxLength?: number
  }>
  policy: {
    cwd: string
    readPaths: string[]
    writePaths: string[]
    network: { mode: "denied" } | { mode: "allow"; hosts: string[] }
    timeoutMs: number
    envAllow: Record<string, string>
  }
  reversible: boolean
  rawJson?: string
}

function argFromDetail(arg: CliToolDetailLike["args"][number]): CliToolArgFormState {
  return {
    key: nextKey("arg"),
    name: arg.name,
    description: arg.description ?? "",
    type: arg.type,
    required: arg.required,
    enumValues: arg.enum ?? [],
    pattern: arg.pattern ?? "",
    maxLength: arg.maxLength !== undefined ? String(arg.maxLength) : "",
  }
}

function policyFromDetail(policy: CliToolDetailLike["policy"]): CliPolicyFormState {
  return {
    cwd: policy.cwd,
    readPaths: policy.readPaths.map((value) => emptyPathRow(value)),
    writePaths: policy.writePaths.map((value) => emptyPathRow(value)),
    network:
      policy.network.mode === "allow"
        ? { mode: "allow", hosts: policy.network.hosts.map((value) => emptyPathRow(value)) }
        : { mode: "denied" },
    timeoutMs: String(policy.timeoutMs),
    envAllow: Object.entries(policy.envAllow).map(([key, value]) => emptyEnvAllowRow(key, value)),
  }
}

export function toolFromDetail(tool: CliToolDetailLike): CliToolFormState {
  return {
    key: nextKey("tool"),
    name: tool.name,
    description: tool.description ?? "",
    commandLine: tool.reversible ? tool.commandLine : "",
    args: tool.args.map(argFromDetail),
    policy: policyFromDetail(tool.policy),
    advanced: !tool.reversible,
    rawJson: tool.rawJson ?? "",
  }
}

export function connectionFromDetail(detail: {
  cliTools?: CliToolDetailLike[]
  cliCredentialEnvVar?: string
}): CliConnectionFormState {
  return {
    tools: (detail.cliTools ?? []).map(toolFromDetail),
    credentialEnvVar: detail.cliCredentialEnvVar ?? "",
  }
}

// Re-export for callers that want to preview the round-trip command line for a
// reversible detail tool without re-deriving it (kept here to keep the
// argvToCommandLine import localized to this conversion module).
export { argvToCommandLine }
