// SPDX-License-Identifier: AGPL-3.0-only
// `junction credential` — credential management commands: `add`, `list`.
// SECURITY: token is consumed only by addCredential → CredentialStore.set();
// it NEVER appears in output, --json responses, error causes, or DB columns.
// Edge stays thin: calls core, formats output. No business logic here.

import {
  addCredential,
  type Credential,
  type CredentialStore,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
  type Repositories,
  removeCredential,
  rotateCredential,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG } from "../args.js"
import { openDb } from "../db.js"
import {
  formatCredentialError,
  reportCredentialError,
  reportDbError,
  reportIdRemoved,
  reportInUseError,
} from "../format.js"

// ---------------------------------------------------------------------------
// Shared DB + store setup (used by both add and remove, which both need the store)
// ---------------------------------------------------------------------------

type DbAndStore = { repos: Repositories; store: CredentialStore }

/**
 * Open the DB and the credential store in parallel.
 * On any failure: writes the error in the appropriate format and returns null.
 * The caller MUST `return` immediately when null is returned.
 */
async function openDbAndStore(json: boolean): Promise<DbAndStore | null> {
  const paths = getPaths()
  const [dbResult, storeResult] = await Promise.all([
    getDatabase(paths),
    createCredentialStore(paths),
  ])
  if (dbResult.isErr()) {
    reportDbError(dbResult.error, json)
    return null
  }
  if (storeResult.isErr()) {
    reportCredentialError(storeResult.error, json)
    return null
  }
  return { repos: createRepositories(dbResult.value), store: storeResult.value }
}

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
    const secret = await acquireSecret({
      fromStdin: args["token-stdin"],
      promptMessage: `Bearer token for ${args.platform} (${args.account}):`,
      json,
    })
    if (secret === null) return

    if (!secret) {
      const msg = "token must not be empty"
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }

    const ctx = await openDbAndStore(json)
    if (!ctx) return
    const { repos, store } = ctx

    const result = await addCredential(
      { platformId: args.platform, account: args.account, kind: "bearer", secret },
      store,
      repos.credentials,
    )

    if (result.isErr()) {
      // Report error — never include secret or secretRef in error output
      reportCredentialOpError(result.error, json)
      return
    }

    // Output ONLY metadata — NEVER the secret, NEVER the secretRef
    writeCredentialMeta(result.value, json, "added")
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
      description: "Platform to list credentials for",
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
    const creds = credResult.value as Credential[]
    const metaList = creds.map((c) => ({
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

// ---------------------------------------------------------------------------
// credential remove — delete credential + secret (enforces RESTRICT FK)
// ---------------------------------------------------------------------------

const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a credential and delete its stored secret.",
  },
  args: {
    id: {
      type: "string",
      description: "Credential ID",
      required: true,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const ctx = await openDbAndStore(json)
    if (!ctx) return
    const { repos, store } = ctx

    const result = await removeCredential(args.id, store, repos.credentials)

    if (result.isErr()) {
      const e = result.error
      if (e.kind === "in-use") {
        // Give the user a clear, actionable message — no raw SQL error
        reportInUseError(
          json,
          `credential "${args.id}" is in use by one or more sources; remove those sources first`,
        )
        return
      }
      reportDbError(e, json)
      return
    }

    reportIdRemoved(json, args.id, "Credential")
  },
})

// ---------------------------------------------------------------------------
// credential rotate — swap the secret in place (atomic/fail-safe via core)
// ---------------------------------------------------------------------------

const rotateCommand = defineCommand({
  meta: {
    name: "rotate",
    description: "Rotate (replace) the secret for an existing credential.",
  },
  args: {
    id: {
      type: "string",
      description: "Credential ID to rotate",
      required: true,
    },
    "secret-stdin": {
      type: "boolean",
      description: "Read the new secret from stdin (headless/agent mode)",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false

    // Validate id BEFORE reading the secret — bad input must not cause a secret
    // to be captured from stdin (mirrors addCommand's discipline).
    if (!args.id || args.id.trim() === "") {
      const msg = "invalid input: --id must not be empty"
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }

    // Acquire the new secret — either from stdin (headless) or interactive masked prompt.
    const secret = await acquireSecret({
      fromStdin: args["secret-stdin"],
      promptMessage: `New secret for credential ${args.id}:`,
      json,
    })
    if (secret === null) return

    if (!secret) {
      const msg = "new secret must not be empty"
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
      else consola.error(msg)
      process.exitCode = 1
      return
    }

    const ctx = await openDbAndStore(json)
    if (!ctx) return
    const { repos, store } = ctx

    const result = await rotateCredential(
      { credentialId: args.id, newSecret: secret },
      store,
      repos.credentials,
    )

    if (result.isErr()) {
      // Report error — never include secret or secretRef in error output.
      reportCredentialOpError(result.error, json)
      return
    }

    // Output ONLY metadata — NEVER the secret, NEVER the secretRef.
    writeCredentialMeta(result.value, json, "rotated")
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
    remove: removeCommand,
    rotate: rotateCommand,
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

/**
 * Acquire the secret — either from stdin (headless) or an interactive masked prompt.
 * Returns the trimmed secret string, or `null` if the user cancelled (caller must return).
 */
async function acquireSecret(opts: {
  fromStdin: boolean
  promptMessage: string
  json: boolean
}): Promise<string | null> {
  if (opts.fromStdin) {
    return readTokenFromStdin()
  }
  const { password, isCancel } = await import("@clack/prompts")
  const result = await password({ message: opts.promptMessage })
  if (isCancel(result) || typeof result !== "string") {
    if (!opts.json) consola.warn("Aborted.")
    return null
  }
  return result
}

/**
 * Dispatch a CredentialError or DbError to the appropriate reporter.
 * All error kinds from add/rotate that are not DB-layer go to reportCredentialError.
 */
function reportCredentialOpError(
  e: Parameters<typeof reportCredentialError>[0] | Parameters<typeof reportDbError>[0],
  json: boolean,
): void {
  if (
    e.kind === "store-unavailable" ||
    e.kind === "decrypt-failed" ||
    e.kind === "key-unavailable" ||
    e.kind === "io-failed" ||
    e.kind === "invalid-input"
  ) {
    reportCredentialError(e as Parameters<typeof reportCredentialError>[0], json)
  } else {
    reportDbError(e as Parameters<typeof reportDbError>[0], json)
  }
}

/**
 * Write credential metadata to output (JSON line or consola.success).
 * NEVER includes secret or secretRef.
 */
function writeCredentialMeta(
  cred: { id: unknown; platformId: unknown; profileName: string; kind: string },
  json: boolean,
  successVerb: string,
): void {
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
      `Credential ${successVerb} — account: ${cred.profileName}, platform: ${String(cred.platformId)}, id: ${String(cred.id)}`,
    )
  }
}

// Re-export for internal use — formatCredentialError is used in the CredentialError branch above
export { formatCredentialError }
