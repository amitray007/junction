// SPDX-License-Identifier: AGPL-3.0-only
// ToolPinStore — TOFU (trust-on-first-use) hash pins for rug-pull detection (increment 32.11).
//
// SCOPE: proxy.ts's listTools computes a hash of each tool's SANITIZED description + inputSchema
// and compares it against a previously-recorded pin. First sighting records the pin silently;
// a later mismatch means the upstream source changed a tool's contract between listings without
// the human re-approving it — a "rug pull". v1 posture is TOFU + warn-and-serve (see proxy.ts).
//
// DELIBERATE FILE STORE, NOT A DB TABLE: pins are cheap and don't need relational queries or
// the 32.9 migration machinery. A JSON file at paths.pinsFile keeps this store fully decoupled
// from db/schema.ts (which increment 32.11 must NOT touch — see the method file's "Do NOT"
// section). If pin volume ever grows enough to want indexed queries, migrate to SQLite then —
// tracked as a revisit-when in docs/futures/revisit-when.md.
//
// PLATFORM-SCOPED KEYS (review-gate fix): pins are keyed `(platformId, rawName)` — the stable
// UPSTREAM identity — never the profile-local toolNamespace and never the prefixed tool name.
// Namespace uniqueness is only per-PROFILE while this file is GLOBAL: keying by namespace would
// let two profiles that bind the same namespace to DIFFERENT platforms ping-pong one pin into
// perpetual false drift. The same platform mounted under two namespaces/profiles now correctly
// shares one pin. Namespace still appears in the drift WARN payload (operator context only).
//
// PURE INJECTION SHAPE: this module does the I/O; proxy.ts stays pure and only calls the
// interface below (same DI shape as ResolveProviderFn / AuditSink — see proxy.ts's file header).
//
// SECURITY: this file NEVER receives or persists raw/sanitized description TEXT — only the
// sha256Hex digest, the platform-scoped key, and timestamps. Corrupt/missing file → empty map
// (fail-open — a broken pins file must never break tool listing); the degraded state is
// surfaced through the returned `warning`/`detail`, which proxy.ts routes to its injected
// onPinStoreWarning callback (store-health must never be silent).
//
// NEVER OVERWRITE WHAT YOU COULDN'T PARSE: putMany re-reads the file under the lock and
// REFUSES the write if that re-read hit corruption — an unparseable file is kept on disk for
// inspection rather than clobbered with only this pass's pins (which would silently destroy
// every other platform's recorded baselines).

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

/**
 * v2 (review-gate fix, pre-release bump): keys changed from `(toolNamespace, rawName)` to
 * `(platformId, rawName)`. No migration — the feature never shipped at v1, so a v1 file can
 * only exist on a dev machine; the version literal makes such a file fail validation and be
 * treated as empty-with-warning (and putMany then REFUSES to overwrite it — see savePinFile).
 */
const PinFileSchema = z.object({
  v: z.literal(2),
  pins: z.record(z.string(), PinRecordSchema),
})

export type PinRecord = z.infer<typeof PinRecordSchema>

/**
 * Platform-scoped key: `(platformId, rawName)` — the stable upstream identity. NEVER the
 * profile-local toolNamespace (see the file header) and never the prefixed/namespaced name.
 */
export type PinKey = { platformId: string; rawName: string }

/** In-memory pin map, keyed by the serialized PinKey (see `pinKeyString`). */
export type PinMap = Map<string, PinRecord>

/** A pin change collected during a listTools pass — new sighting or a changed hash. */
export type PinChange = { key: PinKey; hash: string; now: string }

// ---------------------------------------------------------------------------
// Key serialization — deterministic, collision-safe
// ---------------------------------------------------------------------------

/**
 * Serialize a PinKey to its on-disk map key. Injective: `rawName` is MCP-legal
 * (`/^[a-zA-Z0-9_-]{1,64}$/` — proxy.ts pins only AFTER namespaceToolName validated the
 * name, and callers must uphold that), so it can never contain a space — the LAST space in
 * the key therefore unambiguously separates platformId (which the schema does not forbid
 * spaces in) from rawName. Exported for proxy.ts (looks up an existing record by key) and
 * for tests.
 */
export function pinKeyString(key: PinKey): string {
  return `${key.platformId} ${key.rawName}`
}

// ---------------------------------------------------------------------------
// ToolPinStore — the injected interface (proxy.ts depends on this, not fs)
// ---------------------------------------------------------------------------

export interface ToolPinStore {
  /**
   * Read the full pin map. Never throws or rejects — a corrupt/unreadable file resolves to
   * an empty map with `warning: true` + a content-free `detail` code so the caller can
   * surface one structured warn (proxy.ts → onPinStoreWarning) without crashing the
   * listTools pass (fail-open). A missing file (first run) is empty with NO warning.
   */
  getAll(): Promise<{ pins: PinMap; warning: boolean; detail?: string }>
  /**
   * Persist new/changed pins in one locked, atomic batch write. A no-op (returns without
   * writing) when `changes` is empty — unchanged tools must never trigger a file rewrite.
   * Never throws — a write failure OR a refused write (the under-lock re-read found a
   * corrupt file; see savePinFile) resolves with `warning: true` + a content-free `detail`
   * code so the caller can warn without crashing the listTools pass (fail-open).
   */
  putMany(changes: PinChange[]): Promise<{ warning: boolean; detail?: string }>
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

/**
 * Load the pins file. ENOENT → empty map, no warning (normal first-run path).
 * Any other failure on a PRESENT file → empty map + warning + a content-free detail code
 * ("parse-failed" for JSON/schema corruption, the errno code for I/O errors).
 */
async function loadPinFile(
  pinsFile: string,
): Promise<{ pins: PinMap; warning: boolean; detail?: string }> {
  try {
    const raw = await readFile(pinsFile, "utf-8")
    try {
      return { pins: parsePinFile(raw), warning: false }
    } catch {
      // Corrupt JSON or failed Zod validation (incl. an old-version file): fail-open to an
      // empty map (never crash listTools) but flag it. savePinFile treats this state as
      // NON-overwritable (never clobber a file we couldn't parse).
      return { pins: new Map(), warning: true, detail: "parse-failed" }
    }
  } catch (cause: unknown) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return { pins: new Map(), warning: false }
    }
    return {
      pins: new Map(),
      warning: true,
      detail: isNodeError(cause) && cause.code ? cause.code : "read-failed",
    }
  }
}

/** Serialize a PinMap back to the on-disk PinFileSchema shape. */
function serializePinMap(pins: PinMap): string {
  const entries = Object.fromEntries(pins.entries())
  return JSON.stringify({ v: 2, pins: entries }, null, 2)
}

/**
 * Merge `changes` into the on-disk pin file under a home-dir lock and persist the result.
 *
 * Re-reads under the lock (rather than trusting the caller's getAll() snapshot) so a
 * concurrent process's own putMany is never clobbered — unrelated keys it wrote since our
 * snapshot survive the merge. For a key ALSO present on disk, `firstSeenAt` is preserved
 * from the existing record (a hash change updates `hash`/`updatedAt` only — `firstSeenAt`
 * must keep recording when the tool was FIRST seen, not when it last drifted); a genuinely
 * new key gets `firstSeenAt = updatedAt = change.now`.
 *
 * REFUSES the write (returns `{ refused: true }`, file bytes untouched) when the under-lock
 * re-read hit corruption: merging over an unparseable-but-present file would OVERWRITE it
 * with only this pass's pins, silently wiping every other platform's baselines. The corrupt
 * file is deliberately kept on disk for operator inspection; pinning stays degraded (and
 * warned, via putMany's `warning`) until it is repaired or removed.
 */
async function savePinFile(
  paths: JunctionPaths,
  changes: PinChange[],
): Promise<{ refused: boolean }> {
  const { lock } = await import("proper-lockfile")
  const lockfilePath = path.join(paths.home, ".tool-pins.lock")
  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(paths.home, { lockfilePath })
    const current = await loadPinFile(paths.pinsFile)
    if (current.warning) {
      return { refused: true }
    }
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
    return { refused: false }
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
        const saved = await savePinFile(paths, changes)
        if (saved.refused) return { warning: true, detail: "refused-corrupt-file" }
        return { warning: false }
      } catch (cause: unknown) {
        return {
          warning: true,
          detail: isNodeError(cause) && cause.code ? cause.code : "write-failed",
        }
      }
    },
  }
}
