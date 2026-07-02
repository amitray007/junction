// SPDX-License-Identifier: AGPL-3.0-only
// Keys route — junction's own API-key mint/revoke UI (inc 27 slice C).
// Mirrors the credentials.tsx canonical CRUD-table pattern near-exactly: a
// useTableView table, a FacetSelect (scope, status), an Add(mint) dialog, a
// per-row TableActionsCell ⋯ menu, a ConfirmDialog for revoke, TablePagination,
// RefreshButton, PageHeader with actions, and an empty-state with a mint CTA.
//
// LOAD-BEARING (§3 of docs/methods/27-junction-keys-single-endpoint.md):
// - The mint dialog shows the full plaintext key EXACTLY ONCE. It is never
//   re-fetchable — closing the dialog (or reopening it) never shows it again,
//   and it never appears in the table/loader.
// - Active keys show Revoke (immediate 401, row retained for audit). A REVOKED
//   key shows Delete instead — a hard removal, allowed only after revoke so the
//   active-key lifecycle stays auditable (inc 31).
// No @junction/core import. Secret plaintext lives only in mint-dialog local state.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Copy, Plus, ShieldOff, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import type { TableColumn } from "../lib/use-table-view.js"
import { useTableView } from "../lib/use-table-view.js"
import type { ProfileMeta } from "../server/data.functions.js"
import { getProfiles } from "../server/data.functions.js"
import type { ApiKeyMeta } from "../server/keys-mutations.functions.js"
import {
  deleteKeyFn,
  getApiKeys,
  mintKeyFn,
  revokeKeyFn,
} from "../server/keys-mutations.functions.js"
import { MonoCode } from "../ui/code.js"
import {
  Button,
  Checkbox,
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
  StatusBadge,
  Switch,
  Table,
  TableActionsCell,
  TableActionsHead,
  TableBody,
  TableCell,
  TableCellMono,
  TableHead,
  TableHeader,
  TablePagination,
  TableRow,
  TableSkeleton,
} from "../ui/index.js"

export const Route = createFileRoute("/keys")({
  loader: async () => {
    const [apiKeys, profiles] = await Promise.all([getApiKeys(), getProfiles()])
    return { apiKeys, profiles }
  },
  pendingComponent: KeysPending,
  component: KeysPage,
})

const PAGE_SIZE = 25
const COL_COUNT = 5

function KeysPending() {
  return (
    <div>
      <PageHeader title="API Keys" />
      <TableSkeleton
        rows={4}
        columns={[
          { flex: true },
          { width: "w-40" },
          { width: "w-24" },
          { width: "w-24" },
          { width: "w-8" },
        ]}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function keyStatus(k: ApiKeyMeta): "active" | "revoked" {
  return k.revokedAt !== null ? "revoked" : "active"
}

// Deterministic, SSR-safe date format. `toLocaleString()` depends on the
// runtime's locale + timezone, so the server (SSR) and the browser (hydration)
// can produce DIFFERENT strings for the same timestamp → React swaps the text
// on hydrate, which shows as a flicker + a format change. Pinning the locale
// AND timezone (UTC) makes server and client byte-identical → no mismatch, no
// flicker. Labeled "UTC" so the shown time is unambiguous.
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

function formatDate(ms: number | null): string {
  if (ms === null) return "Never"
  return `${DATE_FORMAT.format(new Date(ms))} UTC`
}

function scopeLabel(k: ApiKeyMeta, profileNameById: Map<string, string>): string {
  if (k.scope === "global") return "global"
  return k.profileIds.map((id) => profileNameById.get(id) ?? id).join(", ")
}

// ---------------------------------------------------------------------------
// Mint dialog
// ---------------------------------------------------------------------------

interface ProfileOption {
  readonly id: string
  readonly name: string
}

interface MintDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly profiles: ProfileOption[]
  readonly onSuccess: () => void
}

function MintKeyDialog({ open, onOpenChange, profiles, onSuccess }: MintDialogProps) {
  const [label, setLabel] = useState("")
  const [isGlobal, setIsGlobal] = useState(profiles.length === 0)
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([])
  const [errors, setErrors] = useState<{ label?: string; scope?: string }>({})
  const [submitting, setSubmitting] = useState(false)
  const [mintedKey, setMintedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [profileSearch, setProfileSearch] = useState("")

  const noProfiles = profiles.length === 0
  // Show a filter box once the list is long enough to be awkward to scan.
  const showProfileSearch = profiles.length > 8
  const visibleProfiles =
    profileSearch.trim() === ""
      ? profiles
      : profiles.filter((p) => p.name.toLowerCase().includes(profileSearch.trim().toLowerCase()))

  function reset() {
    setLabel("")
    setIsGlobal(profiles.length === 0)
    setSelectedProfileIds([])
    setProfileSearch("")
    setErrors({})
    setSubmitting(false)
    // Deliberately NOT resetting mintedKey here — see handleOpenChange, which
    // clears it explicitly on close so the plaintext never survives a reopen.
    setCopied(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset()
      // Plaintext exists only for the lifetime of this open dialog instance —
      // clearing it on close is the display-once guarantee (§3 invariant #1).
      setMintedKey(null)
    }
    onOpenChange(next)
  }

  function toggleProfile(id: string) {
    setSelectedProfileIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const newErrors: typeof errors = {}
    if (!label.trim()) newErrors.label = "Name is required"
    if (!isGlobal && selectedProfileIds.length === 0) {
      newErrors.scope = "Select at least one profile, or choose Global scope"
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    setSubmitting(true)
    try {
      const result = await mintKeyFn({
        data: {
          label: label.trim(),
          isGlobal,
          profileIds: isGlobal ? [] : selectedProfileIds,
        },
      })
      if (!result.ok) {
        toast.error(`Failed to create key: ${result.error}`)
        setSubmitting(false)
        return
      }
      setMintedKey(result.plaintext)
      toast.success("API key created")
      setSubmitting(false)
      onSuccess()
    } catch {
      toast.error("Failed to create key")
      setSubmitting(false)
    }
  }

  async function handleCopy() {
    if (!mintedKey) return
    try {
      await navigator.clipboard.writeText(mintedKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable (non-secure context) — silently ignore
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {mintedKey ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your API key now</DialogTitle>
              <DialogDescription>
                This is the only time the full key is shown — junction stores only a hash and cannot
                show it again. Copy it now; if you lose it, revoke this key and create a new one.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-6)",
                  border: "1px solid var(--alpha-200)",
                  backgroundColor: "var(--bg-200)",
                }}
              >
                <span
                  data-testid="minted-key-plaintext"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-mono)",
                    color: "var(--blue-text)",
                    flex: 1,
                    wordBreak: "break-all",
                    userSelect: "text",
                  }}
                >
                  {mintedKey}
                </span>
                <Button type="button" variant="secondary" onClick={handleCopy}>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  {copied ? "Copied!" : "Copy"}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="primary" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Create a new junction API key. The full key is shown once after minting.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} noValidate>
              <div className="flex flex-col gap-4">
                <Field id="mint-label" label="Name" error={errors.label}>
                  <Input
                    id="mint-label"
                    placeholder="e.g. claude-code, cursor-work"
                    value={label}
                    onChange={(e) => {
                      setLabel(e.target.value)
                      if (errors.label) setErrors((prev) => ({ ...prev, label: undefined }))
                    }}
                    hasError={!!errors.label}
                    aria-required="true"
                  />
                </Field>

                <div className="flex flex-col gap-2">
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <Switch
                      id="mint-global"
                      checked={isGlobal}
                      onCheckedChange={(checked) => {
                        setIsGlobal(checked === true)
                        if (errors.scope) setErrors((prev) => ({ ...prev, scope: undefined }))
                      }}
                      aria-label="Global scope"
                    />
                    <label
                      htmlFor="mint-global"
                      style={{
                        fontSize: "var(--text-label)",
                        fontWeight: 500,
                        color: "var(--gray-1000)",
                      }}
                    >
                      Global (all profiles)
                    </label>
                  </div>

                  {noProfiles ? (
                    <p
                      style={{
                        fontSize: "var(--text-caption)",
                        color: "var(--gray-700)",
                        margin: 0,
                      }}
                    >
                      No profiles exist yet — create a profile to scope more narrowly. A global key
                      is still mintable.
                    </p>
                  ) : (
                    !isGlobal && (
                      <fieldset
                        style={{
                          border: "none",
                          padding: 0,
                          margin: 0,
                          display: "flex",
                          flexDirection: "column",
                          gap: "6px",
                        }}
                      >
                        <legend
                          style={{
                            fontSize: "var(--text-label)",
                            fontWeight: 500,
                            color: "var(--gray-1000)",
                            padding: 0,
                            marginBottom: "4px",
                          }}
                        >
                          Profiles
                          {selectedProfileIds.length > 0 && (
                            <span style={{ color: "var(--gray-700)", fontWeight: 400 }}>
                              {" "}
                              · {selectedProfileIds.length} selected
                            </span>
                          )}
                        </legend>
                        {showProfileSearch && (
                          <Input
                            type="text"
                            value={profileSearch}
                            onChange={(e) => setProfileSearch(e.target.value)}
                            placeholder="Filter profiles…"
                            aria-label="Filter profiles"
                            style={{ marginBottom: "4px" }}
                          />
                        )}
                        {/* Scrollable so a long profile list never blows out the dialog. */}
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "2px",
                            maxHeight: "216px",
                            overflowY: "auto",
                            border: "1px solid var(--alpha-200)",
                            borderRadius: "var(--radius-6)",
                            padding: "6px",
                          }}
                        >
                          {visibleProfiles.length === 0 ? (
                            <p
                              style={{
                                fontSize: "var(--text-caption)",
                                color: "var(--gray-700)",
                                margin: 0,
                                padding: "4px 2px",
                              }}
                            >
                              No profiles match “{profileSearch}”.
                            </p>
                          ) : (
                            visibleProfiles.map((p) => (
                              <label
                                key={p.id}
                                htmlFor={`mint-profile-${p.id}`}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                  fontSize: "var(--text-body)",
                                  padding: "3px 4px",
                                  borderRadius: "var(--radius-6)",
                                  cursor: "pointer",
                                }}
                              >
                                <Checkbox
                                  id={`mint-profile-${p.id}`}
                                  checked={selectedProfileIds.includes(p.id)}
                                  onCheckedChange={() => {
                                    toggleProfile(p.id)
                                    if (errors.scope)
                                      setErrors((prev) => ({ ...prev, scope: undefined }))
                                  }}
                                />
                                {p.name}
                              </label>
                            ))
                          )}
                        </div>
                      </fieldset>
                    )
                  )}
                  {errors.scope && (
                    <p
                      role="alert"
                      style={{
                        fontSize: "var(--text-caption)",
                        color: "var(--status-error-fg)",
                        margin: 0,
                      }}
                    >
                      {errors.scope}
                    </p>
                  )}
                </div>
              </div>
              <DialogFormFooter
                onCancel={() => handleOpenChange(false)}
                submitting={submitting}
                submitLabel="Create Key"
                submittingLabel="Creating…"
              />
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Revoke confirmation dialog
// ---------------------------------------------------------------------------

interface RevokeDialogProps {
  readonly apiKey: ApiKeyMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

// Exported for direct unit testing of the confirm→revoke flow (the row's ⋯
// trigger that opens this dialog lives inside a Radix DropdownMenu Portal,
// which does not render in happy-dom — see -keys.test.tsx for the documented
// limitation and how this export lets the flow itself still be tested).
export function RevokeKeyDialog({ apiKey, onOpenChange, onSuccess }: RevokeDialogProps) {
  async function handleConfirm(): Promise<boolean> {
    if (!apiKey) return false
    try {
      const result = await revokeKeyFn({ data: { keyId: apiKey.id } })
      if (!result.ok) {
        toast.error(`Failed to revoke key: ${result.error}`)
        return false
      }
      toast.success(`Key "${apiKey.label}" revoked`)
      onSuccess()
      return true
    } catch {
      toast.error("Failed to revoke key")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={apiKey !== null}
      title="Revoke API Key"
      description={
        <>
          Revoke key <MonoCode>{apiKey?.label}</MonoCode> (<MonoCode>jct_{apiKey?.id}</MonoCode>)?
          Any agent using this key will lose access immediately. This cannot be undone.
        </>
      }
      confirmLabel="Revoke Key"
      confirmingLabel="Revoking…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog (revoked keys only)
// ---------------------------------------------------------------------------

// Exported for direct unit testing (same Radix-portal limitation as revoke).
export function DeleteKeyDialog({ apiKey, onOpenChange, onSuccess }: RevokeDialogProps) {
  async function handleConfirm(): Promise<boolean> {
    if (!apiKey) return false
    try {
      const result = await deleteKeyFn({ data: { keyId: apiKey.id } })
      if (!result.ok) {
        toast.error(`Failed to delete key: ${result.error}`)
        return false
      }
      toast.success(`Key "${apiKey.label}" deleted`)
      onSuccess()
      return true
    } catch {
      toast.error("Failed to delete key")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={apiKey !== null}
      title="Delete API Key"
      description={
        <>
          Permanently delete revoked key <MonoCode>{apiKey?.label}</MonoCode> (
          <MonoCode>jct_{apiKey?.id}</MonoCode>)? This removes it from the list for good.
        </>
      }
      confirmLabel="Delete Key"
      confirmingLabel="Deleting…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Keys table
// ---------------------------------------------------------------------------

const ALL_FILTER = "all"

interface KeysTableProps {
  readonly apiKeys: ApiKeyMeta[]
  readonly profileNameById: Map<string, string>
  readonly onRevoke: (k: ApiKeyMeta) => void
  readonly onDelete: (k: ApiKeyMeta) => void
  readonly pageSize?: number
}

export function KeysTable({
  apiKeys,
  profileNameById,
  onRevoke,
  onDelete,
  pageSize = PAGE_SIZE,
}: KeysTableProps) {
  const [scopeFilter, setScopeFilter] = useState(ALL_FILTER)
  const [statusFilter, setStatusFilter] = useState(ALL_FILTER)

  const scopeOptions = useMemo(
    () => Array.from(new Set(apiKeys.map((k) => k.scope))).sort((a, b) => a.localeCompare(b)),
    [apiKeys],
  )

  const predicate = useCallback(
    (k: ApiKeyMeta) =>
      (scopeFilter === ALL_FILTER || k.scope === scopeFilter) &&
      (statusFilter === ALL_FILTER || keyStatus(k) === statusFilter),
    [scopeFilter, statusFilter],
  )

  const columns: TableColumn<ApiKeyMeta>[] = useMemo(
    () => [
      { key: "label", compare: (a, b) => a.label.localeCompare(b.label) },
      { key: "created", compare: (a, b) => a.createdAt - b.createdAt },
      {
        key: "lastUsed",
        compare: (a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0),
      },
    ],
    [],
  )

  const {
    search,
    setSearch,
    sortDirectionFor,
    toggleSort,
    page,
    pageCount,
    setPage,
    total,
    pageRows,
  } = useTableView<ApiKeyMeta>({
    rows: apiKeys,
    searchFields: (k) => [k.label, k.id],
    columns,
    pageSize,
    predicate,
  })

  const isEmptySearch =
    total === 0 &&
    (search.trim().length > 0 || scopeFilter !== ALL_FILTER || statusFilter !== ALL_FILTER)

  return (
    <div className="flex flex-col gap-3">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        <Input
          id="keys-search"
          type="search"
          placeholder="Filter by name or key id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
          aria-label="Search keys"
        />
        <FacetSelect
          ariaLabel="Filter by scope"
          allLabel="All scopes"
          allValue={ALL_FILTER}
          value={scopeFilter}
          onValueChange={setScopeFilter}
          options={scopeOptions.map((s) => ({ value: s }))}
        />
        <FacetSelect
          ariaLabel="Filter by status"
          allLabel="All statuses"
          allValue={ALL_FILTER}
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={[
            { value: "active", label: "Active" },
            { value: "revoked", label: "Revoked" },
          ]}
        />
      </div>

      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                sortDirection={sortDirectionFor("label")}
                onSort={() => toggleSort("label")}
              >
                Name
              </TableHead>
              <TableHead>Scope</TableHead>
              <TableHead
                sortDirection={sortDirectionFor("created")}
                onSort={() => toggleSort("created")}
              >
                Created
              </TableHead>
              <TableHead
                sortDirection={sortDirectionFor("lastUsed")}
                onSort={() => toggleSort("lastUsed")}
              >
                Last Used
              </TableHead>
              <TableHead>Status</TableHead>
              <TableActionsHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {total === 0 ? (
              <EmptyTableRow
                colSpan={COL_COUNT + 1}
                message={isEmptySearch ? "No keys match your search." : "No API keys yet."}
                action={
                  isEmptySearch ? undefined : (
                    <span style={{ fontSize: "var(--text-body)", color: "var(--gray-700)" }}>
                      Use <strong>Create Key</strong> above.
                    </span>
                  )
                }
              />
            ) : (
              pageRows.map((k) => {
                const status = keyStatus(k)
                return (
                  <TableRow key={k.id}>
                    <TableCell>{k.label}</TableCell>
                    <TableCell>{scopeLabel(k, profileNameById)}</TableCell>
                    <TableCellMono>{formatDate(k.createdAt)}</TableCellMono>
                    <TableCellMono>{formatDate(k.lastUsedAt)}</TableCellMono>
                    <TableCell>
                      <StatusBadge status={status} />
                    </TableCell>
                    <TableActionsCell
                      menu={
                        <DropdownMenuContent align="end">
                          {status === "revoked" ? (
                            // A revoked key can be permanently deleted (it's already
                            // out of service; keeping it is only for audit until you
                            // choose to clean it up).
                            <DropdownMenuItem
                              onSelect={() => onDelete(k)}
                              style={{ color: "var(--status-error-fg)" }}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                              Delete
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onSelect={() => onRevoke(k)}
                              style={{ color: "var(--status-error-fg)" }}
                            >
                              <ShieldOff className="h-4 w-4" aria-hidden="true" />
                              Revoke
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      }
                    />
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>

        <TablePagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function KeysPage() {
  const { apiKeys, profiles }: { apiKeys: ApiKeyMeta[]; profiles: ProfileMeta[] } =
    Route.useLoaderData()
  const router = useRouter()
  const [mintOpen, setMintOpen] = useState(false)
  const [revokingKey, setRevokingKey] = useState<ApiKeyMeta | null>(null)
  const [deletingKey, setDeletingKey] = useState<ApiKeyMeta | null>(null)

  const profileNameById = useMemo(
    () => new Map<string, string>(profiles.map((p) => [p.id, p.name])),
    [profiles],
  )

  async function invalidate() {
    await router.invalidate()
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        count={apiKeys.length > 0 ? apiKeys.length : undefined}
        actions={
          <>
            <RefreshButton />
            <Button variant="primary" onClick={() => setMintOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create Key
            </Button>
          </>
        }
      />

      {apiKeys.length === 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <EmptyTableRow colSpan={COL_COUNT} message="No API keys yet. Use “Create Key” above." />
          </TableBody>
        </Table>
      ) : (
        <KeysTable
          apiKeys={apiKeys}
          profileNameById={profileNameById}
          onRevoke={setRevokingKey}
          onDelete={setDeletingKey}
        />
      )}

      <MintKeyDialog
        open={mintOpen}
        onOpenChange={setMintOpen}
        profiles={profiles}
        onSuccess={invalidate}
      />
      <RevokeKeyDialog
        apiKey={revokingKey}
        onOpenChange={(open) => {
          if (!open) setRevokingKey(null)
        }}
        onSuccess={invalidate}
      />
      <DeleteKeyDialog
        apiKey={deletingKey}
        onOpenChange={(open) => {
          if (!open) setDeletingKey(null)
        }}
        onSuccess={invalidate}
      />
    </div>
  )
}
