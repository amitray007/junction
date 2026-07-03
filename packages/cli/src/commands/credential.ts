// SPDX-License-Identifier: AGPL-3.0-only
// `junction credential` — credential management commands: `add`, `list`.
// SECURITY: token is consumed only by addCredential → CredentialStore.set();
// it NEVER appears in output, --json responses, error causes, or DB columns.
// Edge stays thin: calls core, formats output. No business logic here.

import {
  addCredential,
  type Credential,
  type CredentialStore,
  type CredentialVerifyResult,
  compatibleCredentialKinds,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
  type Repositories,
  removeCredential,
  rotateCredential,
} from "@junction/core"
import type { VerifyOutcome } from "@junction/source-runtime"
import { verifyCredential } from "@junction/source-runtime"
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
// Lost-secret handling — shared between CLI `credential test` and web's
// testCredential (packages/web/src/server/mutations.server.ts). A STORED
// credential (one reached via a credential id, which always carries a
// secretRef) whose secret resolves to null means the secret itself vanished
// (cleared keychain entry / deleted key file) — NOT a public/no-auth source.
// verifyCredential treats a null secret as "no credential to send" (correct
// for genuinely public sources passed null deliberately), so it must never
// see this case: an anonymous-accepting upstream would then verify as "ok"
// with no credential sent at all. Always unreachable, never ok/auth-failed.
// ---------------------------------------------------------------------------

export const STORED_SECRET_MISSING_DETAIL = "stored secret missing — rotate this credential"

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
    description:
      "Add a credential for a platform (kind is derived from the platform's auth unless --kind is given).",
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
      description:
        "Credential kind (api-key, bearer, env, file). Default: derived from the platform's auth.",
    },
    "token-stdin": {
      type: "boolean",
      description: "Read the token from stdin (headless/agent mode)",
      default: false,
    },
    verify: {
      type: "boolean",
      description:
        "After storing, verify the credential against the real upstream and print the outcome (opt-in; never blocks storing)",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false

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

    const ctx = await openDbAndStore(json)
    if (!ctx) return
    const { repos, store } = ctx

    // Fetch the platform BEFORE reading the secret — addCredential validates the
    // requested (or derived) kind against its kind-compat matrix, and the derived
    // default itself comes from this same platform row.
    const platformResult = await repos.platforms.get(args.platform)
    if (platformResult.isErr()) {
      reportDbError(platformResult.error, json)
      return
    }
    const platform = platformResult.value

    // Derive the kind when --kind is omitted: the matrix's first (preferred) entry.
    // An empty matrix means the platform declares no auth — credentials make no
    // sense for it, and there's nothing honest to derive.
    let kind = args.kind
    if (kind === undefined) {
      const derived = compatibleCredentialKinds(platform)[0]
      if (derived === undefined) {
        const msg = `platform "${args.platform}" declares no auth; credentials not accepted`
        if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`)
        else consola.error(msg)
        process.exitCode = 1
        return
      }
      kind = derived
    }

    // Acquire the token — either from stdin (headless) or interactive masked prompt
    const secret = await acquireSecret({
      fromStdin: args["token-stdin"],
      promptMessage: `Secret (${kind}) for ${args.platform} (${args.account}):`,
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

    const result = await addCredential(
      {
        platformId: args.platform,
        account: args.account,
        kind: kind as Exclude<Parameters<typeof addCredential>[0]["kind"], "oauth2">,
        secret,
      },
      platform,
      store,
      repos.credentials,
    )

    if (result.isErr()) {
      // Report error — never include secret or secretRef in error output
      reportCredentialOpError(result.error, json)
      return
    }

    const credential = result.value

    // --verify is opt-in and NEVER unwinds the stored credential — a failed or
    // unreachable verify still leaves the credential stored; exit code stays 0.
    // NOTE: `secret` here came from stdin/prompt (acquireSecret), never from the
    // store — it can never be null, so the lost-secret handling in `credential
    // test` (below) does not apply on this path.
    let verifyOutcome: VerifyOutcome | undefined
    let persisted = true
    if (args.verify) {
      const paths = getPaths()
      const outcomeResult = await verifyCredential(platform, secret, paths)
      // verifyCredential's contract is ALWAYS Ok — but stay defensive rather
      // than assume, since a future change could add an Err path.
      if (outcomeResult.isOk()) {
        verifyOutcome = outcomeResult.value
        // Persist ok|auth-failed|unreachable only — never not-verifiable (it's
        // a property of the platform/source kind, not a persisted event).
        if (verifyOutcome.status !== "not-verifiable") {
          const setResult = await repos.credentials.setVerifyState(
            credential.id,
            verifyOutcome.status as CredentialVerifyResult,
            Date.now(),
          )
          if (setResult.isErr()) {
            persisted = false
            if (!json) {
              consola.warn(`warning: could not persist the verify result: ${setResult.error.kind}`)
            }
          }
        }
      }
    }

    // Output ONLY metadata — NEVER the secret, NEVER the secretRef
    writeCredentialMeta(credential, json, "added", verifyOutcome, persisted)
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

    // Map to metadata-only objects — NEVER include secret or secretRef.
    // lastVerifyResult/lastVerifiedAt are absent (never verified) or a
    // persisted event from `credential add --verify` / `credential test`.
    const creds = credResult.value as Credential[]
    const metaList = creds.map((c) => ({
      id: c.id,
      platformId: c.platformId,
      account: c.profileName,
      kind: c.kind,
      lastVerifyResult: c.lastVerifyResult ?? null,
      lastVerifiedAt:
        c.lastVerifiedAt !== undefined ? new Date(c.lastVerifiedAt).toISOString() : null,
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
      "  id                              account           kind     verified",
      "  ------------------------------  ----------------  -------  -----------------------",
      ...metaList.map((c) => {
        const verified =
          c.lastVerifyResult !== null && c.lastVerifiedAt !== null
            ? `${c.lastVerifyResult} (${c.lastVerifiedAt})`
            : "-"
        return `  ${String(c.id).padEnd(30)}  ${c.account.padEnd(16)}  ${c.kind.padEnd(7)}  ${verified}`
      }),
    ]
    process.stdout.write(`${lines.join("\n")}\n`)
  },
})

// ---------------------------------------------------------------------------
// credential test — verify an existing credential against its real upstream
// (test-connection). Never prints the secret; persists the outcome the same
// way `credential add --verify` does (ok|auth-failed|unreachable only).
// ---------------------------------------------------------------------------

const testCommand = defineCommand({
  meta: {
    name: "test",
    description:
      "Verify a stored credential against its platform's real upstream (test-connection).",
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

    const repos = await openDb(json)
    if (!repos) return

    const credResult = await repos.credentials.get(args.id)
    if (credResult.isErr()) {
      reportDbError(credResult.error, json)
      return
    }
    const credential = credResult.value

    const platformResult = await repos.platforms.get(String(credential.platformId))
    if (platformResult.isErr()) {
      reportDbError(platformResult.error, json)
      return
    }
    const platform = platformResult.value

    const storeResult = await createCredentialStore(getPaths())
    if (storeResult.isErr()) {
      reportCredentialError(storeResult.error, json)
      return
    }
    const store = storeResult.value

    // THE SECRET IS NEVER PRINTED — it flows only into verifyCredential.
    const secretResult = await store.get(credential.secretRef)
    if (secretResult.isErr()) {
      reportCredentialError(secretResult.error, json)
      return
    }
    const secret = secretResult.value

    // A stored credential (reached via id → secretRef) whose secret resolves
    // to null is a LOST secret, not a public source — never let this fall
    // into verifyCredential, which would treat null as "no credential to
    // send" and could verify "ok" anonymously against a lax upstream.
    let outcome: VerifyOutcome
    if (secret === null) {
      outcome = { status: "unreachable", detail: STORED_SECRET_MISSING_DETAIL }
    } else {
      const outcomeResult = await verifyCredential(platform, secret, getPaths())
      if (outcomeResult.isErr()) {
        // verifyCredential's contract is ALWAYS Ok; defensive fallback only.
        reportDbError({ kind: "query-failed", cause: outcomeResult.error }, json)
        return
      }
      outcome = outcomeResult.value
    }

    // Persist ok|auth-failed|unreachable only — never not-verifiable.
    let persisted = true
    if (outcome.status !== "not-verifiable") {
      const setResult = await repos.credentials.setVerifyState(
        credential.id,
        outcome.status as CredentialVerifyResult,
        Date.now(),
      )
      if (setResult.isErr()) {
        persisted = false
        if (!json) {
          consola.warn(`warning: could not persist the verify result: ${setResult.error.kind}`)
        }
      }
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          verify: verifyOutcomeJson(outcome),
          ...(persisted ? {} : { persisted: false }),
        })}\n`,
      )
    } else {
      consola.info(formatVerifyOutcome(outcome))
    }
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
    test: testCommand,
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
    e.kind === "invalid-input" ||
    e.kind === "kind-incompatible"
  ) {
    reportCredentialError(e as Parameters<typeof reportCredentialError>[0], json)
  } else {
    reportDbError(e as Parameters<typeof reportDbError>[0], json)
  }
}

/**
 * Write credential metadata to output (JSON line or consola.success).
 * NEVER includes secret or secretRef. `verifyOutcome` is included only when
 * --verify was used (add) or always for `credential test` (verifyOutcomeJson).
 * `persisted` defaults to true; pass false when setVerifyState errored so the
 * caller's warning is reflected in --json as well (default-true keeps every
 * other call site, e.g. rotate, unaffected).
 */
function writeCredentialMeta(
  cred: { id: unknown; platformId: unknown; profileName: string; kind: string },
  json: boolean,
  successVerb: string,
  verifyOutcome?: VerifyOutcome,
  persisted = true,
): void {
  const meta = {
    id: cred.id,
    platformId: cred.platformId,
    account: cred.profileName,
    kind: cred.kind,
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        credential: meta,
        ...(verifyOutcome !== undefined ? { verify: verifyOutcomeJson(verifyOutcome) } : {}),
        ...(persisted ? {} : { persisted: false }),
      })}\n`,
    )
  } else {
    consola.success(
      `Credential ${successVerb} — account: ${cred.profileName}, platform: ${String(cred.platformId)}, id: ${String(cred.id)}`,
    )
    if (verifyOutcome !== undefined) {
      consola.info(formatVerifyOutcome(verifyOutcome))
    }
  }
}

// ---------------------------------------------------------------------------
// Verify outcome formatting — exhaustive, no default (docs/rules/typescript.md).
// Human lines + a stable --json shape. NEVER includes any secret or URL — the
// outcome itself carries none (see @junction/source-runtime's verifyCredential).
// ---------------------------------------------------------------------------

/** Human-readable line for a VerifyOutcome. Exhaustive switch — no default. */
function formatVerifyOutcome(outcome: VerifyOutcome): string {
  switch (outcome.status) {
    case "ok":
      return "verify: ok — credential works"
    case "auth-failed":
      return "verify: auth failed — the source rejected this credential"
    case "unreachable":
      return `verify: unreachable — ${outcome.detail}`
    case "not-verifiable":
      return `verify: not verifiable — ${outcome.reason}`
    default: {
      const _: never = outcome
      return _
    }
  }
}

/** JSON-shaped representation of a VerifyOutcome for --json output. */
function verifyOutcomeJson(outcome: VerifyOutcome): {
  status: VerifyOutcome["status"]
  detail?: string
  reason?: string
} {
  switch (outcome.status) {
    case "ok":
    case "auth-failed":
      return { status: outcome.status }
    case "unreachable":
      return { status: outcome.status, detail: outcome.detail }
    case "not-verifiable":
      return { status: outcome.status, reason: outcome.reason }
    default: {
      const _: never = outcome
      return _
    }
  }
}

// Re-export for internal use — formatCredentialError is used in the CredentialError branch above
export { formatCredentialError }
