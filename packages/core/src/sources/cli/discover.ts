// SPDX-License-Identifier: AGPL-3.0-only
// Binary discovery — "install a CLI by name" (Full CLI access, Fable Q1).
// Searches PATH then common install dirs for a bare command name, dedupes by
// realpath, and recommends the FIRST hit (what the user's shell would run —
// not highest version). Version is a best-effort SANDBOXED probe: discovery
// itself never execs unsandboxed.
//
// docs/specs/2026-07-16-cli-exploratory-mode.md §5 Q1 (binding).
//
// SECURITY: `name` is validated as a bare command (no slashes/metachars) —
// this is a pre-sandbox step (argv[0] must be an absolute path resolved
// BEFORE the sandbox; see cli-connection.ts). No sync fs — async only.

import { constants } from "node:fs"
import { access, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { errAsync, ResultAsync } from "../../result/index.js"
import type { Sandbox } from "../../sandbox/index.js"

export type BinaryCandidate = {
  name: string
  /** The path as found (PATH entry or common dir), before realpath resolution. */
  path: string
  /** Symlink-resolved absolute path — THIS is what gets persisted as binaryPath. */
  realpath: string
  /** Best-effort `--version` probe result (sandboxed). Omitted if unavailable/unparseable. */
  version?: string
  source: "path" | "common-dir"
}

export type DiscoverError = { kind: "invalid-name"; name: string }

/** Bare command name only — no path separators, no leading dash, no shell metachars. */
const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

// Fable Q1: PATH first, then these common install dirs, in this exact order.
// `~` is expanded against os.homedir() at call time (not import time — keeps
// this list a pure data declaration and testable via HOME override).
const COMMON_DIR_SUFFIXES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.local/bin",
  "~/.cargo/bin",
  "~/go/bin",
]

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

function commonDirs(): string[] {
  return COMMON_DIR_SUFFIXES.map(expandHome)
}

function pathDirs(): string[] {
  const raw = process.env.PATH ?? ""
  return raw.split(path.delimiter).filter((p) => p.trim() !== "")
}

/** True iff `p` exists and is executable by this process (async, no *Sync). */
async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Best-effort version probe: `<realpath> --version` run THROUGH THE SANDBOX
 * (no creds, no net, no writes, short timeout). Never throws, never blocks
 * discovery — a probe failure just omits `version`. Not sandboxed-unavailable-
 * aware beyond "no result" — discovery still returns candidates without a
 * sandbox backend, just without version strings.
 */
async function probeVersion(
  realPath: string,
  sandbox: Sandbox | undefined,
): Promise<string | undefined> {
  if (!sandbox) return undefined
  try {
    const cwd = os.tmpdir()
    const result = await sandbox.runCommand([realPath, "--version"], {
      cwd,
      readPaths: [cwd],
      writePaths: [],
      allowNet: [],
      env: {},
      timeoutMs: 5_000,
    })
    if (result.isErr()) return undefined
    const text = `${result.value.stdout}\n${result.value.stderr}`
    return parseVersionToken(text)
  } catch {
    return undefined
  }
}

/** Extract the first version-looking token (e.g. "2.95.0", "v1.2.3") from probe output. */
function parseVersionToken(text: string): string | undefined {
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)\b/.exec(text)
  return m?.[1]
}

/**
 * Discover candidate binaries for a bare command `name`. Searches PATH (in
 * PATH order) then the common install dirs (in the fixed order above), checks
 * the executable bit, and dedupes by realpath — PATH hits win over
 * common-dir-only hits for the same realpath. The recommendation is always
 * `candidates[0]` (first-in-PATH, Fable Q1 — never "highest version").
 *
 * Returns `Ok([])` (not an error) when nothing is found. `sandbox`, if
 * provided, is used ONLY for the best-effort `--version` probe — discovery
 * never execs unsandboxed.
 */
export function discoverBinary(
  name: string,
  sandbox?: Sandbox,
): ResultAsync<BinaryCandidate[], DiscoverError> {
  if (!VALID_NAME_RE.test(name)) {
    return errAsync({ kind: "invalid-name", name })
  }

  return ResultAsync.fromSafePromise(discoverBinaryAsync(name, sandbox))
}

async function discoverBinaryAsync(
  name: string,
  sandbox: Sandbox | undefined,
): Promise<BinaryCandidate[]> {
  const searchOrder: { dir: string; source: BinaryCandidate["source"] }[] = [
    ...pathDirs().map((dir) => ({ dir, source: "path" as const })),
    ...commonDirs().map((dir) => ({ dir, source: "common-dir" as const })),
  ]

  const seenRealpaths = new Set<string>()
  const candidates: BinaryCandidate[] = []

  for (const { dir, source } of searchOrder) {
    const candidatePath = path.join(dir, name)
    if (!(await isExecutable(candidatePath))) continue

    let resolved: string
    try {
      resolved = await realpath(candidatePath)
    } catch {
      continue
    }

    if (seenRealpaths.has(resolved)) continue
    seenRealpaths.add(resolved)

    const version = await probeVersion(resolved, sandbox)
    candidates.push({
      name,
      path: candidatePath,
      realpath: resolved,
      ...(version !== undefined ? { version } : {}),
      source,
    })
  }

  return candidates
}
