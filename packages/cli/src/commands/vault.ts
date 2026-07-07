// SPDX-License-Identifier: AGPL-3.0-only
// `junction vault` — vault-level operations (master-key rotation; export/import land in 32.4).
// SECURITY: the ONLY key this command ever prints is the deliberate env-raw
// --print-new-key path's newKeyForOperator. No secretRef/plaintext/key anywhere else.

import {
  createCredentialStore,
  getPaths,
  recoverInterruptedRekey,
  rotateMasterKey,
} from "@junction/core"
import { defineCommand } from "citty"
import { consola } from "consola"
import { JSON_ARG, readStdin } from "../args.js"
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

export const vaultCommand = defineCommand({
  meta: {
    name: "vault",
    description: "Vault-level operations on the encrypted-file credential store.",
  },
  subCommands: {
    "rotate-key": rotateKeyCommand,
  },
})

// Re-export for internal use/tests
export { formatCredentialError }
