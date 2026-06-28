// SPDX-License-Identifier: AGPL-3.0-only
// Tests for Button primitive — a11y role, keyboard activation, variants.

import { cleanup, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Button } from "./button.js"

afterEach(() => cleanup())

describe("Button", () => {
  it("renders as a <button> with accessible role", () => {
    const { getByRole } = render(<Button>Save</Button>)
    expect(getByRole("button", { name: "Save" })).toBeInTheDocument()
  })

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const { getByRole } = render(<Button onClick={onClick}>Click me</Button>)
    await user.click(getByRole("button", { name: "Click me" }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("can be activated by keyboard (Enter)", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const { getByRole } = render(<Button onClick={onClick}>Press me</Button>)
    getByRole("button", { name: "Press me" }).focus()
    await user.keyboard("{Enter}")
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("is disabled when disabled prop is set", () => {
    const { getByRole } = render(<Button disabled>Disabled</Button>)
    expect(getByRole("button", { name: "Disabled" })).toBeDisabled()
  })

  it("renders all variants without throwing", () => {
    const variants = ["primary", "secondary", "ghost", "destructive"] as const
    for (const v of variants) {
      const { getByRole, unmount } = render(<Button variant={v}>{v}</Button>)
      expect(getByRole("button", { name: v })).toBeInTheDocument()
      unmount()
    }
  })

  it("renders in dark mode without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { getByRole, unmount } = render(<Button variant="primary">Action</Button>)
    expect(getByRole("button", { name: "Action" })).toBeInTheDocument()
    unmount()
    document.documentElement.removeAttribute("data-theme")
  })
})
