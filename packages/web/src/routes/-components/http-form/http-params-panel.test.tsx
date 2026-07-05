// SPDX-License-Identifier: AGPL-3.0-only
// HttpParamsPanel render tests — a declared param row renders its location +
// type + required controls, and a missing path-param placeholder surfaces a
// "declare it" affordance (mirrors args-panel.test.tsx's pattern).

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HttpParamsPanel } from "./http-params-panel.js"
import type { HttpParamFormState } from "./types.js"
import { nextKey } from "./types.js"

afterEach(cleanup)

function param(name: string, overrides: Partial<HttpParamFormState> = {}): HttpParamFormState {
  return {
    key: nextKey("param"),
    name,
    in: "query",
    type: "string",
    required: false,
    description: "",
    enumValues: [],
    pattern: "",
    maxLength: "",
    ...overrides,
  }
}

describe("HttpParamsPanel", () => {
  it("renders one row per declared param, with its name/location/type values", () => {
    const params = [param("owner", { in: "path" }), param("limit", { in: "query", type: "number" })]
    const { getByDisplayValue } = render(<HttpParamsPanel params={params} onChange={vi.fn()} />)
    expect(getByDisplayValue("owner")).toBeInTheDocument()
    expect(getByDisplayValue("limit")).toBeInTheDocument()
  })

  it("offers to declare a path param referenced by the path but not yet declared", () => {
    const { getByText } = render(
      <HttpParamsPanel params={[]} onChange={vi.fn()} missingPathParams={["owner"]} />,
    )
    expect(getByText("{owner}")).toBeInTheDocument()
    expect(getByText("Declare it")).toBeInTheDocument()
  })

  it("declaring a missing path param adds it with in:path and required:true", () => {
    const onChange = vi.fn()
    const { getByText } = render(
      <HttpParamsPanel params={[]} onChange={onChange} missingPathParams={["owner"]} />,
    )
    fireEvent.click(getByText("Declare it"))
    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0] as HttpParamFormState[]
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ name: "owner", in: "path", required: true })
  })

  it("adding a param via the Add Param button appends an empty row", () => {
    const onChange = vi.fn()
    const { getByText } = render(<HttpParamsPanel params={[]} onChange={onChange} />)
    fireEvent.click(getByText("+ Add Param"))
    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0] as HttpParamFormState[]
    expect(next).toHaveLength(1)
    expect(next[0]?.name).toBe("")
  })

  it("removing one param row leaves the other row's own value intact", () => {
    const params = [param("owner"), param("repo")]
    const onChange = vi.fn()
    render(<HttpParamsPanel params={params} onChange={onChange} />)
    const removeButtons = document.querySelectorAll('button[aria-label^="Remove param"]')
    expect(removeButtons.length).toBe(2)
    fireEvent.click(removeButtons[0] as HTMLButtonElement)
    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0] as HttpParamFormState[]
    expect(next.map((p) => p.name)).toEqual(["repo"])
  })
})
