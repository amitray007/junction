// SPDX-License-Identifier: AGPL-3.0-only
// Regression guard for the credential-security finding (inc 31): audit.log must
// be created owner-only (0o600), NOT world-readable (0644 default) — the serve
// paths don't ensureHome(), so the file mode is the actual backstop.

import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { JunctionPaths } from "@junction/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFileAuditSink } from "./audit-sink.js"

describe("createFileAuditSink — file permissions", () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "jt-audit-perm-"))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("creates audit.log with 0o600 (owner-only), never world-readable", async () => {
    const auditLogFile = path.join(home, "audit.log")
    const paths = { auditLogFile } as JunctionPaths
    const sink = createFileAuditSink(paths)

    sink.emit({
      v: 1,
      ts: "2026-07-07T00:00:00.000Z",
      event: "tool_call",
      correlationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      principal: { kind: "stdio", keyId: null, label: null, profiles: ["p"] },
      target: { profile: "p", namespace: "ns", tool: "t" },
      argKeys: [],
      argHash: "sha256:empty",
      durationMs: 1,
      outcome: "ok",
      errorKind: null,
    })
    // Poll until sonic-boom's async open() lands the file, then assert perms.
    // (flushSync() before the fd opens is now swallowed — see audit-sink.ts.)
    let mode: number | undefined
    for (let i = 0; i < 50; i++) {
      sink.flushSync()
      try {
        mode = statSync(auditLogFile).mode & 0o777
        break
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    // exactly owner rw, no group/other bits
    expect(mode).toBe(0o600)
  })
})
