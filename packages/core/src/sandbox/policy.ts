// SPDX-License-Identifier: AGPL-3.0-only
// Shared policy helpers — imported by backends without creating a circular dep.

import os from "node:os"
import path from "node:path"
import { getPaths } from "../paths/index.js"

/** Absolute paths that are always in the deny-read list (defense-in-depth). */
export function getAlwaysDeniedPaths(): string[] {
  const paths = getPaths()
  const home = os.homedir()
  return [paths.credentialsFile, paths.masterKeyFile, path.join(home, ".junction")]
}
