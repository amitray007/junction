// SPDX-License-Identifier: AGPL-3.0-only
// ArgsPanel render tests — declared-arg rows render with their own values, and
// a $name referenced in the command line but not yet declared surfaces a
// "declare it" affordance.

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArgsPanel } from "./args-panel.js"
import type { CliToolArgFormState } from "./types.js"
import { nextKey } from "./types.js"

afterEach(cleanup)

function arg(name: string): CliToolArgFormState {
  return {
    key: nextKey("arg"),
    name,
    description: "",
    type: "string",
    required: false,
    enumValues: [],
    pattern: "",
    maxLength: "",
  }
}

describe("ArgsPanel", () => {
  it("renders one row per declared arg, keyed by name", () => {
    const args = [arg("pattern"), arg("path")]
    const { getByText } = render(
      <ArgsPanel commandLine="/usr/bin/rg $pattern $path" args={args} onChange={vi.fn()} />,
    )
    expect(getByText("$pattern")).toBeInTheDocument()
    expect(getByText("$path")).toBeInTheDocument()
  })

  it("offers to declare a $name referenced in the command line but not yet declared", () => {
    const { getByText } = render(
      <ArgsPanel commandLine="/usr/bin/rg $pattern" args={[]} onChange={vi.fn()} />,
    )
    expect(getByText("Declare it")).toBeInTheDocument()
  })

  it("declaring a missing arg adds it via onChange", () => {
    const onChange = vi.fn()
    const { getByText } = render(
      <ArgsPanel commandLine="/usr/bin/rg $pattern" args={[]} onChange={onChange} />,
    )
    fireEvent.click(getByText("Declare it"))
    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0] as CliToolArgFormState[]
    expect(next).toHaveLength(1)
    expect(next[0]?.name).toBe("pattern")
  })

  it("removing one arg row leaves the other row's own value intact", () => {
    const args = [arg("pattern"), arg("path")]
    const onChange = vi.fn()
    render(<ArgsPanel commandLine="/usr/bin/rg $pattern $path" args={args} onChange={onChange} />)
    const removeButtons = document.querySelectorAll('button[aria-label^="Remove arg"]')
    expect(removeButtons.length).toBe(2)
    fireEvent.click(removeButtons[0] as HTMLButtonElement)
    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0] as CliToolArgFormState[]
    expect(next.map((a) => a.name)).toEqual(["path"])
  })
})
