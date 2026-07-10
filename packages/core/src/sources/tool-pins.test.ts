// SPDX-License-Identifier: AGPL-3.0-only
// createFileToolPinStore tests — round-trip, corrupt-file fail-open (read AND the
// refuse-to-overwrite write guard), 0600, batch semantics, version gating.

import { readFile, stat, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { ensureHome } from "../paths/index.js"
import { withTempHome } from "../testing/index.js"
import { createFileToolPinStore, pinKeyString } from "./tool-pins.js"

describe("createFileToolPinStore", () => {
  it("getAll on a missing pins file returns an empty map, no warning", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const store = createFileToolPinStore(paths)

      const result = await store.getAll()
      expect(result.warning).toBe(false)
      expect(result.pins.size).toBe(0)
    })
  })

  it("round-trip: putMany then getAll returns the recorded pin", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const store = createFileToolPinStore(paths)

      const key = { platformId: "github", rawName: "list_issues" }
      const now = new Date().toISOString()
      await store.putMany([{ key, hash: "abc123", now }])

      const result = await store.getAll()
      expect(result.warning).toBe(false)
      const record = result.pins.get(pinKeyString(key))
      expect(record).toBeDefined()
      expect(record?.hash).toBe("abc123")
      expect(record?.firstSeenAt).toBe(now)
      expect(record?.updatedAt).toBe(now)
    })
  })

  it("a hash change preserves firstSeenAt but bumps updatedAt", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const store = createFileToolPinStore(paths)

      const key = { platformId: "github", rawName: "list_issues" }
      const firstSeen = "2026-01-01T00:00:00.000Z"
      const later = "2026-02-01T00:00:00.000Z"

      await store.putMany([{ key, hash: "hash-v1", now: firstSeen }])
      await store.putMany([{ key, hash: "hash-v2", now: later }])

      const result = await store.getAll()
      const record = result.pins.get(pinKeyString(key))
      expect(record?.hash).toBe("hash-v2")
      expect(record?.firstSeenAt).toBe(firstSeen)
      expect(record?.updatedAt).toBe(later)
    })
  })

  it("corrupt (invalid JSON) pins file → getAll returns empty map WITH warning + detail (fail-open, no throw)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      await writeFile(paths.pinsFile, "{ not valid json", "utf-8")
      const store = createFileToolPinStore(paths)

      const result = await store.getAll()
      expect(result.warning).toBe(true)
      expect(result.detail).toBe("parse-failed")
      expect(result.pins.size).toBe(0)
    })
  })

  it("wrong-shape JSON pins file → getAll returns empty map WITH warning (fail-open, no throw)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      await writeFile(paths.pinsFile, JSON.stringify({ nonsense: true }), "utf-8")
      const store = createFileToolPinStore(paths)

      const result = await store.getAll()
      expect(result.warning).toBe(true)
      expect(result.pins.size).toBe(0)
    })
  })

  it("old-version (v:1) pins file → treated as empty-with-warning (pre-release key re-scope, no migration)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      await writeFile(
        paths.pinsFile,
        JSON.stringify({
          v: 1,
          pins: { "ns tool": { hash: "h", firstSeenAt: "x", updatedAt: "x" } },
        }),
        "utf-8",
      )
      const store = createFileToolPinStore(paths)

      const result = await store.getAll()
      expect(result.warning).toBe(true)
      expect(result.detail).toBe("parse-failed")
      expect(result.pins.size).toBe(0)
    })
  })

  it("REFUSES to overwrite a corrupt pins file: putMany leaves the bytes untouched and warns", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const corruptContent = "{ definitely not json — keep me for inspection"
      await writeFile(paths.pinsFile, corruptContent, "utf-8")
      const store = createFileToolPinStore(paths)

      const putResult = await store.putMany([
        {
          key: { platformId: "github", rawName: "list_issues" },
          hash: "h1",
          now: new Date().toISOString(),
        },
      ])

      // Write refused + surfaced — never clobber a file we couldn't parse.
      expect(putResult.warning).toBe(true)
      expect(putResult.detail).toBe("refused-corrupt-file")

      // File bytes are UNCHANGED (kept on disk for operator inspection).
      const after = await readFile(paths.pinsFile, "utf-8")
      expect(after).toBe(corruptContent)
    })
  })

  it("putMany with an empty changes array is a no-op — no file is written", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const store = createFileToolPinStore(paths)

      const putResult = await store.putMany([])
      expect(putResult.warning).toBe(false)

      // Still no file on disk — getAll reads ENOENT → empty, not-warned.
      const result = await store.getAll()
      expect(result.warning).toBe(false)
      expect(result.pins.size).toBe(0)
    })
  })

  it("putMany writes the pins file at mode 0600", async () => {
    if (process.platform === "win32") return
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const store = createFileToolPinStore(paths)

      await store.putMany([
        {
          key: { platformId: "github", rawName: "get_issue" },
          hash: "h1",
          now: new Date().toISOString(),
        },
      ])

      const s = await stat(paths.pinsFile)
      expect(s.mode & 0o777).toBe(0o600)
    })
  })

  it("batch semantics: multiple keys in one putMany call are all persisted together", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const store = createFileToolPinStore(paths)

      const now = new Date().toISOString()
      const keyA = { platformId: "github", rawName: "list_issues" }
      const keyB = { platformId: "github", rawName: "get_pull_request" }
      await store.putMany([
        { key: keyA, hash: "hash-a", now },
        { key: keyB, hash: "hash-b", now },
      ])

      const result = await store.getAll()
      expect(result.pins.size).toBe(2)
      expect(result.pins.get(pinKeyString(keyA))?.hash).toBe("hash-a")
      expect(result.pins.get(pinKeyString(keyB))?.hash).toBe("hash-b")
    })
  })

  it("a later putMany call preserves keys written by an earlier call (merge, not overwrite)", async () => {
    await withTempHome(async () => {
      const paths = (await ensureHome())._unsafeUnwrap()
      const store = createFileToolPinStore(paths)

      const now = new Date().toISOString()
      const keyA = { platformId: "github", rawName: "list_issues" }
      const keyB = { platformId: "gitlab", rawName: "get_pull_request" }

      await store.putMany([{ key: keyA, hash: "hash-a", now }])
      await store.putMany([{ key: keyB, hash: "hash-b", now }])

      const result = await store.getAll()
      expect(result.pins.size).toBe(2)
      expect(result.pins.get(pinKeyString(keyA))?.hash).toBe("hash-a")
      expect(result.pins.get(pinKeyString(keyB))?.hash).toBe("hash-b")
    })
  })

  it("pinKeyString distinguishes different platforms for the same raw tool name", () => {
    const a = pinKeyString({ platformId: "github", rawName: "list_issues" })
    const b = pinKeyString({ platformId: "gitlab", rawName: "list_issues" })
    expect(a).not.toBe(b)
  })
})
