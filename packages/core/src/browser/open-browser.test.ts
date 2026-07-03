// SPDX-License-Identifier: AGPL-3.0-only
// open-browser.test.ts — asserts the right command per platform + detached/unref semantics.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const spawnMock = vi.fn()
const unrefMock = vi.fn()

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawnMock(...args)
    return { unref: unrefMock }
  },
}))

describe("openInBrowser", () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    spawnMock.mockClear()
    unrefMock.mockClear()
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("uses `open` on darwin", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    const { openInBrowser } = await import("./open-browser.js")
    openInBrowser("https://example.com")
    expect(spawnMock).toHaveBeenCalledWith("open", ["https://example.com"], {
      detached: true,
      stdio: "ignore",
    })
    expect(unrefMock).toHaveBeenCalledOnce()
  })

  it("uses `cmd /c start` on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    const { openInBrowser } = await import("./open-browser.js")
    openInBrowser("https://example.com")
    expect(spawnMock).toHaveBeenCalledWith("cmd", ["/c", "start", "https://example.com"], {
      detached: true,
      stdio: "ignore",
    })
    expect(unrefMock).toHaveBeenCalledOnce()
  })

  it("uses `xdg-open` elsewhere (e.g. linux)", async () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    const { openInBrowser } = await import("./open-browser.js")
    openInBrowser("https://example.com")
    expect(spawnMock).toHaveBeenCalledWith("xdg-open", ["https://example.com"], {
      detached: true,
      stdio: "ignore",
    })
    expect(unrefMock).toHaveBeenCalledOnce()
  })
})
