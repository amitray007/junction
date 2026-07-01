// SPDX-License-Identifier: AGPL-3.0-only
// Credentials route — flat paginated table with platform group-dividers (Variant C, F12).
// Replaces the grouped-card layout (inc-24.5) with ONE table: columns ID · Platform ·
// Account · Kind (true: bearer) · Status · ⋯, group-divider rows per platform, search,
// sort (Platform/Account), and a TablePagination footer (page size 25).
// The inc-24 add/rotate/delete mutations stay wired unchanged.
// No @junction/core import. Secret is input-only; never rendered or returned.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Plus, RefreshCw, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import type { TableColumn } from "../lib/use-table-view.js"
import { useTableView } from "../lib/use-table-view.js"
import type { CredentialMeta, PlatformMeta } from "../server/data.functions.js"
import { getCredentials, getPlatforms } from "../server/data.functions.js"
import {
  addCredentialFn,
  removeCredentialFn,
  rotateCredentialFn,
} from "../server/mutations.functions.js"
import { MonoCode } from "../ui/code.js"
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogFormFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  EmptyTableRow,
  FacetSelect,
  Field,
  Input,
  PageHeader,
  RefreshButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Table,
  TableActionsCell,
  TableActionsHead,
  TableBody,
  TableCell,
  TableCellMono,
  TableGroupRow,
  TableHead,
  TableHeader,
  TablePagination,
  TableRow,
  TableSkeleton,
} from "../ui/index.js"

export const Route = createFileRoute("/credentials")({
  loader: async () => {
    const [credentials, platforms] = await Promise.all([getCredentials(), getPlatforms()])
    return { credentials, platforms }
  },
  pendingComponent: CredentialsPending,
  component: CredentialsPage,
})

// All stored credential kinds mean the credential was added successfully.
// Show "Configured" — neutral, no liveness claim — until inc 28 adds live probing.
function kindToStatus(_kind: string): "configured" {
  return "configured"
}

// Page size for the paginated table (F12). 25 rows is comfortable for the seed (10)
// and leaves room as the credential list grows.
const PAGE_SIZE = 25

// Number of columns in the flat table — used for colSpan on group-divider + empty rows.
const COL_COUNT = 6

function CredentialsPending() {
  return (
    <div>
      <PageHeader title="Credentials" />
      <TableSkeleton
        rows={4}
        columns={[
          { width: "w-40" },
          { width: "w-32" },
          { flex: true },
          { width: "w-24" },
          { width: "w-20" },
          { width: "w-8" },
        ]}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared password field
// ---------------------------------------------------------------------------

interface SecretFieldProps {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (v: string) => void
  readonly error?: string
  readonly placeholder?: string
}

function SecretField({ id, label, value, onChange, error, placeholder }: SecretFieldProps) {
  return (
    <Field id={id} label={label} error={error}>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        hasError={!!error}
        aria-required="true"
        placeholder={placeholder}
      />
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Add credential dialog
// ---------------------------------------------------------------------------

interface AddDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly platforms: Array<{ id: string; displayName: string }>
  readonly onSuccess: () => void
}

function AddCredentialDialog({ open, onOpenChange, platforms, onSuccess }: AddDialogProps) {
  const [platformId, setPlatformId] = useState("")
  const [account, setAccount] = useState("")
  const [secret, setSecret] = useState("")
  const [errors, setErrors] = useState<{ platformId?: string; account?: string; secret?: string }>(
    {},
  )
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setPlatformId("")
    setAccount("")
    setSecret("")
    setErrors({})
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const newErrors: typeof errors = {}
    if (!platformId) newErrors.platformId = "Platform is required"
    if (!account.trim()) newErrors.account = "Account is required"
    if (!secret) newErrors.secret = "Secret is required"
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    setSubmitting(true)
    try {
      const result = await addCredentialFn({
        data: { platformId, account: account.trim(), kind: "bearer", secret },
      })
      if (!result.ok) {
        toast.error(`Failed to add credential: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Credential added")
      onOpenChange(false)
      reset()
      onSuccess()
    } catch {
      toast.error("Failed to add credential")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Credential</DialogTitle>
          <DialogDescription>
            Add a bearer credential for a platform. The secret is never stored in plaintext.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="add-platform" label="Platform" error={errors.platformId}>
              <Select value={platformId} onValueChange={setPlatformId}>
                <SelectTrigger id="add-platform" aria-required="true">
                  <SelectValue placeholder="Select a platform" />
                </SelectTrigger>
                <SelectContent>
                  {platforms.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="add-account" label="Account" error={errors.account}>
              <Input
                id="add-account"
                placeholder="e.g. work, personal"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                hasError={!!errors.account}
                aria-required="true"
              />
            </Field>
            <Field
              id="add-kind"
              label="Kind"
              description="Only bearer credentials are supported in this release."
            >
              <Input id="add-kind" value="bearer" disabled aria-disabled="true" />
            </Field>
            <SecretField
              id="add-secret"
              label="Secret"
              value={secret}
              onChange={setSecret}
              error={errors.secret}
              placeholder="Paste your secret here"
            />
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Add Credential"
            submittingLabel="Adding…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rotate credential dialog
// ---------------------------------------------------------------------------

interface RotateDialogProps {
  readonly credential: CredentialMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function RotateCredentialDialog({ credential, onOpenChange, onSuccess }: RotateDialogProps) {
  const [newSecret, setNewSecret] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setNewSecret("")
    setError(undefined)
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!newSecret) {
      setError("New secret is required")
      return
    }
    if (!credential) return
    setSubmitting(true)
    try {
      const result = await rotateCredentialFn({
        data: { credentialId: credential.id, newSecret },
      })
      if (!result.ok) {
        toast.error(`Failed to rotate credential: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Credential rotated")
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to rotate credential")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={credential !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate Credential</DialogTitle>
          <DialogDescription>
            Enter a new secret for <MonoCode>{credential?.account}</MonoCode> on{" "}
            <MonoCode>{credential?.platformId}</MonoCode>. The old secret is deleted from the store
            on success.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <SecretField
              id="rotate-secret"
              label="New secret"
              value={newSecret}
              onChange={setNewSecret}
              error={error}
              placeholder="Paste new secret here"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Rotating…" : "Rotate Secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog — uses shared ConfirmDialog (FIX 5).
// ---------------------------------------------------------------------------

interface DeleteDialogProps {
  readonly credential: CredentialMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function DeleteCredentialDialog({ credential, onOpenChange, onSuccess }: DeleteDialogProps) {
  async function handleConfirm(): Promise<boolean> {
    if (!credential) return false
    try {
      const result = await removeCredentialFn({ data: { credentialId: credential.id } })
      if (!result.ok) {
        toast.error(`Failed to delete credential: ${result.error}`)
        return false
      }
      toast.success("Credential deleted")
      onSuccess()
      return true
    } catch {
      toast.error("Failed to delete credential")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={credential !== null}
      title="Delete Credential"
      description={
        <>
          Delete credential <MonoCode>{credential?.account}</MonoCode> on{" "}
          <MonoCode>{credential?.platformId}</MonoCode>? This removes the secret from the store and
          cannot be undone.
        </>
      }
      confirmLabel="Delete Credential"
      confirmingLabel="Deleting…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Flat credentials table (F12 — Variant C)
//
// Sort behavior: when sorting by Account (a non-platform column), group dividers
// are dropped and the list is flattened for a clean sort result. When sorting by
// Platform (or unsorted), group dividers are preserved within the single table.
// This is documented here so the behavior is predictable and easy to extend.
// ---------------------------------------------------------------------------

interface FlatTableProps {
  readonly credentials: CredentialMeta[]
  readonly platforms: PlatformMeta[]
  readonly onRotate: (c: CredentialMeta) => void
  readonly onDelete: (c: CredentialMeta) => void
  /** Page size; defaults to PAGE_SIZE. A test seam so pagination slicing is exercisable. */
  readonly pageSize?: number
}

// Exported for direct unit testing of the search/sort/pagination logic (the
// pageSize prop lets a test exercise a real second page without 25+ fixtures).
// Facet filter sentinel — "all" clears that facet (composes as AND across
// platform/account/kind + the search box, via useTableView's predicate).
const ALL_FILTER = "all"

export function FlatCredentialsTable({
  credentials,
  platforms,
  onRotate,
  onDelete,
  pageSize = PAGE_SIZE,
}: FlatTableProps) {
  // Build a lookup from platformId → PlatformMeta for display names and kinds.
  const platformMap = useMemo(
    () => new Map<string, PlatformMeta>(platforms.map((p) => [p.id, p])),
    [platforms],
  )

  const [platformFilter, setPlatformFilter] = useState(ALL_FILTER)
  const [accountFilter, setAccountFilter] = useState(ALL_FILTER)
  const [kindFilter, setKindFilter] = useState(ALL_FILTER)

  // Distinct facet options derived from the actual credentials present (not
  // hardcoded — Platform/Account naturally vary per install; Kind is currently
  // single-valued ("bearer") but derived the same way for when that changes).
  const platformOptions = useMemo(() => {
    const seen = new Map<string, string>() // platformId -> displayName
    for (const c of credentials) {
      if (!seen.has(c.platformId)) {
        seen.set(c.platformId, platformMap.get(c.platformId)?.displayName ?? c.platformId)
      }
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [credentials, platformMap])

  const accountOptions = useMemo(
    () => Array.from(new Set(credentials.map((c) => c.account))).sort((a, b) => a.localeCompare(b)),
    [credentials],
  )

  const kindOptions = useMemo(
    () => Array.from(new Set(credentials.map((c) => c.kind))).sort((a, b) => a.localeCompare(b)),
    [credentials],
  )

  const predicate = useCallback(
    (c: CredentialMeta) =>
      (platformFilter === ALL_FILTER || c.platformId === platformFilter) &&
      (accountFilter === ALL_FILTER || c.account === accountFilter) &&
      (kindFilter === ALL_FILTER || c.kind === kindFilter),
    [platformFilter, accountFilter, kindFilter],
  )

  // Sortable columns — Platform sorts by the joined display name; Account by the
  // credential's own field. Kept in a ref-stable array via useMemo on platformMap.
  const columns: TableColumn<CredentialMeta>[] = useMemo(
    () => [
      {
        key: "platform",
        compare: (a, b) => {
          const aN = platformMap.get(a.platformId)?.displayName ?? a.platformId
          const bN = platformMap.get(b.platformId)?.displayName ?? b.platformId
          return aN.localeCompare(bN)
        },
      },
      { key: "account", compare: (a, b) => a.account.localeCompare(b.account) },
    ],
    [platformMap],
  )

  const {
    search,
    setSearch,
    sortKey,
    toggleSort,
    sortDirectionFor,
    page,
    pageCount,
    setPage,
    total,
    pageRows: pageSlice,
    filteredSortedRows: sorted,
  } = useTableView<CredentialMeta>({
    rows: credentials,
    searchFields: (c) => [
      c.id,
      c.account,
      c.platformId,
      platformMap.get(c.platformId)?.displayName,
    ],
    columns,
    pageSize,
    predicate,
  })

  // Group dividers stay ONLY when unsorted or sorted-by-platform; sorting by
  // Account flattens the list (dropping dividers) — same behavior as before the
  // useTableView refactor, now derived from the hook's sortKey/pageRows.
  const grouped = sortKey !== "account"

  function handleSort(key: "platform" | "account") {
    toggleSort(key)
  }

  // Build the row content. When grouped, insert a TableGroupRow before the first
  // credential of each new platform.
  type TableItem =
    | { type: "group"; platformId: string }
    | { type: "row"; credential: CredentialMeta }

  const tableItems: TableItem[] = useMemo(() => {
    if (!grouped) {
      return pageSlice.map((c) => ({ type: "row" as const, credential: c }))
    }
    const items: TableItem[] = []
    let lastPlatformId: string | null = null
    for (const c of pageSlice) {
      if (c.platformId !== lastPlatformId) {
        items.push({ type: "group", platformId: c.platformId })
        lastPlatformId = c.platformId
      }
      items.push({ type: "row", credential: c })
    }
    return items
  }, [grouped, pageSlice])

  // Count credentials per platform for the group-divider count badge.
  const platformCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of sorted) {
      counts.set(c.platformId, (counts.get(c.platformId) ?? 0) + 1)
    }
    return counts
  }, [sorted])

  const isEmptySearch =
    total === 0 &&
    (search.trim().length > 0 ||
      platformFilter !== ALL_FILTER ||
      accountFilter !== ALL_FILTER ||
      kindFilter !== ALL_FILTER)

  return (
    <div className="flex flex-col gap-3">
      {/* Search + Platform/Account/Kind facet filters — row, composes as AND. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        <Input
          id="cred-search"
          type="search"
          placeholder="Filter by platform, account, or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
          aria-label="Search credentials"
        />
        <FacetSelect
          ariaLabel="Filter by platform"
          allLabel="All platforms"
          allValue={ALL_FILTER}
          value={platformFilter}
          onValueChange={setPlatformFilter}
          options={platformOptions.map(([id, displayName]) => ({ value: id, label: displayName }))}
        />
        <FacetSelect
          ariaLabel="Filter by account"
          allLabel="All accounts"
          allValue={ALL_FILTER}
          value={accountFilter}
          onValueChange={setAccountFilter}
          options={accountOptions.map((account) => ({ value: account }))}
        />
        <FacetSelect
          ariaLabel="Filter by kind"
          allLabel="All kinds"
          allValue={ALL_FILTER}
          value={kindFilter}
          onValueChange={setKindFilter}
          options={kindOptions.map((kind) => ({ value: kind }))}
        />
      </div>

      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead
                sortDirection={sortDirectionFor("platform")}
                onSort={() => handleSort("platform")}
              >
                Platform
              </TableHead>
              <TableHead
                sortDirection={sortDirectionFor("account")}
                onSort={() => handleSort("account")}
              >
                Account
              </TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableActionsHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {total === 0 ? (
              <EmptyTableRow
                colSpan={COL_COUNT}
                message={
                  isEmptySearch ? "No credentials match your search." : "No credentials yet."
                }
                action={
                  isEmptySearch ? undefined : (
                    <span style={{ fontSize: "var(--text-body)", color: "var(--gray-700)" }}>
                      Use <strong>Add Credential</strong> above.
                    </span>
                  )
                }
              />
            ) : (
              tableItems.map((item) => {
                if (item.type === "group") {
                  const platform = platformMap.get(item.platformId)
                  return (
                    <TableGroupRow
                      key={`group-${item.platformId}`}
                      colSpan={COL_COUNT}
                      label={platform?.displayName ?? item.platformId}
                      kind={platform?.kind}
                      count={platformCounts.get(item.platformId)}
                      unit="credentials"
                    />
                  )
                }
                const c = item.credential
                // Show full ULID — feedback: ID was over-truncating despite available width.
                const platformName = platformMap.get(c.platformId)?.displayName ?? c.platformId
                return (
                  <TableRow key={c.id}>
                    <TableCellMono
                      title={c.id}
                      style={{ color: "var(--gray-700)", minWidth: "250px", width: "250px" }}
                    >
                      {c.id}
                    </TableCellMono>
                    <TableCellMono>
                      <MonoCode>{platformName}</MonoCode>
                    </TableCellMono>
                    <TableCell>{c.account}</TableCell>
                    <TableCellMono>
                      {/* Kind shows TRUE stored kind — "bearer" only (honesty guard, F12). */}
                      {c.kind}
                    </TableCellMono>
                    <TableCell>
                      <StatusBadge status={kindToStatus(c.kind)} />
                    </TableCell>
                    <TableActionsCell
                      menu={
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => onRotate(c)}>
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                            Rotate Secret
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => onDelete(c)}
                            style={{ color: "var(--status-error-fg)" }}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      }
                    />
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>

        {/* Pagination footer — always rendered so the control is present even with 1 page */}
        <TablePagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function CredentialsPage() {
  const { credentials, platforms } = Route.useLoaderData()
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [rotatingCred, setRotatingCred] = useState<CredentialMeta | null>(null)
  const [deletingCred, setDeletingCred] = useState<CredentialMeta | null>(null)

  async function invalidate() {
    await router.invalidate()
  }

  return (
    <div>
      <PageHeader
        title="Credentials"
        count={credentials.length > 0 ? credentials.length : undefined}
        actions={
          <>
            <RefreshButton />
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add Credential
            </Button>
          </>
        }
      />

      <FlatCredentialsTable
        credentials={credentials}
        platforms={platforms}
        onRotate={setRotatingCred}
        onDelete={setDeletingCred}
      />

      <AddCredentialDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        platforms={platforms}
        onSuccess={invalidate}
      />
      <RotateCredentialDialog
        credential={rotatingCred}
        onOpenChange={(open) => {
          if (!open) setRotatingCred(null)
        }}
        onSuccess={invalidate}
      />
      <DeleteCredentialDialog
        credential={deletingCred}
        onOpenChange={(open) => {
          if (!open) setDeletingCred(null)
        }}
        onSuccess={invalidate}
      />
    </div>
  )
}
