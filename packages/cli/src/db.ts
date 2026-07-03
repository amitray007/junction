// SPDX-License-Identifier: AGPL-3.0-only
// CLI database access primitive — opens the DB and creates repositories.
// Named module, NOT a grab-bag (docs/principles/modularity.md §3).
// Eliminates the repeated getDatabase + createRepositories + reportDbError
// setup that every command needs.

import {
  type CredentialStore,
  createCredentialStore,
  createRepositories,
  getDatabase,
  getPaths,
  type Repositories,
} from "@junction/core"
import { reportCredentialError, reportDbError } from "./format.js"

/**
 * Open the Junction database and create the repository layer.
 *
 * On failure: writes the error in the appropriate format (--json or human),
 * sets `process.exitCode = 1`, and returns `null`.
 * The caller MUST `return` immediately when null is returned.
 *
 * @param json - Whether to emit machine-readable JSON errors.
 */
export async function openDb(json: boolean): Promise<Repositories | null> {
  const paths = getPaths()
  const result = await getDatabase(paths)
  if (result.isErr()) {
    reportDbError(result.error, json)
    return null
  }
  return createRepositories(result.value)
}

export type DbAndStore = { repos: Repositories; store: CredentialStore }

/**
 * Open the DB + the credential store together (the setup every credential-
 * touching command — add/rotate/remove/list/connect/reconnect — needs).
 *
 * On failure: reports the error (--json or human), sets `process.exitCode = 1`,
 * and returns `null`. The caller MUST `return` immediately when null.
 */
export async function openDbAndStore(json: boolean): Promise<DbAndStore | null> {
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
