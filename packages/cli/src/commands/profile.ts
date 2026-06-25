// SPDX-License-Identifier: AGPL-3.0-only
// `junction profile` — profile management commands. Currently: `list`.
// Edge stays thin: calls core, formats output. No business logic here.

import {
  createRepositories,
  type DbError,
  getDatabase,
  getPaths,
  type Profile,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"

function formatDbError(e: DbError): string {
  switch (e.kind) {
    case "not-found":
      return `not found: ${e.entity} ${e.id}`
    case "migration-failed":
      return `database migration failed: ${String(e.cause)}`
    case "constraint-violation":
      return `constraint violation: ${String(e.cause)}`
    case "query-failed":
      return `query failed: ${String(e.cause)}`
  }
}

/** Render a DbError to the user (JSON or human), set exit code 1. */
function reportDbError(e: DbError, json: boolean): void {
  const msg = formatDbError(e)
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
  } else {
    consola.error(msg)
  }
  process.exitCode = 1
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all profiles.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
      default: false,
    },
  },
  async run({ args }) {
    const json = args.json ?? false
    const paths = getPaths()

    const dbResult = await getDatabase(paths)
    if (dbResult.isErr()) {
      reportDbError(dbResult.error, json)
      return
    }

    const repos = createRepositories(dbResult.value)
    const result = await repos.profiles.list()

    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    const profileList = result.value

    if (json) {
      process.stdout.write(`${JSON.stringify(profileList)}\n`)
      return
    }

    if (profileList.length === 0) {
      // Use stdout directly (not consola.info, which consola suppresses under
      // NODE_ENV=test and other non-interactive contexts) so the empty-state
      // line is always emitted — agents and scripts rely on it.
      process.stdout.write("No profiles yet. (Connecting platforms comes later.)\n")
      return
    }

    const lines = [
      "  name              sources  endpoint",
      "  ----------------  -------  --------------------------------",
      ...profileList.map(
        (p: Profile) =>
          `  ${p.name.padEnd(16)}  ${String(p.sources.length).padEnd(7)}  ${p.mcpEndpointPath}`,
      ),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

export const profileCommand = defineCommand({
  meta: {
    name: "profile",
    description: "Manage profiles.",
  },
  subCommands: {
    list: listCommand,
  },
})
