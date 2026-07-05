// SPDX-License-Identifier: AGPL-3.0-only
// HttpToolCard tests — the live path↔param mismatch hint: a {placeholder} in
// the path with no matching in:"path" param surfaces a "declare it" affordance
// (via HttpParamsPanel's missingPathParams prop), and a declared in:"path"
// param not referenced by any {placeholder} surfaces an orphaned-param notice.

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HttpToolCard, pathPlaceholders } from "./http-tool-card.js"
import type { HttpToolFormState } from "./types.js"
import { emptyHttpTool } from "./types.js"

afterEach(cleanup)

describe("pathPlaceholders", () => {
  it("extracts {name} placeholders in order of first appearance, deduplicated", () => {
    expect(pathPlaceholders("/repos/{owner}/{repo}/issues/{owner}")).toEqual(["owner", "repo"])
  })

  it("returns an empty array for a path with no placeholders", () => {
    expect(pathPlaceholders("/health")).toEqual([])
  })
})

function tool(overrides: Partial<HttpToolFormState> = {}): HttpToolFormState {
  return { ...emptyHttpTool(), ...overrides }
}

describe("HttpToolCard", () => {
  it("surfaces a declare-it hint when the path references an undeclared path param", () => {
    const t = tool({ path: "/repos/{owner}/{repo}", params: [] })
    const { getByText } = render(
      <HttpToolCard
        tool={t}
        index={0}
        expanded={true}
        onToggle={vi.fn()}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        canRemove={true}
      />,
    )
    expect(getByText("{owner}")).toBeInTheDocument()
    expect(getByText("{repo}")).toBeInTheDocument()
  })

  it("surfaces an orphaned-param notice when a path param isn't referenced in the path", () => {
    const t = tool({
      path: "/repos",
      params: [
        {
          key: "p1",
          name: "owner",
          in: "path",
          type: "string",
          required: true,
          description: "",
          enumValues: [],
          pattern: "",
          maxLength: "",
        },
      ],
    })
    const { getByText } = render(
      <HttpToolCard
        tool={t}
        index={0}
        expanded={true}
        onToggle={vi.fn()}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        canRemove={true}
      />,
    )
    expect(getByText(/declared but not/)).toBeInTheDocument()
  })

  it("declaring a missing path param via the panel updates the tool's params", () => {
    const t = tool({ path: "/repos/{owner}", params: [] })
    const onChange = vi.fn()
    const { getByText } = render(
      <HttpToolCard
        tool={t}
        index={0}
        expanded={true}
        onToggle={vi.fn()}
        onChange={onChange}
        onRemove={vi.fn()}
        canRemove={true}
      />,
    )
    fireEvent.click(getByText("Declare it"))
    expect(onChange).toHaveBeenCalledOnce()
    const next = onChange.mock.calls[0]?.[0] as HttpToolFormState
    expect(next.params).toHaveLength(1)
    expect(next.params[0]).toMatchObject({ name: "owner", in: "path" })
  })

  it("collapsed (not expanded) renders only the summary header, no fields", () => {
    const t = tool({ name: "listIssues", method: "GET", path: "/repos" })
    const { queryByLabelText, getByText } = render(
      <HttpToolCard
        tool={t}
        index={0}
        expanded={false}
        onToggle={vi.fn()}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        canRemove={true}
      />,
    )
    expect(getByText("listIssues")).toBeInTheDocument()
    expect(getByText("GET /repos")).toBeInTheDocument()
    expect(queryByLabelText("Required")).not.toBeInTheDocument()
  })
})
