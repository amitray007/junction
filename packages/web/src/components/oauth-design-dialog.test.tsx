// SPDX-License-Identifier: AGPL-3.0-only
// Tests for CreateDesignDialog (increment 45, Slice D2) — the inc-43
// credentialNameError lesson applied to the design slug: a bad slug must
// surface as an inline Field error BEFORE submit, not a generic toast from a
// server 400. Also covers the tokenUrl-confirmation gate (the exfil-surface
// requirement) and the manual-mode happy path calling addCustomDesignFn.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const mockAddCustomDesignFn = vi.fn()
const mockDiscoverOidcFn = vi.fn()

vi.mock("../server/oauth-design-mutations.functions.js", () => ({
  addCustomDesignFn: (...args: unknown[]) => mockAddCustomDesignFn(...args),
  discoverOidcFn: (...args: unknown[]) => mockDiscoverOidcFn(...args),
}))

const { CreateDesignDialog } = await import("./oauth-design-dialog.js")

afterEach(() => {
  cleanup()
  mockAddCustomDesignFn.mockReset()
  mockDiscoverOidcFn.mockReset()
})

function fillManualForm(getByLabelText: (label: string) => HTMLElement, slug: string) {
  fireEvent.change(getByLabelText("Display name"), { target: { value: "Acme OAuth" } })
  fireEvent.change(getByLabelText("Design id"), { target: { value: slug } })
  fireEvent.change(getByLabelText("Authorization URL"), {
    target: { value: "https://acme.example.com/oauth/authorize" },
  })
  fireEvent.change(getByLabelText("Token URL"), {
    target: { value: "https://acme.example.com/oauth/token" },
  })
}

describe("CreateDesignDialog", () => {
  it("renders when open", () => {
    const { getByRole } = render(
      <CreateDesignDialog open={true} onOpenChange={vi.fn()} onCreated={vi.fn()} />,
    )
    expect(getByRole("dialog")).toBeInTheDocument()
  })

  it("does not render when closed", () => {
    const { queryByRole } = render(
      <CreateDesignDialog open={false} onOpenChange={vi.fn()} onCreated={vi.fn()} />,
    )
    expect(queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("an invalid slug shows an INLINE field error immediately (not a generic toast) and never calls addCustomDesignFn", async () => {
    const { getByLabelText, getByText } = render(
      <CreateDesignDialog open={true} onOpenChange={vi.fn()} onCreated={vi.fn()} />,
    )
    fireEvent.change(getByLabelText("Design id"), { target: { value: "Not A Valid Slug!" } })
    await waitFor(() => expect(getByText(/A lowercase slug/)).toBeInTheDocument())
    expect(mockAddCustomDesignFn).not.toHaveBeenCalled()
  })

  it("submitting without confirming the token URL is refused with an inline message; addCustomDesignFn is never called", async () => {
    const { getByLabelText, getByText } = render(
      <CreateDesignDialog open={true} onOpenChange={vi.fn()} onCreated={vi.fn()} />,
    )
    fillManualForm(getByLabelText, "acme-oauth")
    // Radix Dialog content portals to document.body — not RTL's `container`.
    const form = document.body.querySelector("form")
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)

    await waitFor(() => expect(getByText(/Confirm the token URL/)).toBeInTheDocument())
    expect(mockAddCustomDesignFn).not.toHaveBeenCalled()
  })

  it("a valid slug + confirmed token URL submits addCustomDesignFn with id custom:<slug>", async () => {
    mockAddCustomDesignFn.mockResolvedValue({
      ok: true,
      design: { id: "custom:acme-oauth", displayName: "Acme OAuth" },
    })
    const onCreated = vi.fn()
    const { getByLabelText } = render(
      <CreateDesignDialog open={true} onOpenChange={vi.fn()} onCreated={onCreated} />,
    )
    fillManualForm(getByLabelText, "acme-oauth")

    const confirmCheckbox = document.body.querySelector('input[type="checkbox"]')
    expect(confirmCheckbox).not.toBeNull()
    fireEvent.click(confirmCheckbox as HTMLElement)

    const form = document.body.querySelector("form")
    fireEvent.submit(form as HTMLFormElement)

    await waitFor(() => expect(mockAddCustomDesignFn).toHaveBeenCalledTimes(1))
    const call = mockAddCustomDesignFn.mock.calls[0]?.[0] as { data: { id: string } }
    expect(call.data.id).toBe("custom:acme-oauth")
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it("a server-side rejection (e.g. builtin-collision) surfaces the returned message inline, no throw", async () => {
    mockAddCustomDesignFn.mockResolvedValue({
      ok: false,
      error: '"github" is a built-in Junction design id and can\'t be used for a custom design.',
    })
    const { getByLabelText, getByText } = render(
      <CreateDesignDialog open={true} onOpenChange={vi.fn()} onCreated={vi.fn()} />,
    )
    fillManualForm(getByLabelText, "acme-oauth")
    const confirmCheckbox = document.body.querySelector('input[type="checkbox"]')
    fireEvent.click(confirmCheckbox as HTMLElement)
    const form = document.body.querySelector("form")
    fireEvent.submit(form as HTMLFormElement)

    await waitFor(() => expect(getByText(/built-in Junction design id/)).toBeInTheDocument())
  })
})
