// SPDX-License-Identifier: AGPL-3.0-only
// createCredentialStore — selects keyring or encrypted-file backend at runtime.
// JUNCTION_STORE=file | keyring overrides auto-detection; default is keyring-if-usable.

import type { Result } from "neverthrow"
import { err, ok, ResultAsync } from "neverthrow"
import type { CredentialError } from "../errors/index.js"
import type { JunctionPaths } from "../paths/index.js"
import { createEncryptedFileStore } from "./encrypted-file-store.js"
import { createKeyringStore } from "./keyring-store.js"
import { resolveMasterKey } from "./master-key.js"
import type { CredentialStore } from "./store.js"

export type { CredentialStore }

/** Probe whether the OS keyring is accessible. Result is cached for the lifetime of the process. */
let keyringUsableCache: boolean | undefined

async function probeKeyringUsable(): Promise<boolean> {
  if (keyringUsableCache !== undefined) return keyringUsableCache
  try {
    const { Entry } = await import("@napi-rs/keyring")
    new Entry("junction", "__junction_probe__").getPassword()
    keyringUsableCache = true
  } catch {
    keyringUsableCache = false
  }
  return keyringUsableCache
}

async function buildFileStore(
  paths: JunctionPaths,
  env: NodeJS.ProcessEnv,
): Promise<Result<CredentialStore, CredentialError>> {
  const keyResult = await resolveMasterKey(paths, env)
  if (keyResult.isErr()) return err<CredentialStore, CredentialError>(keyResult.error)
  return ok<CredentialStore, CredentialError>(createEncryptedFileStore(paths, keyResult.value))
}

async function selectStore(
  paths: JunctionPaths,
  env: NodeJS.ProcessEnv,
): Promise<Result<CredentialStore, CredentialError>> {
  const storeOverride = env.JUNCTION_STORE?.trim()

  if (storeOverride === "keyring") {
    const usable = await probeKeyringUsable()
    if (!usable) {
      return err<CredentialStore, CredentialError>({
        kind: "store-unavailable",
        cause: new Error("OS keyring is not accessible (JUNCTION_STORE=keyring forced)"),
      })
    }
    return ok<CredentialStore, CredentialError>(createKeyringStore())
  }

  if (storeOverride === "file") {
    return buildFileStore(paths, env)
  }

  // Auto: prefer keyring, fall back to encrypted-file
  const usable = await probeKeyringUsable()
  if (usable) return ok<CredentialStore, CredentialError>(createKeyringStore())
  return buildFileStore(paths, env)
}

/**
 * Creates and returns the appropriate CredentialStore for this environment.
 *
 * Selection order:
 *   JUNCTION_STORE=file    → EncryptedFileStore (always; CI/Docker/tests)
 *   JUNCTION_STORE=keyring → KeyringStore (explicit; Err if probe fails)
 *   auto                   → KeyringStore if usable, else EncryptedFileStore
 */
export function createCredentialStore(
  paths: JunctionPaths,
  env: NodeJS.ProcessEnv = process.env,
): ResultAsync<CredentialStore, CredentialError> {
  return new ResultAsync(selectStore(paths, env))
}
