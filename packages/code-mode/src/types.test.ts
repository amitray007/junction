// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest"
import { DEFAULT_EXECUTE_OPTS } from "./types.js"

describe("DEFAULT_EXECUTE_OPTS", () => {
  it("has a sane, non-zero value for every budget field", () => {
    expect(DEFAULT_EXECUTE_OPTS.timeoutMs).toBeGreaterThan(0)
    expect(DEFAULT_EXECUTE_OPTS.memoryBytes).toBeGreaterThan(0)
    expect(DEFAULT_EXECUTE_OPTS.maxStackBytes).toBeGreaterThan(0)
    expect(DEFAULT_EXECUTE_OPTS.argByteCap).toBeGreaterThan(0)
    expect(DEFAULT_EXECUTE_OPTS.resultByteCap).toBeGreaterThan(0)
    expect(DEFAULT_EXECUTE_OPTS.logByteCap).toBeGreaterThan(0)
  })
})
