// SPDX-License-Identifier: AGPL-3.0-only
// Tests for MonoChip + MonoCode shared inline mono primitives.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MonoChip, MonoCode } from "./code.js"

afterEach(() => cleanup())

describe("MonoChip", () => {
  it("renders children as text", () => {
    const { getByText } = render(<MonoChip>github</MonoChip>)
    expect(getByText("github")).toBeInTheDocument()
  })

  it("renders as a <span>", () => {
    const { container } = render(<MonoChip>gh</MonoChip>)
    expect(container.querySelector("span")).toBeInTheDocument()
  })

  it("carries blue-text color var on the span", () => {
    const { container } = render(<MonoChip>gh</MonoChip>)
    const span = container.querySelector("span") as HTMLElement
    expect(span.style.color).toContain("var(--blue-text)")
  })

  it("carries blue-bg background var on the span", () => {
    const { container } = render(<MonoChip>gh</MonoChip>)
    const span = container.querySelector("span") as HTMLElement
    expect(span.style.backgroundColor).toContain("var(--blue-bg)")
  })

  it("carries mono font var", () => {
    const { container } = render(<MonoChip>openapi</MonoChip>)
    const span = container.querySelector("span") as HTMLElement
    expect(span.style.fontFamily).toContain("var(--font-mono)")
  })

  it("accepts additional className", () => {
    const { container } = render(<MonoChip className="extra-class">x</MonoChip>)
    expect(container.querySelector(".extra-class")).toBeInTheDocument()
  })

  it("allows style override (e.g. larger padding)", () => {
    const { container } = render(<MonoChip style={{ padding: "2px 8px" }}>x</MonoChip>)
    const span = container.querySelector("span") as HTMLElement
    expect(span.style.padding).toBe("2px 8px")
  })
})

describe("MonoCode", () => {
  it("renders children as text", () => {
    const { getByText } = render(<MonoCode>junction mcp serve</MonoCode>)
    expect(getByText("junction mcp serve")).toBeInTheDocument()
  })

  it("renders as a <code> element", () => {
    const { container } = render(<MonoCode>ls</MonoCode>)
    expect(container.querySelector("code")).toBeInTheDocument()
  })

  it("carries gray-900 color var (neutral, no background)", () => {
    const { container } = render(<MonoCode>ls</MonoCode>)
    const code = container.querySelector("code") as HTMLElement
    expect(code.style.color).toContain("var(--gray-900)")
  })

  it("carries mono font var", () => {
    const { container } = render(<MonoCode>ls</MonoCode>)
    const code = container.querySelector("code") as HTMLElement
    expect(code.style.fontFamily).toContain("var(--font-mono)")
  })

  it("allows color override via style prop", () => {
    // CLI hint contexts pass --blue-text to highlight commands.
    const { container } = render(<MonoCode style={{ color: "var(--blue-text)" }}>x</MonoCode>)
    const code = container.querySelector("code") as HTMLElement
    expect(code.style.color).toBe("var(--blue-text)")
  })
})
