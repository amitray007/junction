// SPDX-License-Identifier: AGPL-3.0-only
// FullAccessPanel tests (increment 41.4) — the discovery picker, manual-path
// escape hatch, and the Fable Q3/Q6 install-confirmation copy.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mockDiscoverCliBinaryFn = vi.fn()

vi.mock("../../../server/platform-mutations.functions.js", () => ({
  discoverCliBinaryFn: (...args: unknown[]) => mockDiscoverCliBinaryFn(...args),
}))

const { FullAccessPanel } = await import("./full-access-panel.js")
const { emptyFullAccessState } = await import("./types.js")

afterEach(() => {
  cleanup()
  mockDiscoverCliBinaryFn.mockReset()
})

describe("FullAccessPanel", () => {
  it("renders the binary-name input and the install-confirmation copy", () => {
    const { getByPlaceholderText, getByText } = render(
      <FullAccessPanel fullAccess={emptyFullAccessState()} onChange={vi.fn()} />,
    )
    expect(getByPlaceholderText("gh")).toBeInTheDocument()
    expect(getByText(/Full CLI access/)).toBeInTheDocument()
    expect(getByText(/Junction learns this binary's commands once at install/)).toBeInTheDocument()
  })

  it("discovering candidates preselects the recommendation (first entry)", async () => {
    mockDiscoverCliBinaryFn.mockResolvedValue({
      ok: true,
      candidates: [
        { path: "/opt/homebrew/bin/gh", realpath: "/opt/homebrew/bin/gh", source: "path" },
        { path: "/usr/local/bin/gh", realpath: "/usr/local/bin/gh", source: "path" },
      ],
    })

    let state = { ...emptyFullAccessState(), binaryName: "gh" }
    const onChange = vi.fn((next) => {
      state = next
    })
    const { getByText, rerender } = render(
      <FullAccessPanel fullAccess={state} onChange={onChange} />,
    )

    fireEvent.click(getByText("Discover"))

    await waitFor(() =>
      expect(mockDiscoverCliBinaryFn).toHaveBeenCalledWith({ data: { name: "gh" } }),
    )
    await waitFor(() => expect(onChange).toHaveBeenCalled())

    rerender(<FullAccessPanel fullAccess={state} onChange={onChange} />)

    expect(state.selectedRealpath).toBe("/opt/homebrew/bin/gh")
    expect(getByText("/opt/homebrew/bin/gh")).toBeInTheDocument()
    expect(getByText(/recommended/)).toBeInTheDocument()
  })

  it("a discovery error (invalid name) surfaces the server's error message", async () => {
    mockDiscoverCliBinaryFn.mockResolvedValue({
      ok: false,
      error: '"../etc/passwd" is not a valid bare command name',
    })

    let state = { ...emptyFullAccessState(), binaryName: "../etc/passwd" }
    const onChange = vi.fn((next) => {
      state = next
    })
    const { getByText, rerender } = render(
      <FullAccessPanel fullAccess={state} onChange={onChange} />,
    )

    fireEvent.click(getByText("Discover"))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    rerender(<FullAccessPanel fullAccess={state} onChange={onChange} />)

    expect(getByText(/not a valid bare command name/)).toBeInTheDocument()
  })

  it("the manual path escape hatch reveals a free-text absolute-path input", () => {
    const state = { ...emptyFullAccessState(), manualPath: true }
    const { getByPlaceholderText } = render(
      <FullAccessPanel fullAccess={state} onChange={vi.fn()} />,
    )
    expect(getByPlaceholderText("/opt/homebrew/bin/gh")).toBeInTheDocument()
  })

  it("clicking Discover with an empty binary name sets a local error, without calling the server fn", () => {
    const onChange = vi.fn()
    const { getByText } = render(
      <FullAccessPanel fullAccess={emptyFullAccessState()} onChange={onChange} />,
    )
    fireEvent.click(getByText("Discover"))
    expect(mockDiscoverCliBinaryFn).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ discoverError: "Enter a binary name first" }),
    )
  })
})
