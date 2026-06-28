// SPDX-License-Identifier: AGPL-3.0-only
// Form primitives tests — Input, Field, Select, Switch, Checkbox.
// Tests: label association, error announce, a11y role/name, dark mode render.
// These primitives are built in inc 23 and NOT wired to write paths (inc 24+).

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Checkbox } from "./checkbox.js"
import { Field } from "./field.js"
import { Input } from "./input.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js"
import { Switch } from "./switch.js"
import { TooltipProvider } from "./tooltip.js"

afterEach(() => {
  cleanup()
})

// ── Input ─────────────────────────────────────────────────────────────────────

describe("Input", () => {
  it("renders a text input", () => {
    render(<Input id="test" aria-label="Test input" />)
    expect(screen.getByRole("textbox", { name: "Test input" })).toBeInTheDocument()
  })

  it("sets aria-invalid when hasError is true", () => {
    render(<Input id="test" aria-label="Test input" hasError />)
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true")
  })

  it("does not set aria-invalid when hasError is false", () => {
    render(<Input id="test" aria-label="Test input" hasError={false} />)
    const input = screen.getByRole("textbox")
    expect(input).not.toHaveAttribute("aria-invalid")
  })

  it("renders in dark mode without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => render(<Input id="test" aria-label="Dark input" />)).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})

// ── Field ─────────────────────────────────────────────────────────────────────

describe("Field", () => {
  it("associates label with control via htmlFor", () => {
    render(
      <Field id="name" label="Full name">
        <Input id="name" />
      </Field>,
    )
    const label = screen.getByText("Full name")
    expect(label.tagName).toBe("LABEL")
    expect(label).toHaveAttribute("for", "name")
  })

  it("renders description text", () => {
    render(
      <Field id="email" label="Email" description="We'll never share your email.">
        <Input id="email" type="email" />
      </Field>,
    )
    expect(screen.getByText("We'll never share your email.")).toBeInTheDocument()
  })

  it("renders inline error with role=alert", () => {
    render(
      <Field id="pw" label="Password" error="Password is too short">
        <Input id="pw" type="password" />
      </Field>,
    )
    const error = screen.getByRole("alert")
    expect(error).toHaveTextContent("Password is too short")
  })

  it("error element has id that matches the aria-describedby contract", () => {
    // Field renders the error with id="${id}-error" which the cloneElement injection
    // passes to the control as aria-describedby. Verify the error node has the right id
    // so the association is possible — the injection is verified separately in SSR.
    const { container } = render(
      <Field id="email-check" label="Email" error="Invalid email address">
        <Input id="email-check" type="email" />
      </Field>,
    )
    const errorEl = container.querySelector<HTMLElement>("[role='alert']")
    expect(errorEl).not.toBeNull()
    expect(errorEl?.id).toBe("email-check-error")
    expect(errorEl?.textContent).toBe("Invalid email address")
    // The input exists in the same Field container
    const input = container.querySelector<HTMLInputElement>("#email-check")
    expect(input).not.toBeNull()
  })

  it("renders in dark mode without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() =>
      render(
        <Field id="dark-field" label="Dark label">
          <Input id="dark-field" />
        </Field>,
      ),
    ).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})

// ── Select ────────────────────────────────────────────────────────────────────

describe("Select", () => {
  it("renders a combobox trigger", () => {
    render(
      <TooltipProvider>
        <Select>
          <SelectTrigger aria-label="Choose option">
            <SelectValue placeholder="Pick one" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Option A</SelectItem>
          </SelectContent>
        </Select>
      </TooltipProvider>,
    )
    expect(screen.getByRole("combobox", { name: "Choose option" })).toBeInTheDocument()
  })

  it("renders in dark mode without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() =>
      render(
        <Select>
          <SelectTrigger aria-label="Dark select">
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
        </Select>,
      ),
    ).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})

// ── Switch ────────────────────────────────────────────────────────────────────

describe("Switch", () => {
  it("renders with role=switch", () => {
    render(<Switch aria-label="Enable feature" />)
    expect(screen.getByRole("switch", { name: "Enable feature" })).toBeInTheDocument()
  })

  it("starts unchecked by default", () => {
    render(<Switch aria-label="Toggle" />)
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "unchecked")
  })

  it("starts checked when defaultChecked=true", () => {
    render(<Switch aria-label="Toggle" defaultChecked />)
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked")
  })

  it("renders in dark mode without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => render(<Switch aria-label="Dark switch" />)).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})

// ── Checkbox ──────────────────────────────────────────────────────────────────

describe("Checkbox", () => {
  it("renders with role=checkbox", () => {
    render(<Checkbox aria-label="Accept terms" />)
    expect(screen.getByRole("checkbox", { name: "Accept terms" })).toBeInTheDocument()
  })

  it("starts unchecked by default", () => {
    render(<Checkbox aria-label="Terms" />)
    expect(screen.getByRole("checkbox")).toHaveAttribute("data-state", "unchecked")
  })

  it("starts checked when defaultChecked=true", () => {
    render(<Checkbox aria-label="Terms" defaultChecked />)
    expect(screen.getByRole("checkbox")).toHaveAttribute("data-state", "checked")
  })

  it("renders in dark mode without errors", () => {
    document.documentElement.setAttribute("data-theme", "dark")
    expect(() => render(<Checkbox aria-label="Dark checkbox" />)).not.toThrow()
    document.documentElement.removeAttribute("data-theme")
  })
})
