// SPDX-License-Identifier: AGPL-3.0-only
// resolveStaticFile regression tests (increment 32.7 item 4) — Node env, picked
// up by the ROOT vitest "unit" project (a .test.ts file, not .test.tsx, so the
// web package's happy-dom config never sees it — see packages/web/vitest.config.ts).
//
// Importing ../../serve.mjs here is itself the regression guard for the
// main-gate: serve.mjs must be side-effect-free on import (no SSR bundle
// load, no server.listen) now that its bootstrap lives behind the
// realpath-hardened main() guard.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveStaticFile } from "../../serve.mjs"

let tempRoot: string
let clientDir: string

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "junction-serve-static-test-"))
  clientDir = path.join(tempRoot, "client")
  await mkdir(path.join(clientDir, "assets"), { recursive: true })
  await writeFile(path.join(clientDir, "assets", "app.js"), "console.log('app')")
  await writeFile(path.join(clientDir, "index.html"), "<html></html>")

  // Sibling dir (NOT under clientDir) — the sibling-prefix escape target.
  const evilDir = path.join(tempRoot, "client-evil")
  await mkdir(evilDir, { recursive: true })
  await writeFile(path.join(evilDir, "leak.txt"), "should never be served")
})

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe("resolveStaticFile — increment 32.7 item 4", () => {
  it("hits a real asset file with the correct content type", async () => {
    const hit = await resolveStaticFile("/assets/app.js", clientDir)
    expect(hit).not.toBeNull()
    expect(hit?.filePath).toBe(path.join(clientDir, "assets", "app.js"))
    expect(hit?.contentType).toContain("javascript")
  })

  it("blocks a literal ../ traversal", async () => {
    const hit = await resolveStaticFile("/../outside.txt", clientDir)
    expect(hit).toBeNull()
  })

  it("blocks a %2e%2e percent-encoded traversal segment", async () => {
    const hit = await resolveStaticFile("/%2e%2e/outside.txt", clientDir)
    expect(hit).toBeNull()
  })

  it("blocks a mixed ..%2f percent-encoded traversal", async () => {
    const hit = await resolveStaticFile("/..%2foutside.txt", clientDir)
    expect(hit).toBeNull()
  })

  it("blocks a sibling-prefix escape (dist/client-evil vs dist/client)", async () => {
    // A path that would resolve OUTSIDE clientDir into the sibling client-evil
    // dir, if the guard only checked a string-prefix without a path separator.
    const hit = await resolveStaticFile("/../client-evil/leak.txt", clientDir)
    expect(hit).toBeNull()
  })

  it("returns null for the bare root path", async () => {
    const hit = await resolveStaticFile("/", clientDir)
    expect(hit).toBeNull()
  })

  it("returns null on malformed percent-encoding", async () => {
    const hit = await resolveStaticFile("/%E0%A4%A", clientDir)
    expect(hit).toBeNull()
  })

  it("blocks a double-encoded traversal (%252e%252e) — locks out a future double-decode regression", async () => {
    const hit = await resolveStaticFile("/%252e%252e/outside", clientDir)
    expect(hit).toBeNull()
  })

  it("returns null on an encoded NUL byte (%00) — the throw-to-null contract", async () => {
    const hit = await resolveStaticFile("/%00", clientDir)
    expect(hit).toBeNull()
  })

  it("strips the query string — /assets/app.js?v=1 is a HIT", async () => {
    const hit = await resolveStaticFile("/assets/app.js?v=1", clientDir)
    expect(hit).not.toBeNull()
    expect(hit?.filePath).toBe(path.join(clientDir, "assets", "app.js"))
  })

  it("returns null for a directory path (not a file)", async () => {
    const hit = await resolveStaticFile("/assets", clientDir)
    expect(hit).toBeNull()
  })

  it("defaults baseDir to CLIENT_DIR when omitted (byte-identical behaviour) — a nonexistent path under the default dir returns null, not a throw", async () => {
    const hit = await resolveStaticFile("/definitely-not-a-real-asset-32-7.js")
    expect(hit).toBeNull()
  })

  it("blocks a symlink under clientDir pointing OUTSIDE it (32.13 Slice E3)", async () => {
    // The symlink's own path is legitimately under clientDir (passes the
    // traversal guard); only lstat (not stat) can tell it's a symlink at all.
    const outsideTarget = path.join(tempRoot, "client-evil", "leak.txt")
    const linkPath = path.join(clientDir, "assets", "escape-link.js")
    await symlink(outsideTarget, linkPath)

    const hit = await resolveStaticFile("/assets/escape-link.js", clientDir)
    expect(hit).toBeNull()
  })

  it("blocks a symlink under clientDir pointing to another file INSIDE clientDir too (fail-closed on ANY symlink)", async () => {
    const insideTarget = path.join(clientDir, "index.html")
    const linkPath = path.join(clientDir, "assets", "inside-link.js")
    await symlink(insideTarget, linkPath)

    const hit = await resolveStaticFile("/assets/inside-link.js", clientDir)
    expect(hit).toBeNull()
  })

  it("still serves a REAL (non-symlink) file normally — the symlink guard has no false positive", async () => {
    const hit = await resolveStaticFile("/assets/app.js", clientDir)
    expect(hit).not.toBeNull()
  })
})
