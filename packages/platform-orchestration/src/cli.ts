// SPDX-License-Identifier: AGPL-3.0-only
// cli.ts — assemble a sandboxed CLI Platform. Mirrors addCliPlatform from the
// original cli/commands/platform.ts: validate the descriptor, probe sandbox
// capabilities (warn, don't fail), dry-run validatePolicy per tool, validate
// the platform.

import { mkdir } from "node:fs/promises"
import path from "node:path"
import {
  CliConnectionSchema,
  createSandbox,
  type ExtractedCliSchema,
  ensureRuntimeDir,
  extractCliSchema,
  type FullAccessCliConnection,
  getPaths,
  isFullAccess,
  type Platform,
  validatePolicy,
} from "@junction/core"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import { type PlatformOrchestrationError, parsePlatform } from "./errors.js"

export interface AddCliPlatformInput {
  id: string
  displayName: string
  /** Already JSON.parsed descriptor object — the caller owns the raw string + its parse error. */
  descriptor: unknown
}

export interface AddCliPlatformResult {
  platform: Platform
  toolCount: number
  /** Set when no sandbox backend is available on this host — the add still succeeds. */
  sandboxWarning?: string
}

export function addCliPlatform(
  input: AddCliPlatformInput,
): ResultAsync<AddCliPlatformResult, PlatformOrchestrationError> {
  return new ResultAsync(addCliPlatformAsync(input))
}

async function addCliPlatformAsync(
  input: AddCliPlatformInput,
): Promise<Result<AddCliPlatformResult, PlatformOrchestrationError>> {
  const cliParseResult = CliConnectionSchema.safeParse(input.descriptor)
  if (!cliParseResult.success) {
    const message = cliParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-descriptor", message })
  }
  const cli = cliParseResult.data

  // Full CLI access descriptors are storable (inc 41.1: schema + repo only) but
  // this add-flow doesn't wire discovery/install for them yet (inc 41.4).
  if (isFullAccess(cli)) {
    return err({ kind: "full-access-not-yet-supported" })
  }

  // Probe sandbox capabilities — warn if no backend, but allow the add.
  // The descriptor is portable data; it may be served on a host that has a backend.
  let sandboxWarning: string | undefined
  const sbResult = await createSandbox()
  if (sbResult.isOk()) {
    const caps = sbResult.value.capabilities()
    if (caps.command === "none") {
      sandboxWarning =
        "No sandbox backend available on this host (Seatbelt on macOS, bubblewrap on Linux). " +
        "The cli platform will be stored but tool calls will refuse until a backend is present."
    }
  }

  // Dry-run validatePolicy for each tool — catch metachar / credential-dir exposure at add-time.
  for (const tool of cli.tools) {
    const policy = {
      cwd: tool.policy.cwd,
      readPaths: [...new Set([tool.policy.cwd, ...tool.policy.readPaths])],
      writePaths: tool.policy.writePaths,
      allowNet: tool.policy.allowNet,
      timeoutMs: tool.policy.timeoutMs,
      env: tool.policy.envAllow ?? {},
    }
    const policyErr = await validatePolicy(policy)
    if (policyErr) {
      // validatePolicy only emits "policy-invalid" errors; narrow to extract `.reason`.
      const reason = policyErr.kind === "policy-invalid" ? policyErr.reason : policyErr.kind
      return err({ kind: "policy-invalid", toolName: tool.name, reason })
    }
  }

  const platformResult = parsePlatform({
    id: input.id,
    kind: "cli",
    displayName: input.displayName,
    cli,
  })
  if (platformResult.isErr()) return err(platformResult.error)

  return ok({
    platform: platformResult.value,
    toolCount: cli.tools.length,
    sandboxWarning,
  })
}

// ---------------------------------------------------------------------------
// Full CLI access install (inc 41.4) — "install a CLI by name": discover the
// binary, assemble a SAFE default platform-level CliPolicy, run
// extractCliSchema (41.2) via createSandbox(), and return a ready-to-upsert
// FullAccessCliConnection Platform. This is the discovery path that REPLACES
// the "full-access-not-yet-supported" stopgap above — but ONLY for binaries
// resolved via discoverBinary/--path; a raw --descriptor full-access
// submission (addCliPlatform above) stays unsupported (Full CLI access is
// install-flow-only, never hand-authored JSON).
// ---------------------------------------------------------------------------

export interface AddFullAccessCliPlatformInput {
  id: string
  displayName: string
  /**
   * The chosen binary's resolved realpath (from discoverBinary or a manual
   * --path override the caller has already resolved to a realpath). Persisted
   * verbatim as CliConnection.binaryPath.
   */
  binaryPath: string
  credentialEnvVar?: string
  /** host[:port] allowlist. Default `[]` — SAFE, no network (user widens explicitly). */
  allowNet?: string[]
}

export interface AddFullAccessCliPlatformResult {
  platform: Platform
  schema: ExtractedCliSchema
  /** Node count in the extracted tree (for CLI/web summary reporting). */
  nodeCount: number
  /** true if extractCliSchema hit a probe/depth/wall-clock ceiling (partial schema; safe, not an error). */
  truncated: boolean
}

/**
 * Build the default SAFE platform-level CliPolicy for a Full CLI access
 * install: cwd = a per-platform scratch dir under JUNCTION_HOME's runtimeDir,
 * readPaths/writePaths scoped to that one dir, allowNet = caller-provided or
 * `[]` (no network by default — Junction's sovereignty posture; the user
 * widens explicitly), a sane bounded timeout, and no static env entries.
 */
function defaultFullAccessPolicy(
  scratchDir: string,
  allowNet: string[] | undefined,
): FullAccessCliConnection["policy"] {
  return {
    cwd: scratchDir,
    readPaths: [scratchDir],
    writePaths: [scratchDir],
    allowNet: allowNet ?? [],
    timeoutMs: 120_000,
    envAllow: {},
  }
}

function countNodes(node: ExtractedCliSchema["root"]): number {
  let count = 1
  for (const child of node.subcommands) count += countNodes(child)
  return count
}

export function addFullAccessCliPlatform(
  input: AddFullAccessCliPlatformInput,
): ResultAsync<AddFullAccessCliPlatformResult, PlatformOrchestrationError> {
  return new ResultAsync(addFullAccessCliPlatformAsync(input))
}

async function addFullAccessCliPlatformAsync(
  input: AddFullAccessCliPlatformInput,
): Promise<Result<AddFullAccessCliPlatformResult, PlatformOrchestrationError>> {
  const paths = getPaths()
  const scratchDir = path.join(paths.runtimeDir, "cli", input.id)

  const ensureResult = await ensureRuntimeDir(paths)
  if (ensureResult.isErr()) {
    return err({ kind: "sandbox-unavailable" })
  }
  // ensureRuntimeDir only creates paths.runtimeDir itself — the per-platform
  // scratch subdir (this policy's cwd) must exist too, or the sandbox backend
  // refuses to spawn with a cwd that isn't there yet.
  try {
    await mkdir(scratchDir, { recursive: true })
  } catch (cause) {
    return err({ kind: "extract-refused", cause })
  }

  const sbResult = await createSandbox()
  if (sbResult.isErr()) {
    return err({ kind: "sandbox-unavailable" })
  }
  const sandbox = sbResult.value
  if (sandbox.capabilities().command === "none") {
    // Unlike declared-mode add (which stores a warning and proceeds), Full CLI
    // access install cannot proceed at all — extraction requires a working
    // sandbox backend RIGHT NOW, not "eventually on a host that has one".
    return err({ kind: "sandbox-unavailable" })
  }

  const policy = defaultFullAccessPolicy(scratchDir, input.allowNet)

  // Dry-run validatePolicy up front — same metachar/credential-dir-exposure
  // guard the declared path applies per-tool, applied once here (one
  // platform-level policy).
  const policyErr = await validatePolicy({
    cwd: policy.cwd,
    readPaths: policy.readPaths,
    writePaths: policy.writePaths,
    allowNet: policy.allowNet,
    timeoutMs: policy.timeoutMs,
    env: policy.envAllow,
  })
  if (policyErr) {
    const reason = policyErr.kind === "policy-invalid" ? policyErr.reason : policyErr.kind
    return err({ kind: "policy-invalid", toolName: "__execute", reason })
  }

  const extractResult = await extractCliSchema({
    binaryPath: input.binaryPath,
    policy,
    sandbox,
  })
  if (extractResult.isErr()) {
    return err({ kind: "extract-refused", cause: extractResult.error })
  }
  const schema = extractResult.value

  const cli: FullAccessCliConnection = {
    mode: "full-access",
    binaryPath: input.binaryPath,
    ...(input.credentialEnvVar ? { credentialEnvVar: input.credentialEnvVar } : {}),
    policy,
    schema,
  }

  const cliParseResult = CliConnectionSchema.safeParse(cli)
  if (!cliParseResult.success) {
    const message = cliParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-descriptor", message })
  }

  const platformResult = parsePlatform({
    id: input.id,
    kind: "cli",
    displayName: input.displayName,
    cli: cliParseResult.data,
  })
  if (platformResult.isErr()) return err(platformResult.error)

  return ok({
    platform: platformResult.value,
    schema,
    nodeCount: countNodes(schema.root),
    truncated: schema.truncated,
  })
}
