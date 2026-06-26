// SPDX-License-Identifier: AGPL-3.0-only
// `junction platform` — platform management commands: `add`, `list`.
// SOURCE-AGNOSTIC: no vendor/GitHub-specific logic. Platforms are generic DATA rows.
// Edge stays thin: calls core, formats output. No business logic here.

import { type McpConnection, type Platform, PlatformSchema } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { collectRepeatableFlag, JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportDbError } from "../format.js"

/** Report a string error in the appropriate format and set exitCode=1. */
function reportError(msg: string, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  else consola.error(msg)
  process.exitCode = 1
}

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Define or update a generic MCP source platform.",
  },
  args: {
    id: { type: "string", description: "Stable platform ID (e.g. my-mcp-server)", required: true },
    kind: { type: "string", description: "Platform kind (default: mcp)", default: "mcp" },
    "display-name": {
      type: "string",
      description: "Human-readable name (e.g. My MCP Server)",
      required: true,
    },
    transport: {
      type: "string",
      description: "Transport: http (remote URL) or stdio (local command)",
      required: true,
    },
    // HTTP transport flags
    url: { type: "string", description: "[http] Remote MCP server URL" },
    "auth-header": {
      type: "string",
      description: "[http] HTTP header to carry the bearer token (default: Authorization)",
    },
    // Stdio transport flags
    command: { type: "string", description: "[stdio] Command to launch the MCP server (e.g. npx)" },
    // --arg handled via rawArgs (repeatable)
    "token-env": {
      type: "string",
      description: "[stdio] Env-var name the bearer token is injected into",
    },
    json: JSON_ARG,
  },
  async run({ args, rawArgs }) {
    const json = args.json ?? false
    const transport = args.transport

    // Build the generic MCP connection descriptor from flags
    let connection: McpConnection | undefined
    if (transport === "http") {
      if (!args.url) {
        reportError("--url is required for http transport", json)
        return
      }
      connection = {
        transport: "http",
        url: args.url,
        auth: { scheme: "bearer", header: args["auth-header"] ?? "Authorization" },
      }
    } else if (transport === "stdio") {
      if (!args.command) {
        reportError("--command is required for stdio transport", json)
        return
      }
      connection = {
        transport: "stdio",
        command: args.command,
        args: collectRepeatableFlag(rawArgs, "--arg"),
        tokenEnvVar: args["token-env"],
      }
    } else {
      reportError(`unknown transport "${transport}": must be "http" or "stdio"`, json)
      return
    }

    // Validate the full platform shape via PlatformSchema (Zod — boundary validation)
    const parseResult = PlatformSchema.safeParse({
      id: args.id,
      kind: args.kind ?? "mcp",
      displayName: args["display-name"],
      connection,
    })
    if (!parseResult.success) {
      const msg = parseResult.error.issues.map((i: { message: string }) => i.message).join(", ")
      reportError(`Invalid platform: ${msg}`, json)
      return
    }
    const platform: Platform = parseResult.data

    const repos = await openDb(json)
    if (!repos) return

    const result = await repos.platforms.upsert(platform)
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, platform: result.value })}\n`)
    } else {
      consola.success(
        `Platform "${platform.displayName}" (${platform.id}) defined — transport: ${transport}`,
      )
    }
  },
})

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all platforms.",
  },
  args: { json: JSON_ARG },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const result = await repos.platforms.list()
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    const platformList = result.value

    if (json) {
      process.stdout.write(`${JSON.stringify(platformList)}\n`)
      return
    }

    if (platformList.length === 0) {
      process.stdout.write(
        'No platforms yet. Use "junction platform add" to define an MCP source.\n',
      )
      return
    }

    const lines = [
      "  id                      kind     transport  display name",
      "  ----------------------  -------  ---------  --------------------------------",
      ...platformList.map((p: Platform) => {
        const transport = p.connection?.transport ?? "-"
        return `  ${p.id.padEnd(22)}  ${p.kind.padEnd(7)}  ${transport.padEnd(9)}  ${p.displayName}`
      }),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

// ---------------------------------------------------------------------------
// platform remove — delete a platform (RESTRICT FK: fails if credentials reference it)
// ---------------------------------------------------------------------------

const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a platform (fails if credentials still reference it).",
  },
  args: {
    id: {
      type: "string",
      description: "Platform ID",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const result = await repos.platforms.delete(args.id)
    if (result.isErr()) {
      const e = result.error
      if (e.kind === "in-use") {
        const msg = `platform "${args.id}" is in use by one or more credentials; remove those credentials first`
        if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
        else consola.error(msg)
        process.exitCode = 1
        return
      }
      reportDbError(e, json)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, id: args.id })}\n`)
    } else {
      consola.success(`Platform "${args.id}" removed`)
    }
  },
})

export const platformCommand = defineCommand({
  meta: {
    name: "platform",
    description: "Manage MCP source platforms.",
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
    remove: removeCommand,
  },
})
