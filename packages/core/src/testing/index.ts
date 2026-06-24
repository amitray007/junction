// SPDX-License-Identifier: AGPL-3.0-only
// Test helpers — exported on ./testing subpath only, never the main barrel.

import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Creates a unique temp directory under os.tmpdir() for use as JUNCTION_HOME.
 * Caller is responsible for cleanup.
 */
export async function createTempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "junction-test-"))
}

/**
 * Runs fn with JUNCTION_HOME set to a fresh temp dir, then restores the
 * original env and removes the dir. Tests must not touch the real ~/.junction.
 */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await createTempHome()
  const prev = process.env.JUNCTION_HOME
  process.env.JUNCTION_HOME = home
  try {
    return await fn(home)
  } finally {
    if (prev === undefined) {
      delete process.env.JUNCTION_HOME
    } else {
      process.env.JUNCTION_HOME = prev
    }
    await rm(home, { recursive: true, force: true })
  }
}
