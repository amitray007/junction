// SPDX-License-Identifier: AGPL-3.0-only
// cli.ts — assemble a sandboxed CLI Platform. Mirrors addCliPlatform from the
// original cli/commands/platform.ts: validate the descriptor, probe sandbox
// capabilities (warn, don't fail), dry-run validatePolicy per tool, validate
// the platform.

import {
  CliConnectionSchema,
  createSandbox,
  type Platform,
  PlatformSchema,
  validatePolicy,
} from "@junction/core"
import { err, ok, type Result, ResultAsync } from "neverthrow"
import type { PlatformOrchestrationError } from "./errors.js"

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

  const platformParseResult = PlatformSchema.safeParse({
    id: input.id,
    kind: "cli",
    displayName: input.displayName,
    cli,
  })
  if (!platformParseResult.success) {
    const message = platformParseResult.error.issues.map((i) => i.message).join(", ")
    return err({ kind: "invalid-platform", message })
  }

  return ok({
    platform: platformParseResult.data,
    toolCount: cli.tools.length,
    sandboxWarning,
  })
}
