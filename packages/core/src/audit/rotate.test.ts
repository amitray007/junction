// SPDX-License-Identifier: AGPL-3.0-only
// rotateAuditLogIfOversized tests (increment 32.8). Mirrors read.test.ts's
// mkdtemp fixture style. Uses tiny maxBytes overrides so fixtures stay small
// and readable rather than actually writing multi-MB files.

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { rotateAuditLogIfOversized } from "./rotate.js"

let tmpDir: string
let auditLogFile: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "junction-audit-rotate-test-"))
  auditLogFile = path.join(tmpDir, "audit.log")
})

afterEach(async () => {
  // Restore write perms in case the read-only-dir test left tmpDir locked
  // down — otherwise rm() itself can fail to clean up.
  await chmod(tmpDir, 0o700).catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeSizedFile(filePath: string, bytes: number): Promise<void> {
  await writeFile(filePath, "x".repeat(bytes), "utf8")
  await chmod(filePath, 0o600)
}

describe("rotateAuditLogIfOversized", () => {
  it("oversized file: rotates to .1 with the old content, .1 is 0o600", async () => {
    await writeSizedFile(auditLogFile, 20)

    const outcome = await rotateAuditLogIfOversized(auditLogFile, { maxBytes: 10, keep: 5 })
    expect(outcome).toEqual({ kind: "rotated" })

    // Current file is gone (a writer would recreate it — this module never does).
    await expect(stat(auditLogFile)).rejects.toMatchObject({ code: "ENOENT" })

    const rotated = `${auditLogFile}.1`
    const content = await readFile(rotated, "utf8")
    expect(content).toBe("x".repeat(20))

    const st = await stat(rotated)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it("shift chain: an existing .1 becomes .2 when audit.log rotates again", async () => {
    await writeSizedFile(auditLogFile, 20)
    await writeSizedFile(`${auditLogFile}.1`, 5) // pre-existing older generation

    const outcome = await rotateAuditLogIfOversized(auditLogFile, { maxBytes: 10, keep: 5 })
    expect(outcome).toEqual({ kind: "rotated" })

    const gen1 = await readFile(`${auditLogFile}.1`, "utf8")
    const gen2 = await readFile(`${auditLogFile}.2`, "utf8")
    expect(gen1).toBe("x".repeat(20)) // the just-rotated current file
    expect(gen2).toBe("x".repeat(5)) // the previous .1, shifted to .2
  })

  it("keep bound: with keep=2, a pre-existing .2 is deleted (nothing beyond .2 survives)", async () => {
    await writeSizedFile(auditLogFile, 30) // becomes .1
    await writeSizedFile(`${auditLogFile}.1`, 20) // shifts to .2 — the rename(.1→.2) CLOBBERS the old .2
    await writeSizedFile(`${auditLogFile}.2`, 10) // destroyed by that overwriting rename (POSIX), never shifted to .3

    const outcome = await rotateAuditLogIfOversized(auditLogFile, { maxBytes: 10, keep: 2 })
    expect(outcome).toEqual({ kind: "rotated" })

    const gen1 = await readFile(`${auditLogFile}.1`, "utf8")
    const gen2 = await readFile(`${auditLogFile}.2`, "utf8")
    expect(gen1).toBe("x".repeat(30))
    expect(gen2).toBe("x".repeat(20))
    await expect(stat(`${auditLogFile}.3`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("straggler cleanup: pre-existing .3 and .4 from a prior larger keep are both unlinked with keep=2", async () => {
    await writeSizedFile(auditLogFile, 30)
    await writeSizedFile(`${auditLogFile}.3`, 8) // straggler from a prior run with keep >= 3
    await writeSizedFile(`${auditLogFile}.4`, 6) // straggler from a prior run with keep >= 4

    const outcome = await rotateAuditLogIfOversized(auditLogFile, { maxBytes: 10, keep: 2 })
    expect(outcome).toEqual({ kind: "rotated" })

    const gen1 = await readFile(`${auditLogFile}.1`, "utf8")
    expect(gen1).toBe("x".repeat(30))
    await expect(stat(`${auditLogFile}.3`)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(`${auditLogFile}.4`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("under-sized file: untouched, returns skipped", async () => {
    await writeSizedFile(auditLogFile, 5)

    const outcome = await rotateAuditLogIfOversized(auditLogFile, { maxBytes: 10, keep: 5 })
    expect(outcome).toEqual({ kind: "skipped" })

    const content = await readFile(auditLogFile, "utf8")
    expect(content).toBe("x".repeat(5))
    await expect(stat(`${auditLogFile}.1`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("missing file: returns skipped, never throws", async () => {
    const outcome = await rotateAuditLogIfOversized(auditLogFile, { maxBytes: 10, keep: 5 })
    expect(outcome).toEqual({ kind: "skipped" })
  })

  it("rotation into a read-only dir: returns failed, never throws (best-effort)", async () => {
    await writeSizedFile(auditLogFile, 20)
    await chmod(tmpDir, 0o500) // read+execute only — rename() inside it must fail

    const outcome = await rotateAuditLogIfOversized(auditLogFile, { maxBytes: 10, keep: 5 })
    expect(outcome.kind).toBe("failed")
    if (outcome.kind === "failed") {
      expect(typeof outcome.code).toBe("string")
      expect(outcome.code.length).toBeGreaterThan(0)
    }

    await chmod(tmpDir, 0o700) // restore before afterEach's rm
  })
})
