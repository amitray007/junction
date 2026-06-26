// SPDX-License-Identifier: AGPL-3.0-only
// `junction profile` — profile management commands: `create`, `list`, `add-source`,
//   `show`, `remove-source`, `enable-source`, `disable-source`, `delete`.
// Edge stays thin: calls core, formats output. No business logic here.
// SECURITY: profile show NEVER includes secret or secretRef — only metadata.

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
      const msg = `invalid profile name "${nameRaw}": ${nameResult.error.issues.map((i: { message: string }) => i.message).join(", ")}`
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

// ---------------------------------------------------------------------------
// profile show — authoritative "what's wired" view. NEVER includes secret.
// ---------------------------------------------------------------------------

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show the sources wired to a profile (metadata only — no secret).",
  },
  args: {
    name: {
      type: "string",
      description: "Profile name",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const profileResult = await repos.profiles.getByName(args.name)
    if (profileResult.isErr()) {
      reportDbError(profileResult.error, json)
      return
    }
    const profile = profileResult.value

    // Build source view: for each SourceRef, join platform + credential metadata.
    // NEVER include secret or secretRef — only account label (credential.profileName).
    const sources: Array<{
      namespace: string
      platform: string
      credentialAccount: string
      enabled: boolean
      toolFilter?: { allow?: string[]; deny?: string[] }
    }> = []

    for (const sr of profile.sources) {
      const credResult = await repos.credentials.get(String(sr.credentialId))
      const credentialAccount = credResult.isOk() ? credResult.value.profileName : "(unknown)"
      sources.push({
        namespace: sr.toolNamespace,
        platform: String(sr.platformId),
        credentialAccount,
        enabled: sr.enabled,
        ...(sr.toolFilter !== undefined ? { toolFilter: sr.toolFilter } : {}),
      })
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, profile: { id: profile.id, name: profile.name, mcpEndpointPath: profile.mcpEndpointPath }, sources })}\n`,
      )
      return
    }

    process.stdout.write(`Profile: ${profile.name}  (${profile.mcpEndpointPath})\n`)
    if (sources.length === 0) {
      process.stdout.write('  No sources. Use "junction profile add-source" to add one.\n')
      return
    }
    const header = "  namespace         platform              account           enabled"
    const divider = "  ----------------  --------------------  ----------------  -------"
    const rows = sources.map(
      (s) =>
        `  ${s.namespace.padEnd(16)}  ${s.platform.padEnd(20)}  ${s.credentialAccount.padEnd(16)}  ${s.enabled ? "yes" : "no"}`,
    )
    process.stdout.write(`${[header, divider, ...rows].join("\n")}\n`)
  },
})

// ---------------------------------------------------------------------------
// profile remove-source
// ---------------------------------------------------------------------------

const removeSourceCommand = defineCommand({
  meta: {
    name: "remove-source",
    description: "Remove an MCP source from a profile.",
  },
  args: {
    profile: {
      type: "string",
      description: "Profile name",
      required: true,
    },
    namespace: {
      type: "string",
      description: "Tool namespace to remove",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const profileResult = await repos.profiles.getByName(args.profile)
    if (profileResult.isErr()) {
      reportDbError(profileResult.error, json)
      return
    }
    const profile = profileResult.value

    const result = await repos.profiles.removeSource(profile.id, args.namespace)
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, profileName: args.profile, namespace: args.namespace })}\n`,
      )
    } else {
      consola.success(`Source "${args.namespace}" removed from profile "${args.profile}"`)
    }
  },
})

// ---------------------------------------------------------------------------
// profile enable-source / disable-source
// ---------------------------------------------------------------------------

function makeToggleCommand(enabled: boolean) {
  const action = enabled ? "enable" : "disable"
  return defineCommand({
    meta: {
      name: `${action}-source`,
      description: `${enabled ? "Enable" : "Disable"} an MCP source in a profile (toggle enabled flag).`,
    },
    args: {
      profile: {
        type: "string",
        description: "Profile name",
        required: true,
      },
      namespace: {
        type: "string",
        description: "Tool namespace to toggle",
        required: true,
      },
      json: JSON_ARG,
    },
    async run({ args }) {
      const json = args.json ?? false
      const repos = await openDb(json)
      if (!repos) return

      const profileResult = await repos.profiles.getByName(args.profile)
      if (profileResult.isErr()) {
        reportDbError(profileResult.error, json)
        return
      }
      const profile = profileResult.value

      const result = await repos.profiles.setSourceEnabled(profile.id, args.namespace, enabled)
      if (result.isErr()) {
        reportDbError(result.error, json)
        return
      }

      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, profileName: args.profile, namespace: args.namespace, enabled })}\n`,
        )
      } else {
        consola.success(
          `Source "${args.namespace}" in profile "${args.profile}" ${enabled ? "enabled" : "disabled"}`,
        )
      }
    },
  })
}

const enableSourceCommand = makeToggleCommand(true)
const disableSourceCommand = makeToggleCommand(false)

// ---------------------------------------------------------------------------
// profile delete
// ---------------------------------------------------------------------------

const deleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a profile and all its sources (source_refs cascade).",
  },
  args: {
    name: {
      type: "string",
      description: "Profile name",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    // Look up by name so we can pass the id to delete
    const profileResult = await repos.profiles.getByName(args.name)
    if (profileResult.isErr()) {
      reportDbError(profileResult.error, json)
      return
    }
    const profile = profileResult.value

    const result = await repos.profiles.delete(profile.id)
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, name: args.name })}\n`)
    } else {
      consola.success(`Profile "${args.name}" deleted (sources cascaded)`)
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
    show: showCommand,
    "add-source": addSourceCommand,
    "remove-source": removeSourceCommand,
    "enable-source": enableSourceCommand,
    "disable-source": disableSourceCommand,
    delete: deleteCommand,
  },
})
