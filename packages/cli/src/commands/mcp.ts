// SPDX-License-Identifier: AGPL-3.0-only
// `junction mcp serve` — serve a per-profile MCP endpoint over stdio.
// Edge stays thin: load the profile from core, call mcp-server, nothing more.
//
// CRITICAL: this command's stdout IS the MCP channel. Nothing may be written
// to stdout except MCP JSON-RPC frames. Any human-readable output goes to
// stderr. Do NOT use consola (which writes to stdout) anywhere in this command.

import {
  createRepositories,
  deriveMcpEndpointPath,
  getDatabase,
  getPaths,
  type Profile,
  ProfileIdSchema,
} from "@junction/core"
import { serveStdio } from "@junction/mcp-server"
import { defineCommand } from "citty"

/** Synthetic default profile — used when no profile name is supplied or no profiles exist yet. */
function defaultProfile(): Profile {
  return {
    id: ProfileIdSchema.parse("default"),
    name: "default",
    sources: [],
    mcpEndpointPath: deriveMcpEndpointPath("default"),
  }
}

const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Serve a per-profile MCP endpoint over stdio.",
  },
  args: {
    profile: {
      type: "string",
      description: "Profile name to serve (defaults to 'default' if omitted or not found).",
      default: "",
    },
  },
  async run({ args }) {
    const profileName = args.profile

    // If no profile name given, serve the synthetic default immediately.
    if (!profileName) {
      await serveStdio(defaultProfile())
      return
    }

    // Load the named profile from the DB.
    const paths = getPaths()
    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) {
      // stderr only — stdout must stay MCP-only.
      process.stderr.write(
        `junction mcp serve: database error (${dbResult.error.kind}), serving synthetic default profile\n`,
      )
      await serveStdio(defaultProfile())
      return
    }

    const repos = createRepositories(dbResult.value)
    const result = await repos.profiles.getByName(profileName)

    if (result.isErr()) {
      // Profile not found or query error — fall back to synthetic default.
      process.stderr.write(
        `junction mcp serve: profile "${profileName}" not found, serving synthetic default profile\n`,
      )
      await serveStdio(defaultProfile())
      return
    }

    await serveStdio(result.value)
  },
})

export const mcpCommand = defineCommand({
  meta: {
    name: "mcp",
    description: "MCP server commands.",
  },
  subCommands: {
    serve: serveCommand,
  },
})
