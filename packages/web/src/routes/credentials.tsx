// SPDX-License-Identifier: AGPL-3.0-only
// Credentials route — flat paginated table with platform group-dividers (Variant C, F12).
// Replaces the grouped-card layout (inc-24.5) with ONE table: columns ID · Platform ·
// Account · Kind (true: bearer) · Status · ⋯, group-divider rows per platform, search,
// sort (Platform/Account), and a TablePagination footer (page size 25).
// The inc-24 add/rotate/delete mutations stay wired unchanged.
// No @junction/core import. Secret is input-only; never rendered or returned.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Plus, RefreshCw, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
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
  DialogHeader,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  EmptyTableRow,
  Field,
  Input,
  PageHeader,
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
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Adding…" : "Add Credential"}
            </Button>
          </DialogFooter>
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

type SortKey = "platform" | "account" | "none"
type SortDir = "ascending" | "descending"

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
export function FlatCredentialsTable({
  credentials,
  platforms,
  onRotate,
  onDelete,
  pageSize = PAGE_SIZE,
}: FlatTableProps) {
  const [search, setSearch] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("none")
  const [sortDir, setSortDir] = useState<SortDir>("ascending")
  const [page, setPage] = useState(1)

  // Build a lookup from platformId → PlatformMeta for display names and kinds.
  const platformMap = useMemo(
    () => new Map<string, PlatformMeta>(platforms.map((p) => [p.id, p])),
    [platforms],
  )

  // Filter by search query (case-insensitive substring over id, account, platform name).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return credentials
    return credentials.filter((c) => {
      const displayName = platformMap.get(c.platformId)?.displayName ?? c.platformId
      return (
        c.id.toLowerCase().includes(q) ||
        c.account.toLowerCase().includes(q) ||
        displayName.toLowerCase().includes(q) ||
        c.platformId.toLowerCase().includes(q)
      )
    })
  }, [credentials, platformMap, search])

  // Sort. When sorted by Account, drop group dividers (flatten).
  // When sorted by Platform or unsorted, keep platform grouping.
  const { sorted, grouped } = useMemo(() => {
    const isByAccount = sortKey === "account"
    const isByPlatform = sortKey === "platform"

    const items = [...filtered]
    if (isByAccount) {
      items.sort((a, b) => {
        const cmp = a.account.localeCompare(b.account)
        return sortDir === "ascending" ? cmp : -cmp
      })
      return { sorted: items, grouped: false }
    }

    if (isByPlatform) {
      items.sort((a, b) => {
        const aN = platformMap.get(a.platformId)?.displayName ?? a.platformId
        const bN = platformMap.get(b.platformId)?.displayName ?? b.platformId
        const cmp = aN.localeCompare(bN)
        return sortDir === "ascending" ? cmp : -cmp
      })
    }
    // else: preserve loader order (already grouped by platform)
    return { sorted: items, grouped: true }
  }, [filtered, sortKey, sortDir, platformMap])

  // Pagination — page resets when search/sort changes.
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const clampedPage = Math.min(page, pageCount)
  const pageStart = (clampedPage - 1) * pageSize
  const pageSlice = sorted.slice(pageStart, pageStart + pageSize)

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "ascending" ? "descending" : "ascending"))
    } else {
      setSortKey(key)
      setSortDir("ascending")
    }
    setPage(1)
  }

  function handleSearch(q: string) {
    setSearch(q)
    setPage(1)
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

  const isEmptySearch = sorted.length === 0 && search.trim().length > 0

  return (
    <div className="flex flex-col gap-3">
      {/* Search input — labeled for a11y (DESIGN.md: labeled inputs) */}
      <div>
        <label
          htmlFor="cred-search"
          style={{
            fontSize: "var(--text-label)",
            color: "var(--gray-700)",
            display: "block",
            marginBottom: "6px",
          }}
        >
          Search
        </label>
        <Input
          id="cred-search"
          type="search"
          placeholder="Filter by platform, account, or ID"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
          aria-label="Search credentials"
        />
      </div>

      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead
                sortDirection={sortKey === "platform" ? sortDir : "none"}
                onSort={() => handleSort("platform")}
              >
                Platform
              </TableHead>
              <TableHead
                sortDirection={sortKey === "account" ? sortDir : "none"}
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
            {sorted.length === 0 ? (
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
        <TablePagination
          page={clampedPage}
          pageCount={pageCount}
          total={sorted.length}
          onPageChange={setPage}
        />
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
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add Credential
          </Button>
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
