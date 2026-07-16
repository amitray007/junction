// SPDX-License-Identifier: AGPL-3.0-only
// CLI ToolProvider — executes operator-declared (declared mode) or agent-driven
// (full-access mode) commands via the sandbox.
//
// SECURITY-CRITICAL: read docs/methods/21-sandboxed-cli-source.md,
// docs/methods/28.9-credential-hardening.md (file-kind mechanics, slice D), and
// docs/methods/41.3-cli-execute-help-provider.md + the design spec
// docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q2/Q3 (full-access) before editing.
//
// Security invariants enforced here:
//   1. No shell, ever — argv array to sandbox; shell:false is enforced in exec.ts.
//   2. Agent cannot widen argv — each segment yields ≤1 element (declared: buildArgv;
//      full-access execute: raw agent argv, but binary is pinned, no shell, and the
//      sandbox is the trust boundary — see the execute-path comment below).
//   3. argv[0] is operator-fixed: declared mode via CliToolSchema's refine; full-access
//      mode via FullAccessCliConnection.binaryPath (the agent NEVER supplies argv[0]).
//   4. Secret only in policy.env[credentialEnvVar] — never argv, logs, or results.
//      For kind "file" the env var carries a materialized temp-file PATH, not the
//      secret bytes; the file itself is 0600, lives in a per-call temp dir UNDER
//      paths.runtimeDir (junction-private, 0700, INSIDE the junction home — never
//      the shared OS tmpdir, which same-uid sibling processes can be granted
//      readPaths over) added to readPaths, and is deleted in a finally (ok/err/
//      throw — see callTool / the execute path).
//   5. Fail closed — always createSandbox().runCommand(); never raw child_process.
//   6. validatePolicy runs inside sandbox.runCommand (metachar + exposure + denylist) —
//      the file-kind temp dir flows through the SAME check via readPaths; it is
//      never granted a bypass.
//   7. Full-access `help` probes are the SAME safe-probe class as extraction (41.2):
//      no credential, no network, read-only FS — never the credentialed/networked
//      execute invocation class. The two invocation classes stay distinct (spec §5 Q3).
//
// SOURCE-AGNOSTIC: no vendor code. No external deps beyond core sandbox + Zod.

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { errAsync, okAsync } from "neverthrow"
import type { SandboxError, UpstreamError } from "../../errors/index.js"
import { ensureRuntimeDir, getPaths, type JunctionPaths } from "../../paths/index.js"
import { err, ok, type Result, ResultAsync } from "../../result/index.js"
import { createSandbox } from "../../sandbox/index.js"
import type {
  CliConnection,
  CliSecret,
  CliTool,
  FullAccessCliConnection,
} from "../../schema/cli-connection.js"
import { isFullAccess } from "../../schema/cli-connection.js"
import type { CliSchemaNode } from "../../schema/cli-schema.js"
import { rejectControlCharacters } from "../arg-validation.js"
import type { ProviderTool, ToolProvider, ToolResult } from "../provider.js"
import { validateArgs } from "./args.js"
import { buildArgv } from "./argv.js"
import { probeNode } from "./extract.js"

// ---------------------------------------------------------------------------
// JSON Schema builder — converts CliArg declarations to an inputSchema object
// ---------------------------------------------------------------------------

function buildInputSchema(tool: CliTool): object {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const arg of tool.args) {
    let argSchema: Record<string, unknown>

    switch (arg.type) {
      case "boolean":
        argSchema = { type: "boolean" }
        break
      case "number":
        argSchema = { type: "number" }
        break
      case "enum":
        argSchema = { type: "string", enum: arg.enum ?? [] }
        break
      case "path":
      case "string": {
        argSchema = { type: "string" }
        if (arg.pattern !== undefined) {
          // Surface as anchored pattern so agent-side validators can pre-check.
          argSchema.pattern = `^(?:${arg.pattern})$`
        }
        if (arg.maxLength !== undefined) {
          argSchema.maxLength = arg.maxLength
        }
        break
      }
      default: {
        // Exhaustiveness guard — TS 6 does not emit a default for this switch;
        // the never-assignment proves all variants are handled at compile time.
        const _: never = arg.type
        argSchema = { type: "string" }
        break
      }
    }

    if (arg.description !== undefined) {
      argSchema.description = arg.description
    }

    properties[arg.name] = argSchema
    if (arg.required) {
      required.push(arg.name)
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

// ---------------------------------------------------------------------------
// materializeSecret — kind "file" mechanics (increment 28.9 slice D)
// ---------------------------------------------------------------------------

/**
 * Result of preparing the credential for one call: the env entries to merge
 * into policy.env, any extra readPaths to grant, and the temp dir (if any)
 * that MUST be removed in the caller's finally block.
 */
type PreparedCredential = {
  envAllow: Record<string, string>
  extraReadPaths: string[]
  materializedDir: string | undefined
}

/**
 * Prepare policy.env + readPaths for this call's credential.
 *
 * kind "env" (and the legacy default): EXACTLY today's behaviour — the value
 * goes directly into policy.env[credentialEnvVar].
 *
 * kind "file": materializes the secret CONTENT to a fresh per-call temp file,
 * created at 0600 (via writeFile's `mode` option — set AT CREATION, never
 * chmod-after, per the inc-6 rule), and injects the file's PATH instead of its
 * bytes. The temp dir is added to the returned extraReadPaths so it flows
 * through validatePolicy exactly like any other granted path — no bypass.
 *
 * The temp dir is created under `paths.runtimeDir` (junction-private, 0700,
 * INSIDE the junction home) — NEVER `os.tmpdir()`. On Linux `os.tmpdir()` is
 * the shared, world-writable-parent `/tmp`; an operator can grant an UNRELATED
 * cli tool `readPaths: ["/tmp"]`, and that tool (same uid) could then read
 * another call's 0600 cred file mid-flight — 0600 alone doesn't protect
 * against same-uid siblings sharing a parent directory an operator controls.
 * `runtimeDir` lives inside `~/.junction`, a location no operator would ever
 * grant to an arbitrary tool (and `grantedPathExposesSecrets` still catches
 * an operator who tries — see the callTool policy comment).
 *
 * If credentialEnvVar is absent (or there is no secret), this is a no-op:
 * no materialization, no injection — mirrors kind "env"'s behaviour when the
 * connection declares no credentialEnvVar.
 */
async function prepareCredential(
  connection: CliConnection,
  secret: CliSecret | null,
  baseEnvAllow: Record<string, string>,
  paths: JunctionPaths,
): Promise<Result<PreparedCredential, UpstreamError>> {
  const envAllow: Record<string, string> = { ...baseEnvAllow }

  if (secret === null || !connection.credentialEnvVar) {
    return ok({ envAllow, extraReadPaths: [], materializedDir: undefined })
  }

  // credentialEnvVar is validated by CliConnectionSchema to not end in
  // _TOKEN/_SECRET/_KEY so it passes validatePolicy's secret-denylist check.
  if (secret.kind !== "file") {
    envAllow[connection.credentialEnvVar] = secret.value
    return ok({ envAllow, extraReadPaths: [], materializedDir: undefined })
  }

  const runtimeDirResult = await ensureRuntimeDir(paths)
  if (runtimeDirResult.isErr()) {
    return err({ kind: "call-failed", cause: "runtime-dir-create-failed" })
  }

  let materializedDir: string
  try {
    materializedDir = await mkdtemp(join(runtimeDirResult.value, "cred-"))
  } catch {
    return err({ kind: "call-failed", cause: "temp-dir-create-failed" })
  }

  const filePath = join(materializedDir, "cred")
  try {
    await writeFile(filePath, secret.value, { mode: 0o600 })
  } catch {
    await rm(materializedDir, { recursive: true, force: true }).catch(() => {})
    return err({ kind: "call-failed", cause: "temp-file-write-failed" })
  }

  envAllow[connection.credentialEnvVar] = filePath
  return ok({ envAllow, extraReadPaths: [materializedDir], materializedDir })
}

// ---------------------------------------------------------------------------
// mapSandboxError — Err(SandboxError) → UpstreamError (secret-free)
// ---------------------------------------------------------------------------

/**
 * Shared by declared callTool and full-access execute: both run a command
 * through `createSandbox().andThen(sb => sb.runCommand(...))` and need the
 * IDENTICAL SandboxError → UpstreamError mapping. Error causes use
 * `constructor.name`, never `.message` (which may carry paths/secrets).
 */
function mapSandboxError(sandboxErr: SandboxError): UpstreamError {
  switch (sandboxErr.kind) {
    case "policy-invalid":
      return { kind: "connect-failed", cause: `policy-invalid: ${sandboxErr.reason}` }
    case "unsupported-platform":
      return {
        kind: "connect-failed",
        cause: `no sandbox backend available on ${sandboxErr.platform}`,
      }
    case "runtime-unavailable":
      return { kind: "connect-failed", cause: "sandbox runtime unavailable" }
    case "spawn-failed":
      return {
        kind: "call-failed",
        cause:
          sandboxErr.cause instanceof Error ? sandboxErr.cause.constructor.name : "spawn-failed",
      }
    case "timed-out":
      return { kind: "timed-out", ms: sandboxErr.timeoutMs }
    default: {
      const _: never = sandboxErr
      return { kind: "call-failed", cause: "unknown sandbox error" }
    }
  }
}

// ---------------------------------------------------------------------------
// Full-access mode — execute + help (increment 41.3)
// docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q2/Q3
// ---------------------------------------------------------------------------

/** Element guards (spec §5 Q2 / method file): bounds on one `execute` argv element. */
const EXECUTE_ARG_MAX_LENGTH = 4096
const EXECUTE_ARG_MAX_COUNT = 256

const EXECUTE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    args: { type: "array", items: { type: "string" } },
    stdin: { type: "string" },
  },
  required: ["args"],
  additionalProperties: false,
} as const

const HELP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const

/** Build the fixed `execute` + `help` ProviderTool descriptors for a full-access connection. */
function buildFullAccessCoreTools(connection: FullAccessCliConnection): ProviderTool[] {
  const binaryName = connection.binaryPath.split("/").pop() ?? connection.binaryPath
  return [
    {
      name: "execute",
      description: `Run a ${binaryName} command. Provide argv AFTER the binary; the binary is fixed.`,
      inputSchema: EXECUTE_INPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: "help",
      description: `Look up what a ${binaryName} command can do — flags, subcommands, usage.`,
      inputSchema: HELP_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
  ]
}

/**
 * Validate `execute`'s `{ args, stdin? }` payload (method file EXECUTE PATH steps 1-2).
 *
 * NUL/newline/control-char rejection reuses `rejectControlCharacters` (the same
 * primitive declared-mode's `validateArgValue` uses) — no shell-metachar rejection
 * on values (there is no shell), but control chars can break the sandbox
 * profile/argv, so those stay rejected. Element count and length are capped to
 * bound argv (EXECUTE_ARG_MAX_COUNT / EXECUTE_ARG_MAX_LENGTH).
 */
function validateExecuteArgs(
  rawArgs: Record<string, unknown>,
): Result<{ args: string[]; stdin: string | undefined }, UpstreamError> {
  const rawArgList = rawArgs.args
  if (!Array.isArray(rawArgList)) {
    return err({ kind: "invalid-args", reason: '"args" must be an array of strings' })
  }
  if (rawArgList.length > EXECUTE_ARG_MAX_COUNT) {
    return err({
      kind: "invalid-args",
      reason: `"args" has ${rawArgList.length} elements, exceeding the cap of ${EXECUTE_ARG_MAX_COUNT}`,
    })
  }

  const args: string[] = []
  for (let i = 0; i < rawArgList.length; i++) {
    const el = rawArgList[i]
    if (typeof el !== "string") {
      return err({
        kind: "invalid-args",
        reason: `"args[${i}]" must be a string, got ${typeof el}`,
      })
    }
    if (el.length > EXECUTE_ARG_MAX_LENGTH) {
      return err({
        kind: "invalid-args",
        reason: `"args[${i}]" length ${el.length} exceeds maxLength ${EXECUTE_ARG_MAX_LENGTH}`,
      })
    }
    const controlCharResult = rejectControlCharacters(el, `"args[${i}]"`)
    if (controlCharResult.isErr()) return err(controlCharResult.error)
    args.push(el)
  }

  const rawStdin = rawArgs.stdin
  if (rawStdin !== undefined && typeof rawStdin !== "string") {
    return err({ kind: "invalid-args", reason: '"stdin" must be a string' })
  }

  return ok({ args, stdin: rawStdin })
}

/** Result of validating `help`'s `{ path? }` payload. */
function validateHelpPath(rawArgs: Record<string, unknown>): Result<string[], UpstreamError> {
  const rawPath = rawArgs.path
  if (rawPath === undefined) return ok([])
  if (!Array.isArray(rawPath) || rawPath.some((p) => typeof p !== "string")) {
    return err({ kind: "invalid-args", reason: '"path" must be an array of strings' })
  }
  return ok(rawPath as string[])
}

/** Walk `root` to the node at `path` ([] = root). Returns undefined if no such path exists. */
function findSchemaNode(root: CliSchemaNode, path: string[]): CliSchemaNode | undefined {
  let node = root
  for (const segment of path) {
    const child = node.subcommands.find((c) => c.path[c.path.length - 1] === segment)
    if (!child) return undefined
    node = child
  }
  return node
}

/**
 * Project one CliSchemaNode into the `help` tool's response shape (method file
 * HELP PATH step 4 / spec §5 Q2): ONE node + a SHALLOW child index (names +
 * summaries only) — never the full recursive subtree.
 */
function projectHelpNode(node: CliSchemaNode): Record<string, unknown> {
  return {
    path: node.path,
    parsed: node.parsed,
    description: node.description,
    usage: node.usage,
    flags: node.flags,
    positionals: node.positionals,
    subcommands: node.subcommands.map((c) => ({
      name: c.path[c.path.length - 1] ?? "",
      summary: c.description,
    })),
    rawHelp: node.parsed ? undefined : node.rawHelp,
  }
}

/**
 * Lazily probe an `explored:false` node on first `help` call (method file HELP
 * PATH step 3 / spec §5 Q4). Uses the SAME safe-probe class extraction uses
 * (probeNode: no credential, no network, read-only FS — see extract.ts's header).
 * If the sandbox refuses/is unavailable, returns the node AS-IS (honest,
 * still explored:false) rather than erroring the whole `help` call.
 *
 * PERSISTENCE (method file / spec §5 note): the provider is connect-per-call
 * and has no write-back seam into the DB from `core/sources/cli`. The freshly
 * probed node is returned WITHOUT persisting — see
 * docs/futures/revisit-when.md for the deferred write-back entry.
 */
async function resolveHelpNode(
  connection: FullAccessCliConnection,
  node: CliSchemaNode,
): Promise<CliSchemaNode> {
  if (node.explored) return node

  const sandboxResult = await createSandbox()
  if (sandboxResult.isErr()) return node

  const probeResult = await probeNode({
    binaryPath: connection.binaryPath,
    policy: connection.policy,
    sandbox: sandboxResult.value,
    path: node.path,
  })
  if (probeResult.isErr()) return node

  return probeResult.value
}

/** Build the sandbox policy for one `execute` invocation (method file EXECUTE PATH step 4). */
function buildExecutePolicy(
  connection: FullAccessCliConnection,
  envAllow: Record<string, string>,
  extraReadPaths: string[],
  stdin: string | undefined,
) {
  return {
    cwd: connection.policy.cwd,
    readPaths: [
      ...new Set([connection.policy.cwd, ...connection.policy.readPaths, ...extraReadPaths]),
    ],
    writePaths: connection.policy.writePaths,
    allowNet: connection.policy.allowNet,
    timeoutMs: connection.policy.timeoutMs,
    env: envAllow,
    ...(stdin !== undefined ? { stdin } : {}),
  }
}

// ---------------------------------------------------------------------------
// createCliProvider
// ---------------------------------------------------------------------------

/**
 * Create a ToolProvider backed by either operator-declared CLI commands
 * (mode "declared", the default) or a single pinned binary the agent drives
 * via execute/help (mode "full-access" — increment 41.3; see the module
 * header and docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q2/Q3).
 *
 * @param connection  The validated CliConnection descriptor. Declared mode's
 *                    behavior below is BYTE-IDENTICAL to pre-41.3.
 * @param secret      Resolved credential secret tagged by kind, or null for
 *                    public/no-auth tools. kind "env" (and the legacy default
 *                    — see resolveCredentialSecret) behaves EXACTLY as before:
 *                    the value is injected directly into policy.env. kind
 *                    "file" is NEW (increment 28.9 slice D): the value is the
 *                    file CONTENT, materialized per-call to a 0600 temp file
 *                    whose PATH is injected instead — see callTool below.
 *                    Full-access mode's `execute` tool uses the SAME
 *                    prepareCredential path (it is the credentialed/networked
 *                    invocation class); `help` probes NEVER consult secret.
 * @param paths       JunctionPaths — used only for kind "file" materialization
 *                    (`paths.runtimeDir`, a junction-private 0700 dir INSIDE the
 *                    junction home). Defaults to `getPaths()` so existing
 *                    callers (tests, and any caller with no reason to override
 *                    JUNCTION_HOME resolution) don't need to pass it; the real
 *                    composition root (`buildProvider`, @junction/source-runtime)
 *                    already holds a `paths` and passes it explicitly.
 *
 * SECRET DISCIPLINE: `secret.value` is used only to populate
 * `policy.env[credentialEnvVar]` (kind "env") or a 0600 temp file whose path
 * populates that same env var (kind "file"). It never appears in argv, tool
 * results, error messages, or logs.
 */
export function createCliProvider(
  connection: CliConnection,
  secret: CliSecret | null,
  paths: JunctionPaths = getPaths(),
): ToolProvider {
  if (isFullAccess(connection)) {
    return createFullAccessCliProvider(connection, secret, paths)
  }
  return createDeclaredCliProvider(connection, secret, paths)
}

// ---------------------------------------------------------------------------
// Declared-mode provider (unchanged behavior — pre-41.3)
// ---------------------------------------------------------------------------

function createDeclaredCliProvider(
  connection: CliConnection,
  secret: CliSecret | null,
  paths: JunctionPaths,
): ToolProvider {
  const declaredTools: CliTool[] = isFullAccess(connection) ? [] : connection.tools

  // Build a name→tool lookup once at construction time.
  const byName = new Map<string, CliTool>()
  for (const tool of declaredTools) {
    byName.set(tool.name, tool)
  }

  // Pre-build ProviderTool descriptors (stable across calls — listTools is pure).
  const providerTools: ProviderTool[] = declaredTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: buildInputSchema(tool),
  }))

  return {
    listTools(): ResultAsync<ProviderTool[], UpstreamError> {
      // Always returns the operator-declared tools regardless of sandbox availability.
      // The honest refusal happens in callTool when the sandbox is unavailable.
      return okAsync(providerTools)
    },

    callTool(
      rawName: string,
      rawArgs: Record<string, unknown>,
    ): ResultAsync<ToolResult, UpstreamError> {
      // Step 1: resolve the tool by name. Re-bound to a non-optional const
      // (`resolvedTool`) after the guard: TS does not carry narrowing of a
      // closed-over variable into a nested function body (the `work()`
      // closure below), even though `tool` is itself a `const`.
      const tool = byName.get(rawName)
      if (!tool) {
        return errAsync({ kind: "tool-not-found", name: rawName } satisfies UpstreamError)
      }
      const resolvedTool: CliTool = tool

      // Step 2: validate agent-supplied args (type/enum/pattern/maxLength/path/required/unknown).
      const argsResult = validateArgs(tool.args, rawArgs, tool.policy.cwd)
      if (argsResult.isErr()) {
        return errAsync(argsResult.error)
      }
      const validatedArgs = argsResult.value

      // Step 2b: flag-injection guard. An UN-prefixed agent value that starts with
      // "-" would be reinterpreted by the target binary as a flag (e.g. git
      // --upload-pack=…), defeating the "binary + flags are operator-fixed" intent.
      // Two escapes make a leading "-" safe and exempt the arg:
      //   - the operator placed a literal "--" (end-of-options) earlier in argv, or
      //   - the arg has a non-empty prefix (the token then leads with the prefix).
      let endOfOptions = false
      for (const seg of tool.argv) {
        if (seg.kind === "literal") {
          if (seg.value === "--") endOfOptions = true
          continue
        }
        if (endOfOptions) continue
        if (seg.prefix !== undefined && seg.prefix !== "") continue
        const v = validatedArgs.get(seg.name)
        if (typeof v === "string" && v.startsWith("-")) {
          return errAsync({
            kind: "invalid-args",
            reason: `arg "${seg.name}": value may not start with "-" for an unprefixed argument before a "--" separator (flag-injection guard); the operator must place a "--" literal before it or give it a prefix`,
          } satisfies UpstreamError)
        }
      }

      // Step 3: build argv from the template (each segment ≤1 element; no widening).
      const argv = buildArgv(tool.argv, validatedArgs)

      // Steps 4+ are async (kind "file" materializes a temp file before the
      // sandbox call runs) and must clean up the temp dir on EVERY exit path —
      // ok, err, or throw. neverthrow has no `.finally`, so the async work is a
      // plain function wrapped in `new ResultAsync(...)`, with a real
      // try/finally around the sandbox call.
      async function work(): Promise<Result<ToolResult, UpstreamError>> {
        // Step 4: materialize the credential (no-op for kind "env"/no-secret).
        const prepared = await prepareCredential(
          connection,
          secret,
          resolvedTool.policy.envAllow ?? {},
          paths,
        )
        if (prepared.isErr()) {
          return err(prepared.error)
        }
        const { envAllow, extraReadPaths, materializedDir } = prepared.value

        // The try starts HERE — BEFORE the `policy` object literal — so that a
        // throw while constructing it (e.g. a getter/Set operation misbehaving)
        // still reaches the finally below and removes materializedDir. Nothing
        // between mkdtemp/writeFile succeeding and the sandbox call finishing
        // may skip cleanup (LOW-2 hardening).
        try {
          const policy = {
            cwd: resolvedTool.policy.cwd,
            // Always include cwd in readPaths so the process can access its working
            // dir. The materialized-file temp dir (if any) rides the SAME readPaths
            // array — it goes through validatePolicy identically; no bypass.
            readPaths: [
              ...new Set([
                resolvedTool.policy.cwd,
                ...resolvedTool.policy.readPaths,
                ...extraReadPaths,
              ]),
            ],
            writePaths: resolvedTool.policy.writePaths,
            allowNet: resolvedTool.policy.allowNet,
            timeoutMs: resolvedTool.policy.timeoutMs,
            env: envAllow,
          }

          // Step 5: run through the sandbox — createSandbox() refuses if no backend.
          // This is the fail-closed guarantee: no path here bypasses the sandbox.
          return await createSandbox()
            .andThen((sandbox) => sandbox.runCommand(argv, policy))
            .map((result) => {
              // Step 6a: map Ok(SandboxResult) → ToolResult. Output is already byte-capped
              // at spawn (exec.ts SPAWN_OUTPUT_BYTE_CAP); a timeout is returned as
              // Err(timed-out), never here, so result.timedOut is always false in this path.
              const rawOut = result.stdout + result.stderr
              const exitLine = result.outputCapped
                ? `exit ${result.exitCode}, output truncated (exceeded the output byte cap)`
                : `exit ${result.exitCode}`

              const text = `${exitLine}\n${rawOut}`.trimEnd()
              return {
                content: [{ type: "text", text }],
                // Non-zero exit and output-cap both signal an error result.
                isError: result.exitCode !== 0 || (result.outputCapped ?? false),
              } satisfies ToolResult
            })
            // Step 6b: map Err(SandboxError) → UpstreamError (secret-free) — shared
            // with the full-access execute path via mapSandboxError.
            .mapErr(mapSandboxError)
        } finally {
          // Cleanup runs on ok/err/throw — the temp dir must never outlive the
          // call. Best-effort: a cleanup failure is swallowed (mirrors
          // removeCredential's reverse-orphan note) and never surfaces as a
          // call error.
          if (materializedDir !== undefined) {
            await rm(materializedDir, { recursive: true, force: true }).catch(() => {})
          }
        }
      }

      return new ResultAsync(work())
    },

    async close(): Promise<void> {
      // No persistent connection to release — no-op.
    },
  }
}

// ---------------------------------------------------------------------------
// Full-access provider (increment 41.3) — execute + help + shortcuts
// ---------------------------------------------------------------------------

function createFullAccessCliProvider(
  connection: FullAccessCliConnection,
  secret: CliSecret | null,
  paths: JunctionPaths,
): ToolProvider {
  const shortcuts: CliTool[] = connection.shortcuts ?? []

  // Shortcuts reuse the EXACT declared-tool projection + dispatch machinery —
  // build a nested declared-mode provider over a synthetic DeclaredCliConnection
  // so validateArgs/flag-injection-guard/buildArgv/prepareCredential/sandbox
  // are not re-implemented here (single source of truth for that machinery).
  const shortcutsConnection: CliConnection = {
    mode: "declared",
    tools: shortcuts,
    ...(connection.credentialEnvVar !== undefined
      ? { credentialEnvVar: connection.credentialEnvVar }
      : {}),
  }
  const shortcutsProvider: ToolProvider | undefined =
    shortcuts.length > 0 ? createDeclaredCliProvider(shortcutsConnection, secret, paths) : undefined

  const coreTools = buildFullAccessCoreTools(connection)
  const shortcutTools: ProviderTool[] = shortcuts.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: buildInputSchema(tool),
  }))
  const providerTools: ProviderTool[] = [...coreTools, ...shortcutTools]

  return {
    listTools(): ResultAsync<ProviderTool[], UpstreamError> {
      return okAsync(providerTools)
    },

    callTool(
      rawName: string,
      rawArgs: Record<string, unknown>,
    ): ResultAsync<ToolResult, UpstreamError> {
      if (rawName === "execute") {
        return callExecute(connection, secret, paths, rawArgs)
      }
      if (rawName === "help") {
        return callHelp(connection, rawArgs)
      }
      // Shortcuts: delegate verbatim to the nested declared-mode provider.
      if (shortcutsProvider && shortcuts.some((t) => t.name === rawName)) {
        return shortcutsProvider.callTool(rawName, rawArgs)
      }
      return errAsync({ kind: "tool-not-found", name: rawName } satisfies UpstreamError)
    },

    async close(): Promise<void> {
      if (shortcutsProvider) await shortcutsProvider.close()
    },
  }
}

/**
 * `execute` — run the pinned binary with agent-supplied argv (method file
 * EXECUTE PATH, spec §5 Q2/Q3). Credentialed + networked (allowNet from the
 * platform policy) — the DISTINCT invocation class from `help`'s safe probes.
 */
function callExecute(
  connection: FullAccessCliConnection,
  secret: CliSecret | null,
  paths: JunctionPaths,
  rawArgs: Record<string, unknown>,
): ResultAsync<ToolResult, UpstreamError> {
  // Steps 1-2: validate + guard the agent-supplied args/stdin.
  const validated = validateExecuteArgs(rawArgs)
  if (validated.isErr()) {
    return errAsync(validated.error)
  }
  const { args, stdin } = validated.value

  // Step 3: argv[0] is PINNED — the agent supplies only the elements AFTER
  // the binary; it can never override argv[0].
  const argv = [connection.binaryPath, ...args]

  async function work(): Promise<Result<ToolResult, UpstreamError>> {
    // Step 4: materialize + inject the credential — execute IS the
    // credentialed/networked/side-effecting invocation (unlike help's probes).
    // Wrap the connection in the shape prepareCredential expects (it reads
    // only .credentialEnvVar, shared verbatim by both CliConnection branches).
    const credentialCarrier: CliConnection = {
      mode: "declared",
      tools: [],
      ...(connection.credentialEnvVar !== undefined
        ? { credentialEnvVar: connection.credentialEnvVar }
        : {}),
    }
    const prepared = await prepareCredential(
      credentialCarrier,
      secret,
      connection.policy.envAllow ?? {},
      paths,
    )
    if (prepared.isErr()) {
      return err(prepared.error)
    }
    const { envAllow, extraReadPaths, materializedDir } = prepared.value

    // try starts BEFORE the policy literal — same LOW-2 hardening rationale
    // as the declared path's work(): a throw while constructing it must still
    // reach the finally and remove materializedDir.
    try {
      const policy = buildExecutePolicy(connection, envAllow, extraReadPaths, stdin)
      const startedAt = performance.now()

      return await createSandbox()
        .andThen((sandbox) => sandbox.runCommand(argv, policy))
        .map((result): ToolResult => {
          const durationMs = performance.now() - startedAt
          const payload = {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.outputCapped ?? false,
            durationMs,
          }
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            isError: result.exitCode !== 0 || (result.outputCapped ?? false),
          }
        })
        .mapErr(mapSandboxError)
    } finally {
      if (materializedDir !== undefined) {
        await rm(materializedDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  return new ResultAsync(work())
}

/**
 * `help` — walk the persisted extracted schema tree to one node, lazily
 * probing an `explored:false` node on first request (method file HELP PATH,
 * spec §5 Q2/Q4). Never credentialed, never networked — the safe-probe class.
 */
function callHelp(
  connection: FullAccessCliConnection,
  rawArgs: Record<string, unknown>,
): ResultAsync<ToolResult, UpstreamError> {
  const validated = validateHelpPath(rawArgs)
  if (validated.isErr()) {
    return errAsync(validated.error)
  }
  const path = validated.value

  const node = findSchemaNode(connection.schema.root, path)
  if (!node) {
    return errAsync({
      kind: "invalid-args",
      reason: `no such command path: ${JSON.stringify(path)}`,
    } satisfies UpstreamError)
  }
  // Re-bound to a non-optional const (mirrors the declared path's `resolvedTool`
  // pattern) — TS does not carry narrowing of a closed-over variable into the
  // nested `work()` closure below.
  const resolvedNode0: CliSchemaNode = node

  async function work(): Promise<Result<ToolResult, UpstreamError>> {
    const resolvedNode = await resolveHelpNode(connection, resolvedNode0)
    const projected = projectHelpNode(resolvedNode)
    return ok({
      content: [{ type: "text", text: JSON.stringify(projected) }],
      isError: false,
    })
  }

  return new ResultAsync(work())
}
