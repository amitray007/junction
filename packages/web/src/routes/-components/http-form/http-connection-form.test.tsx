// SPDX-License-Identifier: AGPL-3.0-only
// HttpConnectionForm tests — Add Request Tool appends a tool and expands it;
// a single-tool connection can't remove its only tool (floor of one, mirrors
// cli-form's "at least one tool" invariant).

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HttpConnectionForm } from "./http-connection-form.js"
import type { HttpConnectionFormState } from "./types.js"
import { emptyHttpConnection } from "./types.js"

afterEach(cleanup)

describe("HttpConnectionForm", () => {
  it("Add Request Tool appends a new tool to the connection", () => {
    const connection = emptyHttpConnection()
    const onChange = vi.fn()
    const { getByText } = render(<HttpConnectionForm connection={connection} onChange={onChange} />)

    fireEvent.click(getByText("Add Request Tool"))

    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0] as HttpConnectionFormState
    expect(next.tools).toHaveLength(2)
  })

  it("Remove Tool is disabled when only one tool remains", () => {
    const connection = emptyHttpConnection()
    const { getByText } = render(<HttpConnectionForm connection={connection} onChange={vi.fn()} />)
    // The single tool card starts expanded (first tool auto-expands).
    const removeButton = getByText("Remove Tool") as HTMLButtonElement
    expect(removeButton.disabled).toBe(true)
  })

  it("renders the base URL field and reflects its error", () => {
    const connection = emptyHttpConnection()
    const { getByText } = render(
      <HttpConnectionForm
        connection={connection}
        onChange={vi.fn()}
        baseUrlError="Base URL is required"
      />,
    )
    expect(getByText("Base URL is required")).toBeInTheDocument()
  })
})
