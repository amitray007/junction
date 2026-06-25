// SPDX-License-Identifier: AGPL-3.0-only
// `junction profile` — profile management commands: `create`, `list`, `add-source`.
// Edge stays thin: calls core, formats output. No business logic here.

import {
  createCredentialStore,
  deriveMcpEndpointPath,
  getPaths,
  newProfileId,
  type Profile,
  ProfileNameSchema,
  type SourceRef,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { collectRepeatableFlag, JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportCredentialError, reportDbError } from "../format.js"

const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create a new empty profile.",
  },
  args: {
    name: {
      type: "string",
      description: "Profile name (e.g. work, personal, client-acme)",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const nameRaw = args.name

    // Validate name early — gives a clear error before touching the DB.
    const nameResult = ProfileNameSchema.safeParse(nameRaw)
    if (!nameResult.success) {
      const msg = `invalid profile name "${nameRaw}": ${nameResult.error.issues.map((i) => i.message).join(", ")}`
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      } else {
        consola.error(msg)
      }
      process.exitCode = 1
      return
    }

    const name = nameResult.data
    const repos = await openDb(json)
    if (!repos) return

    const profile: Profile = {
      id: newProfileId(),
      name,
      sources: [],
      mcpEndpointPath: deriveMcpEndpointPath(name),
    }

    const result = await repos.profiles.create(profile)
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, id: result.value.id, name: result.value.name, mcpEndpointPath: result.value.mcpEndpointPath })}\n`,
      )
    } else {
      consola.success(`Profile "${name}" created (endpoint: ${profile.mcpEndpointPath})`)
    }
  },
})

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all profiles.",
  },
  args: { json: JSON_ARG },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

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

const addSourceCommand = defineCommand({
  meta: {
    name: "add-source",
    description: "Add an MCP source to a profile.",
  },
  args: {
    profile: {
      type: "string",
      description: "Profile name",
      required: true,
    },
    platform: {
      type: "string",
      description: "Platform ID",
      required: true,
    },
    credential: {
      type: "string",
      description: "Credential ID",
      required: true,
    },
    namespace: {
      type: "string",
      description: "Tool namespace (e.g. github_work) — must be unique within the profile",
      required: true,
    },
    allow: {
      type: "string",
      description: "Allow-list tool name (repeatable: --allow list_issues --allow get_issue)",
    },
    deny: {
      type: "string",
      description: "Deny-list tool name (repeatable: --deny admin_delete)",
    },
    json: JSON_ARG,
  },
  async run({ args, rawArgs }) {
    const json = args.json ?? false
    const paths = getPaths()

    // Collect repeatable --allow / --deny flags from rawArgs
    const allowList = collectRepeatableFlag(rawArgs, "--allow")
    const denyList = collectRepeatableFlag(rawArgs, "--deny")

    const repos = await openDb(json)
    if (!repos) return

    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      reportCredentialError(storeResult.error, json)
      return
    }

    // Resolve profile by name
    const profileResult = await repos.profiles.getByName(args.profile)
    if (profileResult.isErr()) {
      reportDbError(profileResult.error, json)
      return
    }
    const profile = profileResult.value

    const sourceRef: SourceRef = {
      platformId: args.platform as SourceRef["platformId"],
      credentialId: args.credential as SourceRef["credentialId"],
      toolNamespace: args.namespace,
      enabled: true,
      toolFilter:
        allowList.length > 0 || denyList.length > 0
          ? {
              allow: allowList.length > 0 ? allowList : undefined,
              deny: denyList.length > 0 ? denyList : undefined,
            }
          : undefined,
    }

    const result = await repos.profiles.addSource(profile.id, sourceRef)
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, profileName: args.profile, namespace: args.namespace })}\n`,
      )
    } else {
      consola.success(
        `Source "${args.namespace}" added to profile "${args.profile}" (platform: ${args.platform})`,
      )
    }
  },
})

export const profileCommand = defineCommand({
  meta: {
    name: "profile",
    description: "Manage profiles.",
  },
  subCommands: {
    create: createCommand,
    list: listCommand,
    "add-source": addSourceCommand,
  },
})
