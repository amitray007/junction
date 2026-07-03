// SPDX-License-Identifier: AGPL-3.0-only
// CLI ToolProvider — executes operator-declared commands via the sandbox.
//
// SECURITY-CRITICAL: read docs/methods/21-sandboxed-cli-source.md and
// docs/methods/28.9-credential-hardening.md (file-kind mechanics, slice D)
// before editing.
//
// Security invariants enforced here:
//   1. No shell, ever — argv array to sandbox; shell:false is enforced in exec.ts.
//   2. Agent cannot widen argv — each segment yields ≤1 element (buildArgv).
//   3. argv[0] is operator-fixed absolute binary path (CliToolSchema refine).
//   4. Secret only in policy.env[credentialEnvVar] — never argv, logs, or results.
//      For kind "file" the env var carries a materialized temp-file PATH, not the
//      secret bytes; the file itself is 0600, lives in a per-call temp dir UNDER
//      paths.runtimeDir (junction-private, 0700, INSIDE the junction home — never
//      the shared OS tmpdir, which same-uid sibling processes can be granted
//      readPaths over) added to readPaths, and is deleted in a finally (ok/err/
//      throw — see callTool).
//   5. Fail closed — always createSandbox().runCommand(); never raw child_process.
//   6. validatePolicy runs inside sandbox.runCommand (metachar + exposure + denylist) —
//      the file-kind temp dir flows through the SAME check via readPaths; it is
//      never granted a bypass.
//
// SOURCE-AGNOSTIC: no vendor code. No external deps beyond core sandbox + Zod.

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { errAsync, okAsync } from "neverthrow"
import type { UpstreamError } from "../../errors/index.js"
import { ensureRuntimeDir, getPaths, type JunctionPaths } from "../../paths/index.js"
import { err, ok, type Result, ResultAsync } from "../../result/index.js"
import { createSandbox } from "../../sandbox/index.js"
import type { CliConnection, CliSecret, CliTool } from "../../schema/cli-connection.js"
import type { ProviderTool, ToolProvider, ToolResult } from "../provider.js"
import { validateArgs } from "./args.js"
import { buildArgv } from "./argv.js"

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
// createCliProvider
// ---------------------------------------------------------------------------

/**
 * Create a ToolProvider backed by operator-declared CLI commands.
 *
 * @param connection  The validated CliConnection descriptor (operator-declared commands).
 * @param secret      Resolved credential secret tagged by kind, or null for
 *                    public/no-auth tools. kind "env" (and the legacy default
 *                    — see resolveCredentialSecret) behaves EXACTLY as before:
 *                    the value is injected directly into policy.env. kind
 *                    "file" is NEW (increment 28.9 slice D): the value is the
 *                    file CONTENT, materialized per-call to a 0600 temp file
 *                    whose PATH is injected instead — see callTool below.
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
  // Build a name→tool lookup once at construction time.
  const byName = new Map<string, CliTool>()
  for (const tool of connection.tools) {
    byName.set(tool.name, tool)
  }

  // Pre-build ProviderTool descriptors (stable across calls — listTools is pure).
  const providerTools: ProviderTool[] = connection.tools.map((tool) => ({
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
            .mapErr((sandboxErr): UpstreamError => {
              // Step 6b: map Err(SandboxError) → UpstreamError (secret-free).
              // Error causes use constructor.name, never message (which may carry paths/secrets).
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
                      sandboxErr.cause instanceof Error
                        ? sandboxErr.cause.constructor.name
                        : "spawn-failed",
                  }
                case "timed-out":
                  return { kind: "timed-out", ms: sandboxErr.timeoutMs }
                default: {
                  const _: never = sandboxErr
                  return { kind: "call-failed", cause: "unknown sandbox error" }
                }
              }
            })
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
