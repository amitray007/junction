// SPDX-License-Identifier: AGPL-3.0-only
// Tests for Textarea primitive — a11y role, value/onChange, error state, dark mode.

import { cleanup, render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Textarea } from "./textarea.js"

afterEach(() => cleanup())

describe("Textarea", () => {
  it("renders as a <textarea> with accessible role", () => {
    const { getByRole } = render(<Textarea aria-label="Notes" />)
    expect(getByRole("textbox", { name: "Notes" }).tagName).toBe("TEXTAREA")
  })

  it("calls onChange as the user types", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { getByRole } = render(<Textarea aria-label="Notes" onChange={onChange} />)
    await user.type(getByRole("textbox", { name: "Notes" }), "hi")
    expect(onChange).toHaveBeenCalled()
  })

  it("sets aria-invalid when hasError is true", () => {
    const { getByRole } = render(<Textarea aria-label="Notes" hasError />)
    expect(getByRole("textbox", { name: "Notes" })).toHaveAttribute("aria-invalid", "true")
  })

  it("is disabled when disabled prop is set", () => {
    const { getByRole } = render(<Textarea aria-label="Notes" disabled />)
    expect(getByRole("textbox", { name: "Notes" })).toBeDisabled()
  })

  it("renders in dark mode without error", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    const { getByRole, unmount } = render(<Textarea aria-label="Notes" />)
    expect(getByRole("textbox", { name: "Notes" })).toBeInTheDocument()
    unmount()
    document.documentElement.removeAttribute("data-theme")
  })
})
