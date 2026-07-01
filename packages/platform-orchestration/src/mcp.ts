// SPDX-License-Identifier: AGPL-3.0-only
// mcp.ts — assemble an MCP Platform. Mirrors addCommand.run's MCP path from the
// original cli/commands/platform.ts (the transport-branch + PlatformSchema.parse).

import { type McpConnection, type Platform, PlatformSchema } from "@junction/core"
import { errAsync, okAsync, type ResultAsync } from "neverthrow"
import type { PlatformOrchestrationError } from "./errors.js"

export interface AddMcpPlatformInput {
  id: string
  displayName: string
  transport: "http" | "stdio"
  // http
  url?: string
  authHeader?: string
  // stdio
  command?: string
  args?: string[]
  tokenEnvVar?: string
}

/**
 * Assemble an MCP Platform from add-time input. Mirrors the CLI's MCP transport
 * branch exactly: validates the transport, builds the McpConnection, then
 * validates the whole Platform via PlatformSchema.
 */
export function addMcpPlatform(
  input: AddMcpPlatformInput,
): ResultAsync<Platform, PlatformOrchestrationError> {
  let connection: McpConnection
  if (input.transport === "http") {
    if (!input.url) {
      return errAsync({ kind: "missing-field", field: "url", context: "http transport" })
    }
    connection = {
      transport: "http",
      url: input.url,
      auth: { scheme: "bearer", header: input.authHeader ?? "Authorization" },
    }
  } else if (input.transport === "stdio") {
    if (!input.command) {
      return errAsync({ kind: "missing-field", field: "command", context: "stdio transport" })
    }
    connection = {
      transport: "stdio",
      command: input.command,
      args: input.args ?? [],
      tokenEnvVar: input.tokenEnvVar,
    }
  } else {
    return errAsync({ kind: "invalid-transport", transport: input.transport })
  }

  const parseResult = PlatformSchema.safeParse({
    id: input.id,
    kind: "mcp",
    displayName: input.displayName,
    connection,
  })
  if (!parseResult.success) {
    const message = parseResult.error.issues.map((i) => i.message).join(", ")
    return errAsync({ kind: "invalid-platform", message })
  }

  return okAsync(parseResult.data)
}
