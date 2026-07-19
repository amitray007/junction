// SPDX-License-Identifier: AGPL-3.0-only
// FullAccessPanel tests (increment 41.4) — the discovery picker, manual-path
// escape hatch, and the Fable Q3/Q6 install-confirmation copy.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mockDiscoverCliBinaryFn = vi.fn()
const mockListUnlinkedCredentialsFn = vi.fn()

vi.mock("../../../server/platform-mutations.functions.js", () => ({
  discoverCliBinaryFn: (...args: unknown[]) => mockDiscoverCliBinaryFn(...args),
  listUnlinkedCredentialsFn: (...args: unknown[]) => mockListUnlinkedCredentialsFn(...args),
}))

const { FullAccessPanel } = await import("./full-access-panel.js")
const { emptyFullAccessState } = await import("./types.js")

afterEach(() => {
  cleanup()
  mockDiscoverCliBinaryFn.mockReset()
  mockListUnlinkedCredentialsFn.mockReset()
})

describe("FullAccessPanel", () => {
  it("renders the binary-name input and the concise sandbox explainer", () => {
    const { getByPlaceholderText, getByText } = render(
      <FullAccessPanel fullAccess={emptyFullAccessState()} onChange={vi.fn()} />,
    )
    expect(getByPlaceholderText("gh")).toBeInTheDocument()
    expect(getByText(/Agents can run any/)).toBeInTheDocument()
    expect(getByText(/maps its/)).toBeInTheDocument()
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

  // ---------------------------------------------------------------------------
  // Credential section (increment 43, Slice B1) — skip/existing/new modes.
  // ---------------------------------------------------------------------------

  describe("Credential section", () => {
    it("defaults to Skip — no unlinked-credentials fetch on initial render", () => {
      const { getByLabelText } = render(
        <FullAccessPanel fullAccess={emptyFullAccessState()} onChange={vi.fn()} />,
      )
      expect(getByLabelText(/Skip — install without a secret/)).toBeChecked()
      expect(mockListUnlinkedCredentialsFn).not.toHaveBeenCalled()
    })

    it("switching to 'Use an existing credential' fetches the unlinked list, kind-filtered to env", async () => {
      mockListUnlinkedCredentialsFn.mockResolvedValue([
        { id: "cred-1", name: "gh-work", account: "work", kind: "env" },
      ])
      let state = emptyFullAccessState()
      const onChange = vi.fn((next) => {
        state = next
      })
      const { getByLabelText, rerender, getByRole } = render(
        <FullAccessPanel fullAccess={state} onChange={onChange} />,
      )
      fireEvent.click(getByLabelText(/Use an existing credential/))
      await waitFor(() =>
        expect(mockListUnlinkedCredentialsFn).toHaveBeenCalledWith({ data: { kind: "env" } }),
      )
      await waitFor(() => expect(state.credential.unlinkedOptions).toHaveLength(1))
      rerender(<FullAccessPanel fullAccess={state} onChange={onChange} />)
      // Radix Select's item list only mounts in a portal once opened (flaky
      // under happy-dom to drive open reliably) — assert the loaded state
      // reached the Select via its trigger, matching this codebase's existing
      // Select-test precedent (credentials.tsx's filter tests only assert the
      // trigger, never open the portal).
      expect(getByRole("combobox")).toBeInTheDocument()
    })

    it("no unlinked credentials shows a clear empty state, not a broken Select", async () => {
      mockListUnlinkedCredentialsFn.mockResolvedValue([])
      let state = emptyFullAccessState()
      const onChange = vi.fn((next) => {
        state = next
      })
      const { getByLabelText, rerender, getByText } = render(
        <FullAccessPanel fullAccess={state} onChange={onChange} />,
      )
      fireEvent.click(getByLabelText(/Use an existing credential/))
      await waitFor(() => expect(mockListUnlinkedCredentialsFn).toHaveBeenCalled())
      rerender(<FullAccessPanel fullAccess={state} onChange={onChange} />)
      await waitFor(() =>
        expect(getByText(/No unlinked "env" credentials in the vault/)).toBeInTheDocument(),
      )
    })

    it("'Create a new credential' reveals Name/Secret/Account inputs", () => {
      const state = {
        ...emptyFullAccessState(),
        credential: { ...emptyFullAccessState().credential, mode: "new" as const },
      }
      const { getByLabelText } = render(<FullAccessPanel fullAccess={state} onChange={vi.fn()} />)
      expect(getByLabelText("Name")).toBeInTheDocument()
      expect(getByLabelText("Secret")).toBeInTheDocument()
      expect(getByLabelText("Account label")).toBeInTheDocument()
    })

    it("a duplicate-account collision surfaces the explicit use-it/replace recovery, not a silent overwrite", () => {
      const state = {
        ...emptyFullAccessState(),
        credential: {
          ...emptyFullAccessState().credential,
          mode: "new" as const,
          duplicateAccount: "default",
          duplicateCredentialId: "cred-9",
        },
      }
      const { getByText, queryByLabelText } = render(
        <FullAccessPanel fullAccess={state} onChange={vi.fn()} />,
      )
      expect(getByText(/already has a credential on this platform/)).toBeInTheDocument()
      expect(getByText("Use it")).toBeInTheDocument()
      expect(getByText("Replace its secret")).toBeInTheDocument()
      // The replace-secret field is NOT shown until the user explicitly clicks
      // "Replace its secret" — no field pre-filled/auto-submitted.
      expect(queryByLabelText("New secret")).not.toBeInTheDocument()
    })

    it("clicking 'Replace its secret' reveals the inline new-secret field (no redirect, no silent rotate)", () => {
      let state = {
        ...emptyFullAccessState(),
        credential: {
          ...emptyFullAccessState().credential,
          mode: "new" as const,
          duplicateAccount: "default",
          duplicateCredentialId: "cred-9",
        },
      }
      const onChange = vi.fn((next) => {
        state = next
      })
      const { getByText, rerender, getByLabelText } = render(
        <FullAccessPanel fullAccess={state} onChange={onChange} />,
      )
      fireEvent.click(getByText("Replace its secret"))
      rerender(<FullAccessPanel fullAccess={state} onChange={onChange} />)
      expect(getByLabelText("New secret")).toBeInTheDocument()
    })
  })
})
