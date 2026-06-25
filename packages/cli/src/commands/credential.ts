// SPDX-License-Identifier: AGPL-3.0-only
// `junction credential` — credential management commands: `add`, `list`.
// SECURITY: token is consumed only by addCredential → CredentialStore.set();
// it NEVER appears in output, --json responses, error causes, or DB columns.
// Edge stays thin: calls core, formats output. No business logic here.

import {
  addCredential,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import { formatCredentialError, reportCredentialError, reportDbError } from "../format.js"

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add a bearer credential for a platform.",
  },
  args: {
    platform: {
      type: "string",
      description: "Platform ID",
      required: true,
    },
    account: {
      type: "string",
      description: "Logical account label (e.g. work, personal)",
      required: true,
    },
    kind: {
      type: "string",
      description: "Credential kind (default: bearer)",
      default: "bearer",
    },
    "token-stdin": {
      type: "boolean",
      description: "Read the token from stdin (headless/agent mode)",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false

    if (args.kind !== "bearer") {
      const msg = `unsupported credential kind "${args.kind}": only "bearer" is supported in this release`
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }

    // Validate platform and account BEFORE reading the token — bad input must
    // not cause a secret to be captured from stdin (nice-to-have 2 + FIX 2).
    if (!args.platform || args.platform.trim() === "") {
      const msg = "invalid input: --platform must not be empty"
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }
    if (!args.account || args.account.trim() === "") {
      const msg = "invalid input: --account must not be empty"
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }

    // Acquire the token — either from stdin (headless) or interactive masked prompt
    let secret: string
    if (args["token-stdin"]) {
      // Headless / agent mode: read from stdin, trim surrounding whitespace
      secret = await readTokenFromStdin()
    } else {
      // Interactive mode: masked @clack/prompts password prompt — token never echoed
      const { password, isCancel } = await import("@clack/prompts")
      const result = await password({
        message: `Bearer token for ${args.platform} (${args.account}):`,
      })
      if (isCancel(result) || typeof result !== "string") {
        if (!json) consola.warn("Aborted.")
        return
      }
      secret = result
    }

    if (!secret) {
      const msg = "token must not be empty"
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }

    const paths = getPaths()
    const [dbResult, storeResult] = await Promise.all([
      getDatabase(paths),
      createCredentialStore(paths),
    ])
    if (dbResult.isErr()) {
      reportDbError(dbResult.error, json)
      return
    }
    if (storeResult.isErr()) {
      reportCredentialError(storeResult.error, json)
      return
    }

    const repos = createRepositories(dbResult.value)
    const store = storeResult.value

    const result = await addCredential(
      { platformId: args.platform, account: args.account, kind: "bearer", secret },
      store,
      repos.credentials,
    )

    // Overwrite the local variable immediately after use — plaintext is no longer needed
    secret = ""

    if (result.isErr()) {
      const e = result.error
      // Report error — never include secret or secretRef in error output
      if (
        e.kind === "store-unavailable" ||
        e.kind === "decrypt-failed" ||
        e.kind === "key-unavailable" ||
        e.kind === "io-failed" ||
        e.kind === "invalid-input"
      ) {
        reportCredentialError(e, json)
      } else {
        reportDbError(e, json)
      }
      return
    }

    const cred = result.value
    // Output ONLY metadata — NEVER the secret, NEVER the secretRef
    const meta = {
      id: cred.id,
      platformId: cred.platformId,
      account: cred.profileName,
      kind: cred.kind,
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, credential: meta })}\n`)
    } else {
      consola.success(
        `Credential added — account: ${cred.profileName}, platform: ${String(cred.platformId)}, id: ${String(cred.id)}`,
      )
    }
  },
})

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List credentials for a platform (metadata only — never the secret).",
  },
  args: {
    platform: {
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

    // Validate the platform exists first
    const platformResult = await repos.platforms.get(args.platform)
    if (platformResult.isErr()) {
      reportDbError(platformResult.error, json)
      return
    }

    const credResult = await repos.credentials.forPlatform(
      args.platform as Parameters<typeof repos.credentials.forPlatform>[0],
    )
    if (credResult.isErr()) {
      reportDbError(credResult.error, json)
      return
    }

    // Map to metadata-only objects — NEVER include secret or secretRef
    const metaList = credResult.value.map((c) => ({
      id: c.id,
      platformId: c.platformId,
      account: c.profileName,
      kind: c.kind,
    }))

    if (json) {
      process.stdout.write(`${JSON.stringify(metaList)}\n`)
      return
    }

    if (metaList.length === 0) {
      process.stdout.write(
        `No credentials for platform "${args.platform}". Use "junction credential add" to add one.\n`,
      )
      return
    }

    const lines = [
      "  id                              account           kind",
      "  ------------------------------  ----------------  -------",
      ...metaList.map((c) => `  ${String(c.id).padEnd(30)}  ${c.account.padEnd(16)}  ${c.kind}`),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

export const credentialCommand = defineCommand({
  meta: {
    name: "credential",
    description: "Manage platform credentials.",
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
  },
})

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read a single token from stdin (strips surrounding whitespace). */
async function readTokenFromStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk: string) => {
      data += chunk
    })
    process.stdin.on("end", () => {
      resolve(data.trim())
    })
    // Resume in case stdin is paused (e.g. if it was already consumed)
    process.stdin.resume()
  })
}

// Re-export for internal use — formatCredentialError is used in the CredentialError branch above
export { formatCredentialError }
