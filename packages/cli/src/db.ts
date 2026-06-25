// SPDX-License-Identifier: AGPL-3.0-only
// CLI database access primitive — opens the DB and creates repositories.
// Named module, NOT a grab-bag (docs/principles/modularity.md §3).
// Eliminates the repeated getDatabase + createRepositories + reportDbError
// setup that every command needs.

import { createRepositories, getDatabase, getPaths, type Repositories } from "@junction/core"
import { reportDbError } from "./format.js"

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
