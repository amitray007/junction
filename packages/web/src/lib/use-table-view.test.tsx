// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for useTableView — search/sort/pagination pipeline in isolation
// (no DOM needed; renderHook is enough). See -*.test.tsx route tests for the
// wired-up rendering behaviour.

import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { type TableColumn, useTableView } from "./use-table-view.js"

interface Row {
  id: string
  name: string
  count: number
}

const rows: Row[] = [
  { id: "r1", name: "Charlie", count: 3 },
  { id: "r2", name: "alice", count: 1 },
  { id: "r3", name: "Bob", count: 2 },
]

const columns: TableColumn<Row>[] = [
  { key: "name", compare: (a, b) => a.name.localeCompare(b.name) },
  { key: "count", compare: (a, b) => a.count - b.count },
]

function setup(overrides: Partial<Parameters<typeof useTableView<Row>>[0]> = {}) {
  return renderHook(() =>
    useTableView<Row>({
      rows,
      searchFields: (r) => [r.id, r.name],
      columns,
      ...overrides,
    }),
  )
}

describe("useTableView", () => {
  it("returns all rows when search is empty", () => {
    const { result } = setup()
    expect(result.current.pageRows.map((r) => r.id)).toEqual(["r1", "r2", "r3"])
    expect(result.current.total).toBe(3)
  })

  it("filters case-insensitively across searchFields", () => {
    const { result } = setup()
    act(() => result.current.setSearch("ALICE"))
    expect(result.current.pageRows.map((r) => r.id)).toEqual(["r2"])
  })

  it("filters by substring, trimmed", () => {
    const { result } = setup()
    act(() => result.current.setSearch("  ob  "))
    expect(result.current.pageRows.map((r) => r.id)).toEqual(["r3"])
  })

  it("empty query (whitespace only) returns all rows", () => {
    const { result } = setup()
    act(() => result.current.setSearch("   "))
    expect(result.current.total).toBe(3)
  })

  it("sortDirectionFor returns 'none' before any sort", () => {
    const { result } = setup()
    expect(result.current.sortDirectionFor("name")).toBe("none")
    expect(result.current.sortKey).toBeNull()
  })

  it("toggleSort sorts ascending on first click via the column comparator", () => {
    const { result } = setup()
    act(() => result.current.toggleSort("name"))
    expect(result.current.sortDirectionFor("name")).toBe("ascending")
    expect(result.current.pageRows.map((r) => r.name)).toEqual(["alice", "Bob", "Charlie"])
  })

  it("toggleSort on the same key flips to descending", () => {
    const { result } = setup()
    act(() => result.current.toggleSort("name"))
    act(() => result.current.toggleSort("name"))
    expect(result.current.sortDirectionFor("name")).toBe("descending")
    expect(result.current.pageRows.map((r) => r.name)).toEqual(["Charlie", "Bob", "alice"])
  })

  it("toggleSort on a new key resets to ascending on that key", () => {
    const { result } = setup()
    act(() => result.current.toggleSort("name"))
    act(() => result.current.toggleSort("name")) // descending
    act(() => result.current.toggleSort("count")) // switch column
    expect(result.current.sortDirectionFor("count")).toBe("ascending")
    expect(result.current.sortDirectionFor("name")).toBe("none")
    expect(result.current.pageRows.map((r) => r.count)).toEqual([1, 2, 3])
  })

  it("resets page to 1 when search changes", () => {
    const { result } = setup({ pageSize: 1 })
    act(() => result.current.setPage(2))
    expect(result.current.page).toBe(2)
    act(() => result.current.setSearch("bob"))
    expect(result.current.page).toBe(1)
  })

  it("resets page to 1 when sort changes", () => {
    const { result } = setup({ pageSize: 1 })
    act(() => result.current.setPage(3))
    expect(result.current.page).toBe(3)
    act(() => result.current.toggleSort("name"))
    expect(result.current.page).toBe(1)
  })

  it("paginates: pageSize=1 slices to one row per page, pageCount reflects total", () => {
    const { result } = setup({ pageSize: 1 })
    expect(result.current.pageCount).toBe(3)
    expect(result.current.pageRows.length).toBe(1)
    act(() => result.current.setPage(2))
    expect(result.current.pageRows[0]?.id).toBe(rows[1]?.id)
  })

  it("clamps page down when the filtered set shrinks (out-of-band delete / search)", () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: Row[] }) =>
        useTableView<Row>({
          rows: data,
          searchFields: (r) => [r.id, r.name],
          columns,
          pageSize: 1,
        }),
      { initialProps: { data: rows } },
    )
    act(() => result.current.setPage(3))
    expect(result.current.page).toBe(3)
    rerender({ data: [rows[0] as Row] })
    expect(result.current.page).toBe(1)
    expect(result.current.pageCount).toBe(1)
  })

  it("filteredSortedRows exposes the full pre-pagination sorted list (for grouping callers)", () => {
    const { result } = setup({ pageSize: 1 })
    act(() => result.current.toggleSort("name"))
    expect(result.current.filteredSortedRows.map((r) => r.name)).toEqual([
      "alice",
      "Bob",
      "Charlie",
    ])
    // pageRows is just the first slice
    expect(result.current.pageRows.map((r) => r.name)).toEqual(["alice"])
  })

  // ── predicate (facet pre-filter) ──────────────────────────────────────────

  it("no predicate: all rows pass (baseline, same as omitting the option)", () => {
    const { result } = setup()
    expect(result.current.pageRows.map((r) => r.id)).toEqual(["r1", "r2", "r3"])
  })

  it("predicate alone narrows rows without any search term", () => {
    const { result } = setup({ predicate: (r) => r.count >= 2 })
    expect(result.current.pageRows.map((r) => r.id).sort()).toEqual(["r1", "r3"])
  })

  it("predicate composes with search as AND", () => {
    // Only rows with count >= 2 AND name containing "b" (case-insensitive).
    const { result } = setup({ predicate: (r) => r.count >= 2 })
    act(() => result.current.setSearch("bob"))
    expect(result.current.pageRows.map((r) => r.id)).toEqual(["r3"])
  })

  it("predicate excluding everything yields zero rows even with a matching search", () => {
    const { result } = setup({ predicate: () => false })
    act(() => result.current.setSearch("alice"))
    expect(result.current.total).toBe(0)
  })
})
