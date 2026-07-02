// SPDX-License-Identifier: AGPL-3.0-only
// `junction profile` — profile management commands: `create`, `list`, `add-source`,
//   `show`, `remove-source`, `enable-source`, `disable-source`, `delete`.
// Edge stays thin: calls core, formats output. No business logic here.
// SECURITY: profile show NEVER includes secret or secretRef — only metadata.

import {
  newProfileId,
  type Profile,
  ProfileNameSchema,
  type Repositories,
  type SourceRef,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { collectRepeatableFlag, JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportDbError } from "../format.js"

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
    }

    const result = await repos.profiles.create(profile)
    if (result.isErr()) {
      reportDbError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, id: result.value.id, name: result.value.name })}\n`,
      )
    } else {
      consola.success(`Profile "${name}" created`)
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
      "  name              sources",
      "  ----------------  -------",
      ...profileList.map((p: Profile) => `  ${p.name.padEnd(16)}  ${String(p.sources.length)}`),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

const addSourceCommand = defineCommand({
  meta: {
    name: "add-source",
    description:
      "Add an MCP source to a profile (takes effect the next time the profile is served).",
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
      description: "Credential ID (optional — omit for public/no-auth sources)",
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
    // Collect repeatable --allow / --deny flags from rawArgs before entering the callback
    const allowList = collectRepeatableFlag(rawArgs, "--allow")
    const denyList = collectRepeatableFlag(rawArgs, "--deny")

    await withResolvedProfile(args, async ({ json, profileId, namespace, repos }) => {
      // Build SourceRef input; credentialId is optional — absent for public/no-auth sources.
      // We pass the raw object through addSource, which calls SourceRefSchema.parse() internally.
      const credentialId =
        args.credential !== undefined && args.credential !== ""
          ? (args.credential as NonNullable<SourceRef["credentialId"]>)
          : undefined

      const toolFilter =
        allowList.length > 0 || denyList.length > 0
          ? {
              allow: allowList.length > 0 ? allowList : undefined,
              deny: denyList.length > 0 ? denyList : undefined,
            }
          : undefined

      const sourceRefInput = {
        platformId: args.platform as SourceRef["platformId"],
        credentialId,
        toolNamespace: namespace,
        enabled: true as const,
        toolFilter,
      }
      const sourceRef = sourceRefInput as unknown as SourceRef

      const result = await repos.profiles.addSource(profileId, sourceRef)
      if (result.isErr()) {
        reportDbError(result.error, json)
        return
      }
      reportSourceOk(
        json,
        { profileName: args.profile, namespace },
        `Source "${namespace}" added to profile "${args.profile}" (platform: ${args.platform}; takes effect the next time the profile is served)`,
      )
    })
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
    await withNamedProfile(args, async ({ json, profile, repos }) => {
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
        // No credentialId → public/no-auth source; skip credentials.get entirely
        let credentialAccount: string
        if (sr.credentialId === undefined) {
          credentialAccount = "(none)"
        } else {
          const credResult = await repos.credentials.get(String(sr.credentialId))
          credentialAccount = credResult.isOk() ? credResult.value.profileName : "(unknown)"
        }
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
          `${JSON.stringify({ ok: true, profile: { id: profile.id, name: profile.name }, sources })}\n`,
        )
        return
      }

      process.stdout.write(`Profile: ${profile.name}\n`)
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
    })
  },
})

// ---------------------------------------------------------------------------
// Shared helpers for profile subcommands
// ---------------------------------------------------------------------------

/** Context passed to source-subcommand callbacks (add/remove/enable/disable). */
type SourceCtx = {
  json: boolean
  profileId: string
  namespace: string
  repos: Repositories
}

/** Context passed to profile-level callbacks (show, delete). */
type ProfileCtx = {
  json: boolean
  profile: Profile
  repos: Repositories
}

/**
 * Open the DB, resolve a profile by name (used with `--profile` + `--namespace` args),
 * and call `action` with the resolved context.
 * Eliminates the repeated openDb + getByName boilerplate for source subcommands.
 */
async function withResolvedProfile(
  args: { profile: string; namespace: string; json?: boolean | null },
  action: (ctx: SourceCtx) => Promise<void>,
): Promise<void> {
  const json = args.json ?? false
  const repos = await openDb(json)
  if (!repos) return

  const profileResult = await repos.profiles.getByName(args.profile)
  if (profileResult.isErr()) {
    reportDbError(profileResult.error, json)
    return
  }
  await action({ json, profileId: profileResult.value.id, namespace: args.namespace, repos })
}

/**
 * Open the DB, resolve a profile by name (used with `--name` args, e.g. show, delete),
 * and call `action` with the resolved context.
 */
async function withNamedProfile(
  args: { name: string; json?: boolean | null },
  action: (ctx: ProfileCtx) => Promise<void>,
): Promise<void> {
  const json = args.json ?? false
  const repos = await openDb(json)
  if (!repos) return

  const profileResult = await repos.profiles.getByName(args.name)
  if (profileResult.isErr()) {
    reportDbError(profileResult.error, json)
    return
  }
  await action({ json, profile: profileResult.value, repos })
}

/**
 * Write a source-operation success message in the appropriate format.
 * Extracted from add/remove/toggle to eliminate the repeated json/human branching.
 */
function reportSourceOk(
  json: boolean,
  jsonPayload: Record<string, unknown>,
  humanMsg: string,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...jsonPayload })}\n`)
  } else {
    consola.success(humanMsg)
  }
}

// ---------------------------------------------------------------------------
// profile remove-source
// ---------------------------------------------------------------------------

const removeSourceCommand = defineCommand({
  meta: {
    name: "remove-source",
    description:
      "Remove an MCP source from a profile (takes effect the next time the profile is served).",
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
    await withResolvedProfile(args, async ({ json, profileId, namespace, repos }) => {
      const result = await repos.profiles.removeSource(profileId, namespace)
      if (result.isErr()) {
        reportDbError(result.error, json)
        return
      }
      reportSourceOk(
        json,
        { profileName: args.profile, namespace },
        `Source "${namespace}" removed from profile "${args.profile}" (takes effect the next time the profile is served)`,
      )
    })
  },
})

// ---------------------------------------------------------------------------
// profile enable-source / disable-source
// ---------------------------------------------------------------------------

function makeToggleCommand(enabled: boolean) {
  const verb = enabled ? "enable" : "disable"
  return defineCommand({
    meta: {
      name: `${verb}-source`,
      description: `${enabled ? "Enable" : "Disable"} an MCP source in a profile (takes effect the next time the profile is served).`,
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
      await withResolvedProfile(args, async ({ json, profileId, namespace, repos }) => {
        const result = await repos.profiles.setSourceEnabled(profileId, namespace, enabled)
        if (result.isErr()) {
          reportDbError(result.error, json)
          return
        }
        reportSourceOk(
          json,
          { profileName: args.profile, namespace, enabled },
          `Source "${namespace}" in profile "${args.profile}" ${enabled ? "enabled" : "disabled"} (takes effect the next time the profile is served)`,
        )
      })
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
      description: "Name of the profile to delete",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    await withNamedProfile(args, async ({ json, profile, repos }) => {
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
    })
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
