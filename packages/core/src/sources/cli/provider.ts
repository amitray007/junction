// SPDX-License-Identifier: AGPL-3.0-only
// CLI ToolProvider — executes operator-declared commands via the sandbox.
//
// SECURITY-CRITICAL: read docs/methods/21-sandboxed-cli-source.md before editing.
//
// Security invariants enforced here:
//   1. No shell, ever — argv array to sandbox; shell:false is enforced in exec.ts.
//   2. Agent cannot widen argv — each segment yields ≤1 element (buildArgv).
//   3. argv[0] is operator-fixed absolute binary path (CliToolSchema refine).
//   4. Secret only in policy.env[credentialEnvVar] — never argv, logs, or results.
//   5. Fail closed — always createSandbox().runCommand(); never raw child_process.
//   6. validatePolicy runs inside sandbox.runCommand (metachar + exposure + denylist).
//
// SOURCE-AGNOSTIC: no vendor code. No external deps beyond core sandbox + Zod.

import { errAsync, okAsync } from "neverthrow"
import type { UpstreamError } from "../../errors/index.js"
import type { ResultAsync } from "../../result/index.js"
import { createSandbox } from "../../sandbox/index.js"
import type { CliConnection, CliTool } from "../../schema/cli-connection.js"
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
// createCliProvider
// ---------------------------------------------------------------------------

/**
 * Create a ToolProvider backed by operator-declared CLI commands.
 *
 * @param connection  The validated CliConnection descriptor (operator-declared commands).
 * @param secret      Resolved credential secret, or null for public/no-auth tools.
 *
 * SECRET DISCIPLINE: `secret` is used only to populate `policy.env[credentialEnvVar]`.
 * It never appears in argv, tool results, error messages, or logs.
 */
export function createCliProvider(connection: CliConnection, secret: string | null): ToolProvider {
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
      // Step 1: resolve the tool by name.
      const tool = byName.get(rawName)
      if (!tool) {
        return errAsync({ kind: "tool-not-found", name: rawName } satisfies UpstreamError)
      }

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

      // Step 4: build sandbox policy.
      // The secret is injected as ONE env var — never in argv, never logged.
      const envAllow: Record<string, string> = { ...(tool.policy.envAllow ?? {}) }
      if (secret !== null && connection.credentialEnvVar) {
        // credentialEnvVar is validated by CliConnectionSchema to not end in
        // _TOKEN/_SECRET/_KEY so it passes validatePolicy's secret-denylist check.
        envAllow[connection.credentialEnvVar] = secret
      }

      const policy = {
        cwd: tool.policy.cwd,
        // Always include cwd in readPaths so the process can access its working dir.
        readPaths: [...new Set([tool.policy.cwd, ...tool.policy.readPaths])],
        writePaths: tool.policy.writePaths,
        allowNet: tool.policy.allowNet,
        timeoutMs: tool.policy.timeoutMs,
        env: envAllow,
      }

      // Step 5: run through the sandbox — createSandbox() refuses if no backend.
      // This is the fail-closed guarantee: no path here bypasses the sandbox.
      return createSandbox()
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
    },

    async close(): Promise<void> {
      // No persistent connection to release — no-op.
    },
  }
}
