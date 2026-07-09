// SPDX-License-Identifier: AGPL-3.0-only
// `junction vault` — vault-level operations: master-key rotation (32.3) + backup/
// recovery export/import (32.4). SECURITY: the ONLY key this command ever prints is
// the deliberate env-raw --print-new-key path's newKeyForOperator. Export/import
// never print a secret/token/secretRef — only the passphrase, read from stdin/prompt,
// never argv. The `.jvlt` archive is a BEARER SECRET (both subcommands warn).

import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  createCredentialStore,
  exportVault,
  getPaths,
  importVault,
  type OnCollision,
  recoverInterruptedRekey,
  rotateMasterKey,
  writeFile0600,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG, readStdin } from "../args.js"
import { openDbAndStore } from "../db.js"
import { formatCredentialError, reportCredentialError, reportError } from "../format.js"

const rotateKeyCommand = defineCommand({
  meta: {
    name: "rotate-key",
    description:
      "Rotate the master key protecting the encrypted-file credential vault (no-op / refused on the keyring backend).",
  },
  args: {
    "print-new-key": {
      type: "boolean",
      description:
        "env-raw tier ONLY: print the new key once so you can set it as JUNCTION_MASTER_KEY. Requires --i-understand.",
      default: false,
    },
    "i-understand": {
      type: "boolean",
      description:
        "Required alongside --print-new-key: acknowledges the running env still holds the OLD key until you update it.",
      default: false,
    },
    "new-passphrase-stdin": {
      type: "boolean",
      description: "env-passphrase tier ONLY: read the new passphrase from stdin (never argv).",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const paths = getPaths()

    // Defensive: heal any prior interrupted rotation before starting a new one
    // (never two sidecars — CRITICAL/HIGH-2). Boot recovery already covers the
    // general case; this call makes `vault rotate-key` self-healing too.
    const healResult = await recoverInterruptedRekey(paths, process.env)
    if (healResult.isErr()) {
      reportCredentialError(healResult.error, json)
      return
    }

    const storeResult = await createCredentialStore(paths)
    if (storeResult.isErr()) {
      reportCredentialError(storeResult.error, json)
      return
    }
    const store = storeResult.value

    if (store.backend === "keyring") {
      reportCredentialError(
        {
          kind: "rotate-refused",
          reason:
            "the active credential store is the OS keyring — there is no file-vault master key to rotate. " +
            "If you also have a file vault, retry with JUNCTION_STORE=file junction vault rotate-key.",
        },
        json,
      )
      return
    }

    const printNewKey = args["print-new-key"] ?? false
    const iUnderstand = args["i-understand"] ?? false

    let newPassphrase: string | undefined
    if (args["new-passphrase-stdin"]) {
      newPassphrase = await readStdin()
      if (!newPassphrase) {
        reportError(json, "new passphrase (via stdin) must not be empty")
        return
      }
    }

    const result = await rotateMasterKey(paths, process.env, {
      printNewKey,
      iUnderstand,
      newPassphrase,
    })

    if (result.isErr()) {
      reportCredentialError(result.error, json)
      return
    }

    const value = result.value

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          tier: value.tier,
          rotated: value.rotated,
          ...(value.backupFile !== undefined ? { backupFile: value.backupFile } : {}),
          ...(value.newKeyForOperator !== undefined ? { newKey: value.newKeyForOperator } : {}),
          ...(value.pendingEnvUpdate !== undefined
            ? { pendingEnvUpdate: value.pendingEnvUpdate }
            : {}),
        })}\n`,
      )
    } else {
      consola.success(
        `Rotated master key (tier: ${value.tier}).` +
          (value.backupFile !== undefined
            ? ` Vault re-encrypted. Pre-rotation snapshot kept at ${value.backupFile} (delete once you've confirmed access).`
            : " No file vault existed yet — the key is installed for future use."),
      )
      if (value.pendingEnvUpdate === true) {
        consola.warn(
          "⚠ action required: the running environment still holds the OLD master key/passphrase. " +
            "Update JUNCTION_MASTER_KEY before the next boot — until you do, the vault only opens under the " +
            "printed/derived NEW value shown below, and the pre-rekey snapshot still opens under the OLD one.",
        )
      }
      if (value.newKeyForOperator !== undefined) {
        process.stderr.write(
          "warning: the new key is being written to STDOUT below — capture it to a secure location now; " +
            "do not leave it in shell scrollback/history.\n",
        )
        consola.box(
          `NEW MASTER KEY (base64) — set this as JUNCTION_MASTER_KEY:\n\n${value.newKeyForOperator}`,
        )
      }
    }
  },
})

// ---------------------------------------------------------------------------
// export / import (increment 32.4 — vault backup/recovery)
// ---------------------------------------------------------------------------

/**
 * Acquire the export/import passphrase, honoring the headless no-hang contract
 * (method file §4, I3): if stdout is non-TTY OR --json is set, and
 * --passphrase-stdin is ABSENT, fail fast with a clean error rather than drop
 * into an interactive @clack prompt that would hang an agent. With
 * --passphrase-stdin, an empty/EOF stdin (`< /dev/null`) → the same clean
 * refusal, never a hang.
 *
 * Returns `{ ok: true, passphrase }` or `{ ok: false }` (caller must report +
 * return; the error is already reported here so every call site stays a
 * one-liner).
 */
async function acquirePassphrase(opts: {
  fromStdin: boolean
  confirm: boolean
  json: boolean
  errorKind: "export-failed" | "import-failed"
}): Promise<{ ok: true; passphrase: string } | { ok: false }> {
  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true

  if (opts.fromStdin) {
    const passphrase = await readStdin()
    if (passphrase.length === 0) {
      reportCredentialError(
        { kind: opts.errorKind, reason: "passphrase (via stdin) must not be empty" },
        opts.json,
      )
      return { ok: false }
    }
    return { ok: true, passphrase }
  }

  if (!isTTY || opts.json) {
    reportCredentialError(
      {
        kind: opts.errorKind,
        reason: "passphrase required; pass --passphrase-stdin in non-interactive mode",
      },
      opts.json,
    )
    return { ok: false }
  }

  const { password, isCancel } = await import("@clack/prompts")
  const first = await password({ message: "Vault passphrase:" })
  if (isCancel(first) || typeof first !== "string" || first.length === 0) {
    reportCredentialError(
      { kind: opts.errorKind, reason: "passphrase must not be empty" },
      opts.json,
    )
    return { ok: false }
  }
  if (!opts.confirm) {
    return { ok: true, passphrase: first }
  }
  const second = await password({ message: "Confirm vault passphrase:" })
  if (isCancel(second) || typeof second !== "string") {
    reportCredentialError({ kind: opts.errorKind, reason: "aborted" }, opts.json)
    return { ok: false }
  }
  if (first !== second) {
    reportCredentialError({ kind: opts.errorKind, reason: "passphrases did not match" }, opts.json)
    return { ok: false }
  }
  return { ok: true, passphrase: first }
}

const exportCommand = defineCommand({
  meta: {
    name: "export",
    description: "Export credentials + platforms to a portable, passphrase-wrapped .jvlt archive.",
  },
  args: {
    out: {
      type: "string",
      description: "Output path for the .jvlt archive.",
      required: true,
    },
    "passphrase-stdin": {
      type: "boolean",
      description: "Read the export passphrase from stdin (never argv).",
      default: false,
    },
    "include-profiles": {
      type: "boolean",
      description: "Also export profiles (routes remapped on import).",
      default: false,
    },
    "skip-missing": {
      type: "boolean",
      description: "Skip (instead of failing) a credential whose secret is missing from the store.",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false
    const paths = getPaths()

    // C4 — refuse writing the archive inside ~/.junction: it is a bearer secret
    // and the home directory is exposed to sandboxed sources (sandbox/policy.ts
    // only whitelists credentials/master-key files, not arbitrary home files).
    const resolvedOut = path.resolve(args.out)
    const resolvedHome = path.resolve(paths.home)
    if (resolvedOut === resolvedHome || resolvedOut.startsWith(`${resolvedHome}${path.sep}`)) {
      reportCredentialError(
        {
          kind: "export-failed",
          reason:
            "write the archive outside ~/.junction; it is a bearer secret and the home directory is exposed to sandboxed sources",
        },
        json,
      )
      return
    }

    const dbAndStore = await openDbAndStore(json)
    if (dbAndStore === null) return
    const { repos, store } = dbAndStore

    const passphraseResult = await acquirePassphrase({
      fromStdin: args["passphrase-stdin"] ?? false,
      confirm: true,
      json,
      errorKind: "export-failed",
    })
    if (!passphraseResult.ok) return

    const result = await exportVault({
      repos,
      store,
      passphrase: passphraseResult.passphrase,
      includeProfiles: args["include-profiles"] ?? false,
      skipMissing: args["skip-missing"] ?? false,
    })

    if (result.isErr()) {
      reportCredentialError(result.error, json)
      return
    }

    const value = result.value
    const writeResult = await writeFile0600(resolvedOut, value.archive).then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    )
    if (!writeResult.ok) {
      reportCredentialError(
        { kind: "export-failed", reason: `failed to write archive: ${String(writeResult.cause)}` },
        json,
      )
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          out: resolvedOut,
          credentials: value.credentialsExported,
          platforms: value.platformsExported,
          ...(value.profilesExported !== undefined ? { profiles: value.profilesExported } : {}),
          ...(value.skipped.length > 0 ? { skipped: value.skipped } : {}),
        })}\n`,
      )
    } else {
      consola.success(
        `Exported ${value.credentialsExported} credential${value.credentialsExported !== 1 ? "s" : ""} + ` +
          `${value.platformsExported} platform${value.platformsExported !== 1 ? "s" : ""} to ${resolvedOut}.`,
      )
      if (value.skipped.length > 0) {
        consola.warn(`Skipped ${value.skipped.length} credential(s) (see --json for detail).`)
      }
      consola.warn(
        "⚠ This archive is a BEARER SECRET — anyone with the file + passphrase can use these credentials. Store it securely.",
      )
    }
  },
})

const importCommand = defineCommand({
  meta: {
    name: "import",
    description: "Import credentials + platforms from a .jvlt archive.",
  },
  args: {
    archive: {
      type: "positional",
      description: "Path to the .jvlt archive.",
      required: true,
    },
    "passphrase-stdin": {
      type: "boolean",
      description: "Read the archive passphrase from stdin (never argv).",
      default: false,
    },
    "on-collision": {
      type: "string",
      description: "How to handle an existing platform/credential/profile: skip|overwrite|error.",
      default: "skip",
    },
    "include-profiles": {
      type: "boolean",
      description: "Also import profiles (routes remapped through the archive's credential ids).",
      default: false,
    },
    strict: {
      type: "boolean",
      description:
        "All-or-nothing import: full pre-validation, then compensate (undo) everything " +
        "this import wrote on any failure. Not compatible with --on-collision overwrite.",
      default: false,
    },
    json: JSON_ARG,
  },
  async run({ args }) {
    const json = args.json ?? false

    const onCollisionRaw = args["on-collision"] ?? "skip"
    if (onCollisionRaw !== "skip" && onCollisionRaw !== "overwrite" && onCollisionRaw !== "error") {
      reportError(
        json,
        `--on-collision must be one of: skip, overwrite, error (got "${onCollisionRaw}")`,
      )
      return
    }
    const onCollision: OnCollision = onCollisionRaw
    const strict = args.strict ?? false

    let archiveBytes: Buffer
    try {
      archiveBytes = await readFile(args.archive)
    } catch (cause) {
      reportCredentialError(
        { kind: "import-failed", reason: `failed to read archive: ${String(cause)}` },
        json,
      )
      return
    }

    const dbAndStore = await openDbAndStore(json)
    if (dbAndStore === null) return
    const { repos, store } = dbAndStore

    const passphraseResult = await acquirePassphrase({
      fromStdin: args["passphrase-stdin"] ?? false,
      confirm: false,
      json,
      errorKind: "import-failed",
    })
    if (!passphraseResult.ok) return

    const result = await importVault({
      repos,
      store,
      archive: archiveBytes,
      passphrase: passphraseResult.passphrase,
      onCollision,
      includeProfiles: args["include-profiles"] ?? false,
      strict,
    })

    if (result.isErr()) {
      reportCredentialError(result.error, json)
      return
    }

    const summary = result.value
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, summary, ...(strict ? { strict: true } : {}) })}\n`,
      )
    } else {
      consola.success(
        `Imported ${summary.credentials.added} credential(s), ` +
          `${summary.credentials.overwritten} overwritten, ${summary.credentials.skipped} skipped ` +
          `(${summary.credentials.failed.length} failed); ` +
          `${summary.platforms.added} platform(s) added, ${summary.platforms.skipped} skipped.`,
      )
      if (summary.profiles !== undefined) {
        consola.info(
          `Profiles: ${summary.profiles.added} added, ${summary.profiles.skipped} skipped, ${summary.profiles.failed.length} failed.`,
        )
      }
      if (summary.credentials.failed.length > 0) {
        for (const f of summary.credentials.failed) {
          consola.warn(`  ${f.platformId}/${f.account}: ${f.reason}`)
        }
      }
    }
  },
})

export const vaultCommand = defineCommand({
  meta: {
    name: "vault",
    description: "Vault-level operations on the encrypted-file credential store.",
  },
  subCommands: {
    "rotate-key": rotateKeyCommand,
    export: exportCommand,
    import: importCommand,
  },
})

// Re-export for internal use/tests
export { formatCredentialError }
