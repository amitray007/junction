// SPDX-License-Identifier: AGPL-3.0-only
// cli.ts — assemble a sandboxed CLI Platform. Mirrors addCliPlatform from the
// original cli/commands/platform.ts: validate the descriptor, probe sandbox
// capabilities (warn, don't fail), dry-run validatePolicy per tool, validate
// the platform.

import { constants as fsConstants } from "node:fs"
import { access, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import {
  CliConnectionSchema,
  type CliTool,
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
   * The chosen binary path — either a discoverBinary candidate's realpath OR a
   * raw manual `--binary-path` / web override. It is NOT trusted as-resolved:
   * addFullAccessCliPlatform re-checks access(X_OK) and resolves realpath()
   * itself (a manual override may be a typo or a symlink), and pins the
   * resolved realpath as CliConnection.binaryPath. Rejects with
   * `binary-path-invalid` if the path is missing/non-executable/relative.
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
 * Translate a user's host:port network INTENT into the port scope the command
 * sandbox can actually ENFORCE (Fable net-policy ruling, inc 41).
 *
 * WHY: macOS Seatbelt scopes egress by PORT only, not host, and Linux
 * bubblewrap is all-or-nothing — a host-scoped allowNet entry ("api.github.com:443")
 * HARD-FAILS runCommand with `policy-invalid`. So an install that recorded a
 * host list would produce a platform whose `execute` can never reach the network.
 * We translate each `host:port` (or bare `port`) to `*:<port>` (any host on that
 * port), dedupe, and hand THAT to the sandbox. The user's host intent is honest
 * documentation, not an enforced boundary — the install UI/confirmation discloses
 * this (Fable Q3 copy). `*` / `*:port` / bare-port entries pass through unchanged.
 *
 * FORWARD PATH: when a Deno-tier / microVM per-host command backend backs
 * `execute`, enforce the host list directly (docs/futures/revisit-when.md).
 */
export function hostIntentToEnforceablePortScope(intent: readonly string[]): string[] {
  const ports = new Set<string>()
  const passthrough: string[] = []
  for (const entry of intent) {
    if (entry === "") continue
    if (entry === "*") {
      // "any host, any port" — cannot be narrowed to a port; keep as-is.
      passthrough.push("*")
      continue
    }
    const colon = entry.lastIndexOf(":")
    if (colon === -1) {
      // bare token: a numeric port ("443") is already port-only; anything else
      // is a bare host we cannot enforce — drop it (it would be rejected anyway).
      if (/^\d+$/.test(entry)) ports.add(entry)
      continue
    }
    const port = entry.slice(colon + 1)
    // "*:443" or "host:443" → enforce as "*:443"; "*:*"/"host:*" → any port.
    ports.add(port === "*" ? "*" : port)
  }
  // Build `*:<port>` entries; a lone "*" (any port) or passthrough "*" collapses all.
  const anyPort = ports.has("*") || passthrough.includes("*")
  if (anyPort) return ["*"]
  return [...ports].map((p) => `*:${p}`)
}

/**
 * Build the default SAFE platform-level CliPolicy for a Full CLI access
 * install: cwd = a per-platform scratch dir under JUNCTION_HOME's runtimeDir,
 * readPaths/writePaths scoped to that one dir, a sane bounded timeout, and no
 * static env entries.
 *
 * NETWORK (Fable net-policy ruling): default `[]` (no network — sovereignty
 * posture; the user opts in explicitly). When the user DOES pass a host list,
 * we store the ENFORCEABLE port scope (see hostIntentToEnforceablePortScope) so
 * the resulting platform's `execute` can actually reach the network on macOS
 * (host-scoped entries would be rejected by Seatbelt at call time).
 */
function defaultFullAccessPolicy(
  scratchDir: string,
  allowNet: string[] | undefined,
): FullAccessCliConnection["policy"] {
  return {
    cwd: scratchDir,
    readPaths: [scratchDir],
    writePaths: [scratchDir],
    allowNet: allowNet && allowNet.length > 0 ? hostIntentToEnforceablePortScope(allowNet) : [],
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
  // SECURITY (inc 41, clean-code review #1): the binaryPath may come from a
  // discoverBinary candidate (already access(X_OK)+realpath'd) OR from a manual
  // --binary-path / web manual-path override that is a RAW user string. We must
  // NOT trust the caller-resolved claim: re-verify here that the path exists, is
  // executable, and RESOLVE it to its realpath before pinning it — otherwise a
  // typo fails every later execute/help call, and (worse) a symlink silently
  // pins a DIFFERENT binary than the operator intended. Store the realpath.
  if (!path.isAbsolute(input.binaryPath)) {
    return err({
      kind: "binary-path-invalid",
      path: input.binaryPath,
      reason: "not an absolute path",
    })
  }
  let binaryPath: string
  try {
    await access(input.binaryPath, fsConstants.X_OK)
    binaryPath = await realpath(input.binaryPath)
  } catch {
    return err({
      kind: "binary-path-invalid",
      path: input.binaryPath,
      reason: "file does not exist or is not executable",
    })
  }

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
    binaryPath,
    policy,
    sandbox,
  })
  if (extractResult.isErr()) {
    return err({ kind: "extract-refused", cause: extractResult.error })
  }
  const schema = extractResult.value

  const cli: FullAccessCliConnection = {
    mode: "full-access",
    binaryPath,
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

// ---------------------------------------------------------------------------
// Full CLI access — shortcuts editing (inc 41.5): demoted declared-CliTool
// "saved commands" that ride connection.shortcuts[] alongside execute/help.
// docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q6.
// ---------------------------------------------------------------------------

export interface SetFullAccessCliShortcutsInput {
  /** The existing platform (already loaded by the caller — never fetched here). */
  platform: Platform
  /** The full replacement list — wholesale replace, same semantics as upsert. */
  shortcuts: CliTool[]
}

/**
 * Replace a Full CLI access platform's `shortcuts[]` wholesale and re-validate
 * the resulting CliConnection. The caller (web/cli edge) owns fetching the
 * existing platform and upserting the returned one — this function is a pure
 * assemble+validate step, mirroring parsePlatform's role in the add flows.
 *
 * Refuses on a non-cli or declared-mode platform: shortcuts only exist on the
 * full-access branch (CliConnectionSchema's DeclaredCliConnection has no
 * `shortcuts` field — declared tools already ARE the tool list).
 */
export function setFullAccessCliShortcuts(
  input: SetFullAccessCliShortcutsInput,
): Result<Platform, PlatformOrchestrationError> {
  const { platform, shortcuts } = input
  if (platform.kind !== "cli" || !platform.cli || !isFullAccess(platform.cli)) {
    return err({ kind: "not-full-access", platformKind: platform.kind })
  }

  const nextCli: FullAccessCliConnection = {
    ...platform.cli,
    ...(shortcuts.length > 0 ? { shortcuts } : {}),
  }
  // Explicitly drop `shortcuts` when the caller passes an empty list (rather
  // than persisting `shortcuts: []`) — the schema's `shortcuts` is optional,
  // and an empty array is otherwise indistinguishable from "not yet used" in
  // storage; dropping keeps a from-empty round-trip identical to never having
  // set any shortcuts.
  if (shortcuts.length === 0) delete (nextCli as { shortcuts?: CliTool[] }).shortcuts

  const cliParseResult = CliConnectionSchema.safeParse(nextCli)
  if (!cliParseResult.success) {
    const message = cliParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-descriptor", message })
  }

  return parsePlatform({ ...platform, cli: cliParseResult.data })
}
