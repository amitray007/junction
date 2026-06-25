// SPDX-License-Identifier: AGPL-3.0-only
// Shared policy helpers -- imported by backends without creating a circular dep.

import { realpath } from "node:fs/promises"
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
 * Returns true if a path contains characters that are dangerous when interpolated
 * into SBPL profiles (Seatbelt), Deno --allow-read/write argv (comma scope-widening),
 * or bwrap argv.
 *
 * Rejected: double-quote, backslash, open/close paren, comma, NUL (0), newline (10),
 * carriage-return (13).  A real filesystem path needing these is vanishingly rare;
 * we reject fail-closed.
 */
export function hasUnsafePathChars(p: string): boolean {
  // Printable unsafe chars -- safe to put in a regex literal.
  if (/["\\(),]/.test(p)) return true
  // Control characters: NUL=0, LF=10, CR=13 -- checked via charCodeAt to avoid
  // putting literal control chars in source (Biome noControlCharactersInRegex).
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i)
    if (c === 0 || c === 10 || c === 13) return true
  }
  return false
}

/**
 * Realpath-resolve a path, falling back to (realpath(parent) + basename) when
 * the path itself does not exist yet, then to the literal. This is the robust
 * resolver used for the exposure check -- mirrors the read-deny logic in seatbelt.
 */
async function resolveRobust(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    try {
      const real = await realpath(path.dirname(p))
      return path.join(real, path.basename(p))
    } catch {
      return p
    }
  }
}

/**
 * True if any granted read/write path is an ancestor of (or equal to) a
 * credential/secret directory -- which would pull secrets into the sandbox.
 * Protects BOTH backends structurally (seatbelt deny-read is defense-in-depth;
 * bwrap has no deny primitive, so this containment check is its only guard).
 *
 * Both sides are realpath-resolved before comparison so a symlinked writePath
 * whose realpath falls inside the secret tree is correctly flagged.
 */
export async function grantedPathExposesSecrets(
  grantedPaths: readonly string[],
): Promise<{ exposed: true; grantedPath: string; secretPath: string } | { exposed: false }> {
  const secretPaths = getAlwaysDeniedPaths()
  const [resolvedGranted, resolvedSecrets] = await Promise.all([
    Promise.all(grantedPaths.map(resolveRobust)),
    Promise.all(secretPaths.map(resolveRobust)),
  ])

  for (let gi = 0; gi < grantedPaths.length; gi++) {
    for (let si = 0; si < secretPaths.length; si++) {
      const rg = resolvedGranted[gi] ?? grantedPaths[gi] ?? ""
      const rs = resolvedSecrets[si] ?? secretPaths[si] ?? ""
      if (isPathWithin(rs, rg)) {
        return {
          exposed: true,
          grantedPath: grantedPaths[gi] ?? rg,
          secretPath: secretPaths[si] ?? rs,
        }
      }
    }
  }
  return { exposed: false }
}
