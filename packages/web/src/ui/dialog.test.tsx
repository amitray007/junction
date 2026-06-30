// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the DialogContent outside-interaction guard (isInsideRadixPopper) — the logic
// that keeps the dialog OPEN when a Radix Select option (portaled outside the dialog) is
// clicked, while genuine outside clicks still close it.

import { describe, expect, it } from "vitest"
import { isInsideRadixPopper } from "./dialog.js"

describe("isInsideRadixPopper", () => {
  it("returns false for null", () => {
    expect(isInsideRadixPopper(null)).toBe(false)
  })

  it("returns false for a plain element outside any Radix portal (genuine outside click)", () => {
    const el = document.createElement("div")
    document.body.appendChild(el)
    expect(isInsideRadixPopper(el)).toBe(false)
    el.remove()
  })

  it("returns true for an element inside a radix popper content wrapper", () => {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-radix-popper-content-wrapper", "")
    const option = document.createElement("div")
    wrapper.appendChild(option)
    document.body.appendChild(wrapper)
    expect(isInsideRadixPopper(option)).toBe(true)
    wrapper.remove()
  })

  it("returns true for an element inside a role=listbox (Select content)", () => {
    const listbox = document.createElement("div")
    listbox.setAttribute("role", "listbox")
    const opt = document.createElement("div")
    listbox.appendChild(opt)
    document.body.appendChild(listbox)
    expect(isInsideRadixPopper(opt)).toBe(true)
    listbox.remove()
  })

  it("returns true for an element inside a radix select content portal", () => {
    const content = document.createElement("div")
    content.setAttribute("data-radix-select-content", "")
    document.body.appendChild(content)
    expect(isInsideRadixPopper(content)).toBe(true)
    content.remove()
  })
})
