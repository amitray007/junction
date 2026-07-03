// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the /oauth/callback file-route (inc 29, slice C). The route has no
// component — only validateSearch + loaderDeps + loader — so these tests
// exercise Route.options directly rather than rendering anything.
//
// handleOAuthCallbackFn is mocked (it calls getRequest()/core/source-runtime,
// none of which are available in this test's module graph) so this focuses on
// the route's OWN plumbing: search validation and loader delegation.

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: unknown) => ({ options }),
}))

const mockHandleOAuthCallbackFn = vi.fn()
vi.mock("../server/oauth-connect.functions.js", () => ({
  handleOAuthCallbackFn: (...args: unknown[]) => mockHandleOAuthCallbackFn(...args),
}))

const { Route } = await import("./oauth.callback.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — the route options shape isn't worth typing here
const options = (Route as any).options as {
  validateSearch: (search: Record<string, unknown>) => { code?: string; state?: string }
  loaderDeps: (args: { search: { code?: string; state?: string } }) => {
    code?: string
    state?: string
  }
  loader: (args: { deps: { code?: string; state?: string } }) => Promise<void>
}

afterEach(() => {
  mockHandleOAuthCallbackFn.mockReset()
})

describe("/oauth/callback — validateSearch", () => {
  it("passes through valid code+state strings", () => {
    const result = options.validateSearch({ code: "abc", state: "xyz" })
    expect(result).toEqual({ code: "abc", state: "xyz" })
  })

  it("drops non-string code/state to undefined rather than throwing", () => {
    const result = options.validateSearch({ code: 123, state: null })
    expect(result).toEqual({ code: undefined, state: undefined })
  })

  it("handles a totally empty search (no ?code/&state at all)", () => {
    const result = options.validateSearch({})
    expect(result).toEqual({ code: undefined, state: undefined })
  })
})

describe("/oauth/callback — loaderDeps", () => {
  it("forwards code/state from search unchanged", () => {
    const deps = options.loaderDeps({ search: { code: "abc", state: "xyz" } })
    expect(deps).toEqual({ code: "abc", state: "xyz" })
  })
})

describe("/oauth/callback — loader", () => {
  it("calls handleOAuthCallbackFn with the deps' code/state", async () => {
    mockHandleOAuthCallbackFn.mockResolvedValue(undefined)
    await options.loader({ deps: { code: "the-code", state: "the-state" } })
    expect(mockHandleOAuthCallbackFn).toHaveBeenCalledWith({
      data: { code: "the-code", state: "the-state" },
    })
  })

  it("still calls handleOAuthCallbackFn when code/state are absent (malformed callback request)", async () => {
    mockHandleOAuthCallbackFn.mockResolvedValue(undefined)
    await options.loader({ deps: { code: undefined, state: undefined } })
    expect(mockHandleOAuthCallbackFn).toHaveBeenCalledWith({
      data: { code: undefined, state: undefined },
    })
  })

  it("propagates a thrown redirect from handleOAuthCallbackFn (the real success/error path)", async () => {
    const redirectSentinel = { isRedirect: true, to: "/credentials", search: { connect: "ok" } }
    mockHandleOAuthCallbackFn.mockRejectedValue(redirectSentinel)
    await expect(options.loader({ deps: { code: "c", state: "s" } })).rejects.toBe(redirectSentinel)
  })
})
