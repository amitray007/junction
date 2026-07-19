// SPDX-License-Identifier: AGPL-3.0-only
// `junction oauth-design` — custom OAuth-design authoring: `list`, `add`, `rm`
// (increment 45, Slice D3). Edge stays thin: argv → core's design-ops, format
// output. No business logic here — validation/collision/reference-checking
// all live in @junction/core's design-ops.ts.
// SECURITY: a design carries no client secret (those are per-credential); the
// tokenUrl is shown in full on add/list — it's the refresh-token POST target,
// never something to hide.

import {
  addCustomDesign,
  type DesignOpError,
  deleteCustomDesign,
  getPaths,
  type ListedDesign,
  listAllDesigns,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { reportError } from "../format.js"

/**
 * Report a DesignOpError uniformly for both `add` and `rm` — the two ops
 * share the `store-error`/default arms verbatim (both just surface the
 * underlying store failure kind), and only diverge on the create-only vs
 * delete-only cases (builtin-collision/already-exists vs not-custom/not-found/
 * referenced). Handling ALL cases here (rather than splitting into two
 * partial switches) keeps this exhaustive against the one shared error type.
 */
function reportDesignOpError(e: DesignOpError, json: boolean): void {
  switch (e.kind) {
    case "invalid-design":
      reportError(
        json,
        `invalid design: ${e.cause instanceof Error ? e.cause.message : JSON.stringify(e.cause)}`,
      )
      return
    case "builtin-collision":
      reportError(json, `"${e.id}" is a built-in Junction design id — choose a different slug`)
      return
    case "already-exists":
      reportError(json, `a custom design with id "${e.id}" already exists`)
      return
    case "not-custom":
      reportError(json, `"${e.id}" is a built-in design — only custom designs can be deleted`)
      return
    case "not-found":
      reportError(json, `no custom design with id "${e.id}" exists`)
      return
    case "referenced": {
      const parts: string[] = []
      if (e.platformIds.length > 0) parts.push(`platform(s): ${e.platformIds.join(", ")}`)
      if (e.credentialIds.length > 0) parts.push(`credential(s): ${e.credentialIds.join(", ")}`)
      reportError(json, `"${e.id}" is still referenced by ${parts.join("; ")} — unlink those first`)
      return
    }
    case "store-error":
      reportError(json, `custom designs store: ${e.cause.kind}`)
      return
    default: {
      const _: never = e
      reportError(json, `operation failed: ${JSON.stringify(_)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all OAuth designs — built-in catalog entries plus your custom designs.",
  },
  args: { json: JSON_ARG },
  async run({ args }) {
    const json = args.json ?? false
    const result = await listAllDesigns(getPaths())
    if (result.isErr()) {
      reportError(json, `custom designs store: ${result.error.kind}`)
      return
    }
    const designs = result.value

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, designs })}\n`)
      return
    }

    if (designs.length === 0) {
      process.stdout.write("No OAuth designs.\n")
      return
    }

    const lines = [
      "  id                          custom  pkce      refresh  display name",
      "  --------------------------  ------  --------  -------  --------------------------------",
      ...designs.map((d: ListedDesign) => {
        return `  ${d.id.padEnd(26)}  ${(d.isCustom ? "yes" : "no").padEnd(6)}  ${d.pkce.padEnd(8)}  ${(d.supportsRefresh ? "yes" : "no").padEnd(7)}  ${d.displayName}`
      }),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Create a custom OAuth design (id becomes custom:<slug>).",
  },
  args: {
    slug: {
      type: "string",
      description: "The design's slug — resolves to custom:<slug> (lowercase, digits, hyphens).",
      required: true,
    },
    "display-name": {
      type: "string",
      description: "Human-readable name shown in the designs list.",
      required: true,
    },
    "authorization-url": {
      type: "string",
      description: "The provider's authorization endpoint.",
      required: true,
    },
    "token-url": {
      type: "string",
      description: "The provider's token endpoint — where refresh tokens are POSTed.",
      required: true,
    },
    "userinfo-url": {
      type: "string",
      description: "Optional identity/introspection endpoint (used by Test Connection).",
    },
    scopes: {
      type: "string",
      description: "Space-separated default scopes.",
    },
    "docs-url": {
      type: "string",
      description: "Optional registration docs URL.",
    },
    pkce: {
      type: "string",
      description: "PKCE method: S256 (default), plain, or disabled.",
      default: "S256",
    },
    "no-refresh": {
      type: "boolean",
      description: "Mark this design as NOT supporting refresh tokens (default: supports refresh).",
      default: false,
    },
    "confirm-token-url": {
      type: "boolean",
      description:
        "Required acknowledgement that --token-url is the correct, verified token endpoint (the refresh-token exfil surface).",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false

    // The tokenUrl is where refresh tokens get POSTed — the web form makes
    // the user tick a literal confirmation checkbox before Create; the CLI's
    // equivalent is requiring this flag explicitly rather than silently
    // trusting whatever URL was typed (mirrors the method file's D2 "user
    // confirms the tokenUrl before save" requirement in a scriptable form).
    if (!args["confirm-token-url"]) {
      reportError(
        json,
        "refusing to create a design without --confirm-token-url — this acknowledges --token-url is the correct, verified token endpoint (it's where refresh tokens are sent)",
      )
      return
    }

    const pkce = args.pkce
    if (pkce !== "S256" && pkce !== "plain" && pkce !== "disabled") {
      reportError(json, `invalid --pkce "${pkce}": must be S256, plain, or disabled`)
      return
    }

    const design = {
      id: `custom:${args.slug}`,
      displayName: args["display-name"],
      authorizationUrl: args["authorization-url"],
      tokenUrl: args["token-url"],
      userinfoUrl: args["userinfo-url"],
      scopeSeparator: " " as const,
      pkce,
      supportsRefresh: !args["no-refresh"],
      expiryStrategy: "expires_in" as const,
      redirectMode: "loopback-fixed" as const,
      defaultScopes: args.scopes ? args.scopes.trim().split(/\s+/) : undefined,
      registrationHint: { redirectUri: "", scopes: "", docsUrl: args["docs-url"] ?? "" },
    }

    const result = await addCustomDesign(getPaths(), design)
    if (result.isErr()) {
      reportDesignOpError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, design: result.value })}\n`)
    } else {
      consola.success(
        `Custom OAuth design "${result.value.displayName}" (${result.value.id}) created`,
      )
    }
  },
})

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

const rmCommand = defineCommand({
  meta: {
    name: "rm",
    description: "Delete a custom OAuth design (refuses if built-in or still referenced).",
  },
  args: {
    id: {
      type: "positional",
      description: "The design id, e.g. custom:acme-oauth",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const repos = await openDb(json)
    if (!repos) return

    const result = await deleteCustomDesign(getPaths(), repos, args.id)
    if (result.isErr()) {
      reportDesignOpError(result.error, json)
      return
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, id: args.id })}\n`)
    } else {
      consola.success(`Custom OAuth design "${args.id}" removed`)
    }
  },
})

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export const oauthDesignCommand = defineCommand({
  meta: {
    name: "oauth-design",
    description: "Manage custom OAuth designs (built-ins are read-only).",
  },
  subCommands: {
    list: listCommand,
    add: addCommand,
    rm: rmCommand,
  },
})
