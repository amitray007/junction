// SPDX-License-Identifier: AGPL-3.0-only
// Stale cred-* temp dir reaper (increment 32.7 item 2).
//
// A hard kill between the kind "file" credential materialization's writeFile
// (provider.ts prepareCredential) and its `finally` rm cleanup strands a
// `<home>/run/cred-XXXXXX` dir (0700, holding a 0600 secret file). No lock
// marks a live dir, so a sweep MUST be age-thresholded rather than presence-
// thresholded — a fresh dir belonging to an in-flight call must never be
// touched.
//
// Best-effort by design: every per-entry fs error is swallowed (a stat/rm
// race, permissions oddity, etc. must never break the startup path this
// sweep is called from).

import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { getLogger } from "../logging/index.js"
import type { JunctionPaths } from "./index.js"

const DEFAULT_OLDER_THAN_MS = 60 * 60 * 1000 // 1 hour — far above any sandbox timeoutMs

/**
 * Remove `<paths.runtimeDir>/cred-*` DIRECTORIES older than `olderThanMs`
 * (default 1 hour). Returns the number removed. Never throws: a missing
 * runtimeDir is not an error (returns 0), and every per-entry fs error is
 * swallowed so one bad entry can't abort the sweep or the caller's startup.
 *
 * Directories only — a stray FILE named `cred-*` (should never happen, but
 * defensive) is left alone rather than guessed at.
 */
export async function sweepStaleCredDirs(
  paths: JunctionPaths,
  opts?: { olderThanMs?: number },
): Promise<number> {
  const olderThanMs = opts?.olderThanMs ?? DEFAULT_OLDER_THAN_MS
  const now = Date.now()

  let entries: string[]
  try {
    entries = await readdir(paths.runtimeDir)
  } catch {
    return 0 // no runtimeDir yet (ENOENT) or unreadable — nothing to sweep
  }

  let count = 0
  for (const entry of entries) {
    if (!entry.startsWith("cred-")) continue
    const entryPath = path.join(paths.runtimeDir, entry)
    try {
      const st = await stat(entryPath)
      if (!st.isDirectory()) continue // dirs-only — a stray file is left alone
      if (now - st.mtimeMs <= olderThanMs) continue // fresh — never touch a live dir
      await rm(entryPath, { recursive: true, force: true })
      count++
    } catch {
      // best-effort — a stat/rm failure on one entry must never abort the sweep
    }
  }
  if (count > 0) {
    getLogger().warn("swept stale credential temp dirs", { count })
  }
  return count
}
