// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the shared connection-lifecycle dialogs (RotateSecretDialog,
// EditAccountLabelDialog, DisconnectDialog) — extracted from credentials.tsx
// and app.$id.tsx (inc 30 jscpd dedupe). Mutation server-fns are mocked so
// happy-dom never calls getRequest() / DB (same strategy as the route tests).

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectionTarget } from "./connection-dialogs.js"

const mockRotateCredentialFn = vi.fn()
const mockRenameCredentialFn = vi.fn()
const mockRemoveCredentialFn = vi.fn()

vi.mock("../server/mutations.functions.js", () => ({
  rotateCredentialFn: (...args: unknown[]) => mockRotateCredentialFn(...args),
  renameCredentialFn: (...args: unknown[]) => mockRenameCredentialFn(...args),
  removeCredentialFn: (...args: unknown[]) => mockRemoveCredentialFn(...args),
}))

const { RotateSecretDialog, EditAccountLabelDialog, DisconnectDialog } = await import(
  "./connection-dialogs.js"
)

const target: ConnectionTarget = { credentialId: "c1", account: "alice" }
const targetWithPlatform: ConnectionTarget = {
  credentialId: "c1",
  account: "alice",
  platformId: "github",
}

afterEach(() => {
  cleanup()
  mockRotateCredentialFn.mockReset()
  mockRenameCredentialFn.mockReset()
  mockRemoveCredentialFn.mockReset()
})

// ---------------------------------------------------------------------------
// RotateSecretDialog
// ---------------------------------------------------------------------------

describe("RotateSecretDialog", () => {
  it("renders when target is set", () => {
    const { getByRole } = render(
      <RotateSecretDialog target={target} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(getByRole("dialog")).toBeInTheDocument()
    expect(getByRole("heading", { name: "Rotate Credential" })).toBeInTheDocument()
  })

  it("does not render when target is null", () => {
    const { queryByRole } = render(
      <RotateSecretDialog target={null} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("validates a non-empty secret before calling rotateCredentialFn", async () => {
    const { getByRole, getByText } = render(
      <RotateSecretDialog target={target} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    fireEvent.click(getByRole("dialog").querySelector("button[type='submit']") as HTMLElement)
    await waitFor(() => expect(getByText("New secret is required")).toBeInTheDocument())
    expect(mockRotateCredentialFn).not.toHaveBeenCalled()
  })

  it("submits the new secret to rotateCredentialFn with the target's credentialId", async () => {
    mockRotateCredentialFn.mockResolvedValue({ ok: true })
    const onSuccess = vi.fn()
    const { getByLabelText, getByRole } = render(
      <RotateSecretDialog target={target} onOpenChange={vi.fn()} onSuccess={onSuccess} />,
    )
    fireEvent.change(getByLabelText("New secret"), { target: { value: "new-secret" } })
    fireEvent.click(getByRole("dialog").querySelector("button[type='submit']") as HTMLElement)

    await waitFor(() => expect(mockRotateCredentialFn).toHaveBeenCalled())
    expect(mockRotateCredentialFn).toHaveBeenCalledWith({
      data: { credentialId: "c1", newSecret: "new-secret" },
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it("renders the platform in the description when the target carries a platformId", () => {
    const { getByText } = render(
      <RotateSecretDialog target={targetWithPlatform} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(getByText("github")).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// EditAccountLabelDialog
// ---------------------------------------------------------------------------

describe("EditAccountLabelDialog", () => {
  it("renders when target is set and pre-fills the current account", () => {
    const { getByRole, getByLabelText } = render(
      <EditAccountLabelDialog target={target} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(getByRole("dialog")).toBeInTheDocument()
    expect((getByLabelText("Account label") as HTMLInputElement).value).toBe("alice")
  })

  it("does not render when target is null", () => {
    const { queryByRole } = render(
      <EditAccountLabelDialog target={null} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("validates a non-empty label before calling renameCredentialFn", async () => {
    const { getByLabelText, getByRole, getByText } = render(
      <EditAccountLabelDialog target={target} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    fireEvent.change(getByLabelText("Account label"), { target: { value: "   " } })
    fireEvent.click(getByRole("dialog").querySelector("button[type='submit']") as HTMLElement)

    await waitFor(() => expect(getByText("Account label is required")).toBeInTheDocument())
    expect(mockRenameCredentialFn).not.toHaveBeenCalled()
  })

  it("submits the trimmed new label to renameCredentialFn", async () => {
    mockRenameCredentialFn.mockResolvedValue({ ok: true })
    const onSuccess = vi.fn()
    const { getByLabelText, getByRole } = render(
      <EditAccountLabelDialog target={target} onOpenChange={vi.fn()} onSuccess={onSuccess} />,
    )
    fireEvent.change(getByLabelText("Account label"), { target: { value: "  alice-2  " } })
    fireEvent.click(getByRole("dialog").querySelector("button[type='submit']") as HTMLElement)

    await waitFor(() => expect(mockRenameCredentialFn).toHaveBeenCalled())
    expect(mockRenameCredentialFn).toHaveBeenCalledWith({
      data: { credentialId: "c1", account: "alice-2" },
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it("mentions the platform in the description when the target carries a platformId", () => {
    const { getByText } = render(
      <EditAccountLabelDialog
        target={targetWithPlatform}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    )
    expect(getByText("github")).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// DisconnectDialog
// ---------------------------------------------------------------------------

describe("DisconnectDialog", () => {
  it("renders 'Disconnect' copy by default", () => {
    const { getByRole } = render(
      <DisconnectDialog target={target} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(getByRole("heading", { name: "Disconnect" })).toBeInTheDocument()
    expect(getByRole("button", { name: "Disconnect" })).toBeInTheDocument()
  })

  it("does not render when target is null", () => {
    const { queryByRole } = render(
      <DisconnectDialog target={null} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("renders 'Delete Credential' copy when copy='delete'", () => {
    const { getByRole } = render(
      <DisconnectDialog target={target} copy="delete" onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    )
    expect(getByRole("heading", { name: "Delete Credential" })).toBeInTheDocument()
    expect(getByRole("button", { name: "Delete Credential" })).toBeInTheDocument()
  })

  it("confirming calls removeCredentialFn with the target's credentialId and onSuccess on success", async () => {
    mockRemoveCredentialFn.mockResolvedValue({ ok: true })
    const onSuccess = vi.fn()
    const { getByRole } = render(
      <DisconnectDialog target={target} onOpenChange={vi.fn()} onSuccess={onSuccess} />,
    )
    fireEvent.click(getByRole("button", { name: "Disconnect" }))

    await waitFor(() => expect(mockRemoveCredentialFn).toHaveBeenCalled())
    expect(mockRemoveCredentialFn).toHaveBeenCalledWith({ data: { credentialId: "c1" } })
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
  })

  it("a failed removeCredentialFn result keeps the dialog open (no onSuccess)", async () => {
    mockRemoveCredentialFn.mockResolvedValue({ ok: false, error: "boom" })
    const onSuccess = vi.fn()
    const onOpenChange = vi.fn()
    const { getByRole } = render(
      <DisconnectDialog target={target} onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    )
    fireEvent.click(getByRole("button", { name: "Disconnect" }))

    await waitFor(() => expect(mockRemoveCredentialFn).toHaveBeenCalled())
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
