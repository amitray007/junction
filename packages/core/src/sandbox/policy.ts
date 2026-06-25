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

/**
 * True if `child` is `ancestor` or lives underneath it. Both must be absolute.
 * Uses path.relative so it is segment-aware (/a/bc is NOT under /a/b).
 */
export function isPathWithin(child: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * True if any granted read/write path is an ancestor of (or equal to) a
 * credential/secret directory — which would pull secrets into the sandbox.
 * Protects BOTH backends structurally (seatbelt deny-read is defense-in-depth;
 * bwrap has no deny primitive, so this containment check is its only guard).
 */
export function grantedPathExposesSecrets(
  grantedPaths: readonly string[],
): { exposed: true; grantedPath: string; secretPath: string } | { exposed: false } {
  const secretPaths = getAlwaysDeniedPaths()
  for (const granted of grantedPaths) {
    for (const secret of secretPaths) {
      if (isPathWithin(secret, granted)) {
        return { exposed: true, grantedPath: granted, secretPath: secret }
      }
    }
  }
  return { exposed: false }
}
