// SPDX-License-Identifier: AGPL-3.0-only
// useTableView — shared search + column-sort + pagination for every web table
// (inc 26 slice: DRY win over the hand-rolled Credentials pattern). Pure client
// logic, no I/O, no @junction/core import. Consumers own rendering; this hook
// only owns the filter → sort → paginate pipeline and the interaction state.
//
// Search: case-insensitive substring match, trimmed, across caller-supplied
// searchable fields (no fuzzy lib). Sort: click a column header to cycle
// ascending → descending (re-clicking a different column starts ascending).
// Page resets to 1 whenever search or sort changes; page clamps down if the
// underlying data shrinks (e.g. an out-of-band delete).

import { useMemo, useState } from "react"
import type { SortDirection } from "../ui/table.js"

export type { SortDirection }

export interface TableColumn<T> {
  /** Stable id, matches the sort state (pass to toggleSort / sortDirectionFor). */
  readonly key: string
  /** Ascending comparator — negate it yourself for descending is NOT required; the hook negates. */
  readonly compare: (a: T, b: T) => number
}

export interface UseTableViewOptions<T> {
  readonly rows: readonly T[]
  /** Fields to substring-search (case-insensitive). Return the searchable strings for a row. */
  readonly searchFields: (row: T) => (string | undefined)[]
  readonly columns: readonly TableColumn<T>[]
  /** Page size; defaults to 25. */
  readonly pageSize?: number
  readonly initialSortKey?: string
}

export interface UseTableViewResult<T> {
  readonly search: string
  readonly setSearch: (q: string) => void
  readonly sortKey: string | null
  readonly sortDir: SortDirection
  readonly toggleSort: (key: string) => void
  readonly sortDirectionFor: (key: string) => SortDirection
  readonly page: number
  readonly pageCount: number
  readonly setPage: (p: number) => void
  /** Filtered + sorted count (pre-pagination) — feed to TablePagination's `total`. */
  readonly total: number
  /** The final slice to render. */
  readonly pageRows: readonly T[]
  /** Full filtered + sorted rows (pre-paginate) — for callers layering grouping on top (e.g. credentials). */
  readonly filteredSortedRows: readonly T[]
}

const DEFAULT_PAGE_SIZE = 25

export function useTableView<T>({
  rows,
  searchFields,
  columns,
  pageSize = DEFAULT_PAGE_SIZE,
  initialSortKey,
}: UseTableViewOptions<T>): UseTableViewResult<T> {
  const [search, setSearchState] = useState("")
  const [sortKey, setSortKey] = useState<string | null>(initialSortKey ?? null)
  const [sortDir, setSortDir] = useState<SortDirection>(
    initialSortKey !== undefined ? "ascending" : "none",
  )
  const [page, setPageState] = useState(1)

  function setSearch(q: string) {
    setSearchState(q)
    setPageState(1)
  }

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "ascending" ? "descending" : "ascending"))
    } else {
      setSortKey(key)
      setSortDir("ascending")
    }
    setPageState(1)
  }

  function sortDirectionFor(key: string): SortDirection {
    return sortKey === key ? sortDir : "none"
  }

  const columnMap = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => searchFields(row).some((field) => field?.toLowerCase().includes(q)))
  }, [rows, search, searchFields])

  const filteredSortedRows = useMemo(() => {
    const column = sortKey !== null ? columnMap.get(sortKey) : undefined
    if (!column) return filtered
    const items = [...filtered]
    items.sort((a, b) => {
      const cmp = column.compare(a, b)
      return sortDir === "descending" ? -cmp : cmp
    })
    return items
  }, [filtered, sortKey, sortDir, columnMap])

  const total = filteredSortedRows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const clampedPage = Math.min(page, pageCount)
  const pageStart = (clampedPage - 1) * pageSize
  const pageRows = useMemo(
    () => filteredSortedRows.slice(pageStart, pageStart + pageSize),
    [filteredSortedRows, pageStart, pageSize],
  )

  return {
    search,
    setSearch,
    sortKey,
    sortDir,
    toggleSort,
    sortDirectionFor,
    page: clampedPage,
    pageCount,
    setPage: setPageState,
    total,
    pageRows,
    filteredSortedRows,
  }
}
