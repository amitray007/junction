// SPDX-License-Identifier: AGPL-3.0-only
// ToolPinStore — TOFU (trust-on-first-use) hash pins for rug-pull detection (increment 32.11).
//
// SCOPE: proxy.ts's listTools computes a hash of each tool's SANITIZED description + inputSchema
// and compares it against a previously-recorded pin. First sighting records the pin silently;
// a later mismatch means the upstream source changed a tool's contract between listings without
// the human re-approving it — a "rug pull". v1 posture is TOFU + warn-and-serve (see proxy.ts).
//
// DELIBERATE FILE STORE, NOT A DB TABLE: pins are cheap, source-local, and don't need relational
// queries or the 32.9 migration machinery. A JSON file at paths.pinsFile keeps this store fully
// decoupled from db/schema.ts (which increment 32.11 must NOT touch — see the method file's "Do
// NOT" section). If pin volume ever grows enough to want indexed queries, migrate to SQLite then —
// tracked as a revisit-when in docs/futures/revisit-when.md.
//
// PURE INJECTION SHAPE: this module does the I/O; proxy.ts stays pure and only calls the
// interface below (same DI shape as ResolveProviderFn / AuditSink — see proxy.ts's file header).
//
// SECURITY: this file NEVER receives or persists raw/sanitized description TEXT — only the
// sha256Hex digest, the source-local key, and timestamps. Corrupt/missing file → empty map
// (fail-open — a broken pins file must never break tool listing), but the caller is expected to
// warn on that outcome (see readAll's returned `warning`).

import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { writeFile0600 } from "../credentials/vault-crypto.js"
import type { JunctionPaths } from "../paths/index.js"

// ---------------------------------------------------------------------------
// On-disk schema
// ---------------------------------------------------------------------------

const PinRecordSchema = z.object({
  hash: z.string(),
  firstSeenAt: z.string(),
  updatedAt: z.string(),
})

const PinFileSchema = z.object({
  v: z.literal(1),
  pins: z.record(z.string(), PinRecordSchema),
})

export type PinRecord = z.infer<typeof PinRecordSchema>

/** Source-local key: `(toolNamespace, rawName)` — NEVER the prefixed/namespaced tool name. */
export type PinKey = { toolNamespace: string; rawName: string }

/** In-memory pin map, keyed by the serialized PinKey (see `pinKeyString`). */
export type PinMap = Map<string, PinRecord>

/** A pin change collected during a listTools pass — new sighting or a changed hash. */
export type PinChange = { key: PinKey; hash: string; now: string }

// ---------------------------------------------------------------------------
// Key serialization — deterministic, collision-safe
// ---------------------------------------------------------------------------

/**
 * Serialize a PinKey to its on-disk map key. Namespaces carry no "__" (project-wide
 * contract — see CLAUDE.md's tool-namespacing charset rule) and raw tool names are
 * MCP-legal identifiers (no space), so a single space is an unambiguous, collision-free
 * separator between the two fields. Exported for proxy.ts (looks up an existing record by
 * key) and for tests.
 */
export function pinKeyString(key: PinKey): string {
  return `${key.toolNamespace} ${key.rawName}`
}

// ---------------------------------------------------------------------------
// ToolPinStore — the injected interface (proxy.ts depends on this, not fs)
// ---------------------------------------------------------------------------

export interface ToolPinStore {
  /**
   * Read the full pin map. Never throws or rejects — a corrupt/missing file resolves to
   * an empty map with `warning: true` so the caller can surface a single structured warn
   * without crashing the listTools pass (fail-open).
   */
  getAll(): Promise<{ pins: PinMap; warning: boolean }>
  /**
   * Persist new/changed pins in one locked, atomic batch write. A no-op (returns without
   * writing) when `changes` is empty — unchanged tools must never trigger a file rewrite.
   * Never throws — write failures resolve with `warning: true` so the caller can warn
   * without crashing the listTools pass that triggered the write (fail-open).
   */
  putMany(changes: PinChange[]): Promise<{ warning: boolean }>
}

// ---------------------------------------------------------------------------
// createFileToolPinStore — JSON file at paths.pinsFile
// ---------------------------------------------------------------------------

/** Parse a pins file's raw JSON text into a validated PinMap. Throws on invalid JSON/schema. */
function parsePinFile(raw: string): PinMap {
  const parsed = PinFileSchema.parse(JSON.parse(raw) as unknown)
  return new Map(Object.entries(parsed.pins))
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value
}

/** Load the pins file. ENOENT → empty map, no warning (normal first-run path). */
async function loadPinFile(pinsFile: string): Promise<{ pins: PinMap; warning: boolean }> {
  try {
    const raw = await readFile(pinsFile, "utf-8")
    return { pins: parsePinFile(raw), warning: false }
  } catch (cause: unknown) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return { pins: new Map(), warning: false }
    }
    // Corrupt JSON, failed Zod validation, or any other read error on a PRESENT file:
    // fail-open to an empty map (never crash listTools) but flag it for the caller to warn.
    return { pins: new Map(), warning: true }
  }
}

/** Serialize a PinMap back to the on-disk PinFileSchema shape. */
function serializePinMap(pins: PinMap): string {
  const entries = Object.fromEntries(pins.entries())
  return JSON.stringify({ v: 1, pins: entries }, null, 2)
}

/**
 * Merge `changes` into the on-disk pin file under a home-dir lock and persist the result.
 *
 * Re-reads under the lock (rather than trusting the caller's getAll() snapshot) so a
 * concurrent process's own putMany is never clobbered — unrelated keys it wrote since our
 * snapshot survive the merge. For a key ALSO present on disk, `firstSeenAt` is preserved
 * from the existing record (a hash change updates `hash`/`updatedAt` only — `firstSeenAt`
 * must keep recording when the tool was FIRST seen, not when it last drifted); a
 * genuinely new key gets `firstSeenAt = updatedAt = change.now`.
 */
async function savePinFile(paths: JunctionPaths, changes: PinChange[]): Promise<void> {
  const { lock } = await import("proper-lockfile")
  const lockfilePath = path.join(paths.home, ".tool-pins.lock")
  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(paths.home, { lockfilePath })
    const current = await loadPinFile(paths.pinsFile)
    const merged = new Map(current.pins)
    for (const change of changes) {
      const key = pinKeyString(change.key)
      const existing = merged.get(key)
      merged.set(key, {
        hash: change.hash,
        firstSeenAt: existing?.firstSeenAt ?? change.now,
        updatedAt: change.now,
      })
    }
    await writeFile0600(paths.pinsFile, Buffer.from(serializePinMap(merged), "utf-8"))
  } finally {
    if (release) await release().catch(() => {})
  }
}

/**
 * Build a JSON-file-backed ToolPinStore at `paths.pinsFile`.
 *
 * Read-once / batch-write: `getAll()` reads the whole file; `putMany()` writes the whole
 * (merged) file back under a proper-lockfile lock on the home dir — mirroring config/
 * index.ts's saveConfig locking strategy (lock the home dir, not the target file, so the
 * lock target always exists).
 */
export function createFileToolPinStore(paths: JunctionPaths): ToolPinStore {
  return {
    async getAll() {
      return loadPinFile(paths.pinsFile)
    },

    async putMany(changes: PinChange[]) {
      if (changes.length === 0) return { warning: false }
      try {
        await savePinFile(paths, changes)
        return { warning: false }
      } catch {
        return { warning: true }
      }
    },
  }
}
