// SPDX-License-Identifier: AGPL-3.0-only
// Tests for new table subcomponents introduced in B4 (Phase 1):
// TableGroupRow, TablePagination, EmptyTableRow, sortable TableHead.

import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EmptyTableRow,
  Table,
  TableBody,
  TableGroupRow,
  TableHead,
  TableHeader,
  TablePagination,
  TableRow,
} from "./table.js"

afterEach(() => cleanup())

// ── TableGroupRow ──────────────────────────────────────────────────────────────

describe("TableGroupRow", () => {
  it("renders the group label", () => {
    const { getByText } = render(
      <table>
        <tbody>
          <TableGroupRow colSpan={4} label="GitHub" />
        </tbody>
      </table>,
    )
    expect(getByText("GitHub")).toBeInTheDocument()
  })

  it("renders optional kind chip when provided", () => {
    const { getByText } = render(
      <table>
        <tbody>
          <TableGroupRow colSpan={4} label="GitHub" kind="openapi" />
        </tbody>
      </table>,
    )
    expect(getByText("openapi")).toBeInTheDocument()
  })

  it("renders optional count with the unit word (default 'items')", () => {
    const { getByText } = render(
      <table>
        <tbody>
          <TableGroupRow colSpan={4} label="GitHub" count={3} />
        </tbody>
      </table>,
    )
    expect(getByText("3 items")).toBeInTheDocument()
  })

  it("renders the count with a custom unit", () => {
    const { getByText } = render(
      <table>
        <tbody>
          <TableGroupRow colSpan={4} label="GitHub" count={3} unit="credentials" />
        </tbody>
      </table>,
    )
    expect(getByText("3 credentials")).toBeInTheDocument()
  })

  it("omits kind chip and count when not provided", () => {
    const { queryByText } = render(
      <table>
        <tbody>
          <TableGroupRow colSpan={4} label="Linear" />
        </tbody>
      </table>,
    )
    // No kind/count text beyond the label
    expect(queryByText("openapi")).not.toBeInTheDocument()
    expect(queryByText("0")).not.toBeInTheDocument()
  })

  it("spans all columns via colSpan", () => {
    const { container } = render(
      <table>
        <tbody>
          <TableGroupRow colSpan={5} label="Test" />
        </tbody>
      </table>,
    )
    const td = container.querySelector("td")
    expect(td?.getAttribute("colspan")).toBe("5")
  })
})

// ── TablePagination ────────────────────────────────────────────────────────────

describe("TablePagination", () => {
  it("renders page indicator with current page and total pages", () => {
    const { getByText } = render(
      <TablePagination page={2} pageCount={5} total={50} onPageChange={() => {}} />,
    )
    expect(getByText("2 / 5")).toBeInTheDocument()
  })

  it("renders total count", () => {
    const { getByText } = render(
      <TablePagination page={1} pageCount={3} total={72} onPageChange={() => {}} />,
    )
    expect(getByText("72 total")).toBeInTheDocument()
  })

  it("disables first/prev buttons on page 1", () => {
    const { getByRole } = render(
      <TablePagination page={1} pageCount={5} total={50} onPageChange={() => {}} />,
    )
    expect(getByRole("button", { name: "First page" })).toBeDisabled()
    expect(getByRole("button", { name: "Previous page" })).toBeDisabled()
    expect(getByRole("button", { name: "Next page" })).not.toBeDisabled()
    expect(getByRole("button", { name: "Last page" })).not.toBeDisabled()
  })

  it("disables next/last buttons on the last page", () => {
    const { getByRole } = render(
      <TablePagination page={5} pageCount={5} total={50} onPageChange={() => {}} />,
    )
    expect(getByRole("button", { name: "First page" })).not.toBeDisabled()
    expect(getByRole("button", { name: "Previous page" })).not.toBeDisabled()
    expect(getByRole("button", { name: "Next page" })).toBeDisabled()
    expect(getByRole("button", { name: "Last page" })).toBeDisabled()
  })

  it("calls onPageChange with the next page on Next click", () => {
    const onPageChange = vi.fn()
    const { getByRole } = render(
      <TablePagination page={2} pageCount={5} total={50} onPageChange={onPageChange} />,
    )
    fireEvent.click(getByRole("button", { name: "Next page" }))
    expect(onPageChange).toHaveBeenCalledWith(3)
  })

  it("calls onPageChange with the previous page on Prev click", () => {
    const onPageChange = vi.fn()
    const { getByRole } = render(
      <TablePagination page={3} pageCount={5} total={50} onPageChange={onPageChange} />,
    )
    fireEvent.click(getByRole("button", { name: "Previous page" }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it("calls onPageChange(1) on First click", () => {
    const onPageChange = vi.fn()
    const { getByRole } = render(
      <TablePagination page={4} pageCount={5} total={50} onPageChange={onPageChange} />,
    )
    fireEvent.click(getByRole("button", { name: "First page" }))
    expect(onPageChange).toHaveBeenCalledWith(1)
  })

  it("calls onPageChange(pageCount) on Last click", () => {
    const onPageChange = vi.fn()
    const { getByRole } = render(
      <TablePagination page={2} pageCount={7} total={70} onPageChange={onPageChange} />,
    )
    fireEvent.click(getByRole("button", { name: "Last page" }))
    expect(onPageChange).toHaveBeenCalledWith(7)
  })

  it("all pagination buttons are keyboard-reachable (button elements)", () => {
    const { getAllByRole } = render(
      <TablePagination page={3} pageCount={5} total={50} onPageChange={() => {}} />,
    )
    const btns = getAllByRole("button")
    expect(btns.length).toBe(4) // first, prev, next, last
    for (const btn of btns) {
      expect(btn.tagName).toBe("BUTTON")
    }
  })
})

// ── EmptyTableRow ──────────────────────────────────────────────────────────────

describe("EmptyTableRow", () => {
  it("renders the empty message", () => {
    const { getByText } = render(
      <table>
        <tbody>
          <EmptyTableRow colSpan={4} message="No credentials yet." />
        </tbody>
      </table>,
    )
    expect(getByText("No credentials yet.")).toBeInTheDocument()
  })

  it("renders optional action alongside the message", () => {
    const { getByRole } = render(
      <table>
        <tbody>
          <EmptyTableRow
            colSpan={4}
            message="No items."
            action={<button type="button">Add Item</button>}
          />
        </tbody>
      </table>,
    )
    expect(getByRole("button", { name: "Add Item" })).toBeInTheDocument()
  })

  it("spans all columns via colSpan", () => {
    const { container } = render(
      <table>
        <tbody>
          <EmptyTableRow colSpan={6} message="Empty" />
        </tbody>
      </table>,
    )
    const td = container.querySelector("td")
    expect(td?.getAttribute("colspan")).toBe("6")
  })
})

// ── Sortable TableHead ─────────────────────────────────────────────────────────

describe("TableHead (sortable)", () => {
  it("renders a button inside the th when onSort is provided", () => {
    const { getByRole } = render(
      <table>
        <thead>
          <TableRow>
            <TableHead onSort={() => {}} sortDirection="none">
              Name
            </TableHead>
          </TableRow>
        </thead>
      </table>,
    )
    expect(getByRole("button")).toBeInTheDocument()
    expect(getByRole("button").textContent).toContain("Name")
  })

  it("sets aria-sort='ascending' on the th when sortDirection is ascending", () => {
    const { container } = render(
      <table>
        <thead>
          <TableRow>
            <TableHead onSort={() => {}} sortDirection="ascending">
              Name
            </TableHead>
          </TableRow>
        </thead>
      </table>,
    )
    const th = container.querySelector("th")
    expect(th?.getAttribute("aria-sort")).toBe("ascending")
  })

  it("sets aria-sort='descending' when sortDirection is descending", () => {
    const { container } = render(
      <table>
        <thead>
          <TableRow>
            <TableHead onSort={() => {}} sortDirection="descending">
              Name
            </TableHead>
          </TableRow>
        </thead>
      </table>,
    )
    const th = container.querySelector("th")
    expect(th?.getAttribute("aria-sort")).toBe("descending")
  })

  it("calls onSort when the button is clicked", () => {
    const onSort = vi.fn()
    const { getByRole } = render(
      <table>
        <thead>
          <TableRow>
            <TableHead onSort={onSort} sortDirection="none">
              Name
            </TableHead>
          </TableRow>
        </thead>
      </table>,
    )
    fireEvent.click(getByRole("button"))
    expect(onSort).toHaveBeenCalledOnce()
  })

  it("renders a plain th (no button) when onSort is not provided", () => {
    const { queryByRole } = render(
      <table>
        <thead>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </thead>
      </table>,
    )
    expect(queryByRole("button")).not.toBeInTheDocument()
  })

  it("renders inside a full Table without errors", () => {
    const onSort = vi.fn()
    const { getByRole } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead onSort={onSort} sortDirection="none">
              Account
            </TableHead>
            <TableHead>Kind</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody />
      </Table>,
    )
    expect(getByRole("table")).toBeInTheDocument()
    expect(getByRole("button")).toBeInTheDocument()
  })
})
