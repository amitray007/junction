// SPDX-License-Identifier: AGPL-3.0-only
// PolicyPanel tests — focused on the stable-key fix for the path/env repeaters:
// removing a MIDDLE row must keep the remaining rows' own values (not shift
// values up by array index, which is what an index-keyed list would do).

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PolicyPanel } from "./policy-panel.js"
import { emptyEnvAllowRow, emptyPathRow, emptyPolicy } from "./types.js"

afterEach(cleanup)

describe("PolicyPanel — PathRepeater stable keys", () => {
  it("removing a middle read-path row keeps the correct remaining values", () => {
    const policy = {
      ...emptyPolicy(),
      readPaths: [emptyPathRow("/a"), emptyPathRow("/b"), emptyPathRow("/c")],
    }
    const onChange = vi.fn()
    const { getByText } = render(<PolicyPanel toolKey="t1" policy={policy} onChange={onChange} />)

    // Expand the Permissions disclosure.
    fireEvent.click(getByText("Permissions"))

    // Scope to the Read Paths rows specifically (the cwd field shares the same
    // "/absolute/path" placeholder, so a global query would over-match).
    const removeButtons = document.querySelectorAll('button[aria-label="Remove read paths path"]')
    expect(removeButtons.length).toBe(3)
    const rows = Array.from(removeButtons).map((btn) => btn.closest("div"))
    const inputs = rows.map((row) => row?.querySelector("input") as HTMLInputElement)
    expect(inputs.map((i) => i.value)).toEqual(["/a", "/b", "/c"])

    // Remove the middle ("/b") row via its own remove button.
    fireEvent.click(removeButtons[1] as HTMLButtonElement)

    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0]
    // The remaining rows must be exactly /a and /c, in that order — with a
    // stable id an index-keyed regression would instead corrupt input state
    // for /c (React would reuse the DOM node for index 1).
    expect(next.readPaths.map((p: { value: string }) => p.value)).toEqual(["/a", "/c"])
  })

  it("removing a middle env-allow row keeps the correct remaining key/value pairs", () => {
    const policy = {
      ...emptyPolicy(),
      envAllow: [
        emptyEnvAllowRow("FOO", "1"),
        emptyEnvAllowRow("BAR", "2"),
        emptyEnvAllowRow("BAZ", "3"),
      ],
    }
    const onChange = vi.fn()
    const { getByText, getAllByPlaceholderText } = render(
      <PolicyPanel toolKey="t1" policy={policy} onChange={onChange} />,
    )

    fireEvent.click(getByText("Permissions"))
    fireEvent.click(getByText("Static Env Vars"))

    const keyInputs = getAllByPlaceholderText("KEY")
    expect(keyInputs.map((i) => (i as HTMLInputElement).value)).toEqual(["FOO", "BAR", "BAZ"])

    const removeButtons = document.querySelectorAll('button[aria-label="Remove env var"]')
    expect(removeButtons.length).toBe(3)
    fireEvent.click(removeButtons[1] as HTMLButtonElement)

    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0]
    expect(next.envAllow.map((e: { key: string; value: string }) => [e.key, e.value])).toEqual([
      ["FOO", "1"],
      ["BAZ", "3"],
    ])
  })
})
