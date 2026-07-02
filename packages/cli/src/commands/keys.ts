// SPDX-License-Identifier: AGPL-3.0-only
// `junction keys` — create/list/revoke junction's own MCP API keys (increment 27).
//
// SECURITY (§2.1/§3): the full plaintext token is printed ONCE at `create` time
// (stdout for the value itself, plus a stderr "won't be shown again" warning on
// the human path) and NEVER again. `list` shows metadata only — label,
// jct_<keyid>, scope, created, lastUsed, status — never the secret. `revoke`
// accepts a bare keyid or a full pasted token (parsed via parseApiKeyToken;
// the secret half is discarded, only the keyid is used) and is idempotent.

import type { ApiKeyError, DbError } from "@junction/core"
import { type ApiKeyScope, mintApiKey, parseApiKeyToken } from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { collectRepeatableFlag, JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportDbError, reportError } from "../format.js"

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Render mintApiKey's error union (ApiKeyError | DbError) as a safe message.
 * Exhaustive over both unions' `kind` values — no `default` branch, no `as
 * never` (docs/rules/typescript.md) — adding a new kind to either union
 * becomes a compile error here.
 */
function formatMintError(e: ApiKeyError | DbError): string {
  switch (e.kind) {
    case "invalid-format":
      return `invalid label: ${e.reason}`
    case "unknown-key":
      return "failed to mint key: unknown key"
    case "revoked":
      return "failed to mint key: key revoked"
    case "empty-scope":
      return "failed to mint key: empty scope"
    case "not-found":
      return `failed to mint key: not found (${e.id})`
    case "db-error":
      return "failed to mint key: database error"
    case "migration-failed":
      return "failed to mint key: database migration failed"
    case "constraint-violation":
      return "failed to mint key: constraint violation"
    case "in-use":
      return "failed to mint key: resource in use"
    case "duplicate-namespace":
      return "failed to mint key: duplicate namespace"
    case "query-failed":
      return "failed to mint key: query failed"
  }
}

const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Mint a new junction API key (prints the full key ONCE).",
  },
  args: {
    label: {
      type: "string",
      description: "Human-readable label for the key",
      required: true,
    },
    profile: {
      type: "string",
      description: "Profile name to scope the key to (repeatable for a multi-profile key)",
    },
    global: {
      type: "boolean",
      description: "Scope the key to ALL profiles (present and future)",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args, rawArgs }) {
    const json = args.json ?? false
    const profileNames = collectRepeatableFlag(rawArgs, "--profile")
    const isGlobal = args.global === true

    // --global and --profile are mutually exclusive.
    if (isGlobal && profileNames.length > 0) {
      reportError(json, "--global and --profile are mutually exclusive")
      return
    }
    if (!isGlobal && profileNames.length === 0) {
      reportError(json, "specify --global or at least one --profile <name>")
      return
    }

    const repos = await openDb(json)
    if (!repos) return

    let scope: ApiKeyScope
    let profileIds: string[] = []

    if (isGlobal) {
      scope = "global"
    } else {
      // Resolve profile names → dedupe by resolved id → distinct count decides
      // scope kind (§1). Any unknown name fails the whole mint (all-or-nothing).
      const resolvedIds = new Set<string>()
      for (const name of profileNames) {
        const profileResult = await repos.profiles.getByName(name)
        if (profileResult.isErr()) {
          reportError(json, `unknown profile "${name}" — mint aborted`)
          return
        }
        resolvedIds.add(profileResult.value.id)
      }
      profileIds = [...resolvedIds]
      scope = profileIds.length === 1 ? "profile" : "profiles"
    }

    const mintResult = await mintApiKey({ label: args.label, scope, profileIds }, repos.apiKeys)
    if (mintResult.isErr()) {
      reportError(json, formatMintError(mintResult.error))
      return
    }

    const minted = mintResult.value

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          key: minted.plaintext,
          keyid: `jct_${minted.meta.id}`,
          label: minted.meta.label,
          scope: minted.meta.scope,
          createdAt: minted.meta.createdAt,
        })}\n`,
      )
      process.stderr.write(
        "Warning: this key will not be shown again. Store it now — if you lose it, revoke this key and mint a new one.\n",
      )
      return
    }

    process.stdout.write(`${minted.plaintext}\n`)
    consola.success(
      `Key minted — label: ${minted.meta.label}, keyid: jct_${minted.meta.id}, scope: ${minted.meta.scope}`,
    )
    process.stderr.write(
      "This key will not be shown again. Store it now — if you lose it, revoke this key and mint a new one.\n",
    )
  },
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List junction API keys (metadata only — never the secret).",
  },
  args: {
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const listResult = await repos.apiKeys.list()
    if (listResult.isErr()) {
      reportDbError(listResult.error, json)
      return
    }

    const rows = listResult.value.map((k) => ({
      label: k.label,
      keyid: `jct_${k.id}`,
      scope: k.scope,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      status: k.revokedAt === null ? ("active" as const) : ("revoked" as const),
    }))

    if (json) {
      process.stdout.write(`${JSON.stringify(rows)}\n`)
      return
    }

    if (rows.length === 0) {
      process.stdout.write('No API keys. Use "junction keys create" to mint one.\n')
      return
    }

    const lines = [
      "  label                 keyid                                scope     created              lastUsed             status",
      "  --------------------  -----------------------------------  --------  -------------------  -------------------  -------",
      ...rows.map((r) => {
        const created = new Date(r.createdAt).toISOString()
        const lastUsed = r.lastUsedAt === null ? "never" : new Date(r.lastUsedAt).toISOString()
        return `  ${r.label.padEnd(20)}  ${r.keyid.padEnd(35)}  ${r.scope.padEnd(8)}  ${created.padEnd(19)}  ${lastUsed.padEnd(19)}  ${r.status}`
      }),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

/**
 * Build a `keys revoke` / `keys delete` command: both take one keyid positional
 * (bare / jct_-prefixed / full token), run a repo op, and report the same
 * ok/error shape. `op` returns the op Result; `describeError` maps a non-
 * not-found DbError kind to a message (or null → fall through to reportDbError);
 * `pastTense` is the success verb.
 */
function keyIdCommand(opts: {
  name: string
  description: string
  pastTense: string
  op: (
    repos: NonNullable<Awaited<ReturnType<typeof openDb>>>,
    keyId: string,
  ) => ReturnType<NonNullable<Awaited<ReturnType<typeof openDb>>>["apiKeys"]["revoke"]>
  describeError?: (error: DbError, keyId: string) => string | null
}) {
  return defineCommand({
    meta: { name: opts.name, description: opts.description },
    args: {
      keyid: {
        type: "positional",
        description: "keyid (jct_<keyid>, or a bare ULID) or a full jct_<keyid>_<secret> token",
        required: true,
      },
      json: JSON_ARG,
    },
    async run({ args }) {
      const json = args.json ?? false
      const repos = await openDb(json)
      if (!repos) return

      const keyId = resolveKeyId(args.keyid)
      const result = await opts.op(repos, keyId)
      if (result.isErr()) {
        if (result.error.kind === "not-found") {
          reportError(json, `key "${keyId}" not found`)
          return
        }
        const msg = opts.describeError?.(result.error, keyId) ?? null
        if (msg !== null) reportError(json, msg)
        else reportDbError(result.error, json)
        return
      }

      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, keyid: `jct_${keyId}` })}\n`)
      } else {
        consola.success(`Key jct_${keyId} ${opts.pastTense}`)
      }
    },
  })
}

const revokeCommand = keyIdCommand({
  name: "revoke",
  description: "Revoke a junction API key (idempotent). Accepts a bare keyid or a full token.",
  pastTense: "revoked",
  op: (repos, keyId) => repos.apiKeys.revoke(keyId),
})

const deleteCommand = keyIdCommand({
  name: "delete",
  description: "Permanently delete a REVOKED junction API key (revoke it first).",
  pastTense: "deleted",
  op: (repos, keyId) => repos.apiKeys.remove(keyId),
  describeError: (error, keyId) =>
    error.kind === "in-use" ? `key "${keyId}" is active — revoke it before deleting` : null,
})

/**
 * Resolve a user-supplied keyid argument: accepts a full `jct_<keyid>_<secret>`
 * token (parses via the shared core token parser and discards the secret), a
 * `jct_<keyid>` prefixed form, or a bare keyid ULID.
 */
function resolveKeyId(input: string): string {
  const parsed = parseApiKeyToken(input)
  if (parsed.keyId !== undefined) return parsed.keyId
  if (input.startsWith("jct_")) return input.slice(4)
  return input
}

// ---------------------------------------------------------------------------
// keys command group
// ---------------------------------------------------------------------------

export const keysCommand = defineCommand({
  meta: {
    name: "keys",
    description: "Manage junction API keys (the /mcp endpoint's auth).",
  },
  subCommands: {
    create: createCommand,
    list: listCommand,
    revoke: revokeCommand,
    delete: deleteCommand,
  },
})
