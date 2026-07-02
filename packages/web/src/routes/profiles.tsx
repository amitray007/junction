// SPDX-License-Identifier: AGPL-3.0-only
// Profiles route — master-detail layout (Variant C, F13) + profile route editing (E11b).
// Left: profiles list (name + route count + › — no platform chips, inc-25 feedback).
// Right: selected profile detail — route rows table + editing actions.
//
// HONESTY GUARDS:
// - "N keys active" removed — was ComingSoon with no near-term plan (inc-25 feedback).
// - No per-profile HTTP endpoint URL (single-endpoint model — show CLI command).
//
// Tool access (filter allow/deny) is editable in place via "Edit Tool Access" in the
// route row's ⋯ menu (inc 26 slice D — core gained SourceOp.setFilter). The add-route
// dialog still sets no filter at creation time (ComingSoon there) — use the in-place
// editor after adding the route to set one.
//
// Responsive: at <700px the split stacks list-above-detail (CSS media query).
// No @junction/core import. All core access via createServerFn.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import {
  ChevronRight,
  Plus,
  PlusCircle,
  Power,
  PowerOff,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import type { SortDirection, TableColumn } from "../lib/use-table-view.js"
import { useTableView } from "../lib/use-table-view.js"
import type {
  CredentialMeta,
  PlatformMeta,
  ProfileMeta,
  SourceMeta,
} from "../server/data.functions.js"
import { getCredentials, getPlatforms, getProfiles } from "../server/data.functions.js"
import { countKeysReferencingProfileFn } from "../server/keys-mutations.functions.js"
import {
  addRouteFn,
  createProfileFn,
  deleteProfileFn,
  removeRouteFn,
  setRouteFilterFn,
  toggleRouteFn,
} from "../server/profile-mutations.functions.js"
import { MonoCode } from "../ui/code.js"
import { ComingSoon } from "../ui/coming-soon.js"
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFormFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  EmptyTableRow,
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
  TableHead,
  TableHeader,
  TablePagination,
  TableRow,
  TableSkeleton,
} from "../ui/index.js"

export const Route = createFileRoute("/profiles")({
  loader: async () => {
    const [profiles, platforms, credentials] = await Promise.all([
      getProfiles(),
      getPlatforms(),
      getCredentials(),
    ])
    return { profiles, platforms, credentials }
  },
  pendingComponent: ProfilesPending,
  component: ProfilesPage,
})

function ProfilesPending() {
  return (
    <div>
      <PageHeader title="Profiles" />
      <TableSkeleton rows={3} columns={[{ flex: true }, { width: "w-40" }, { width: "w-16" }]} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool filter summary — compact display for the Filter column.
// Shows "+N allow", "−N deny", or "all tools". Read-only (edit = ComingSoon).
// ---------------------------------------------------------------------------

function filterSummary(tf: SourceMeta["toolFilter"]): string {
  if (!tf) return "all tools"
  const parts: string[] = []
  if (tf.allow !== undefined) parts.push(`+${tf.allow.length} allow`)
  if (tf.deny !== undefined) parts.push(`−${tf.deny.length} deny`)
  return parts.length > 0 ? parts.join(", ") : "all tools"
}

function sourceStatus(s: SourceMeta): "configured" | "disabled" | "no-auth" {
  if (!s.enabled) return "disabled"
  if (s.credentialAccount === "(none)") return "no-auth"
  return "configured"
}

// ---------------------------------------------------------------------------
// Create profile dialog
// ---------------------------------------------------------------------------

interface CreateProfileDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: (newId: string) => void
}

function CreateProfileDialog({ open, onOpenChange, onSuccess }: CreateProfileDialogProps) {
  const [name, setName] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setName("")
    setError(undefined)
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError("Name is required")
      return
    }
    setSubmitting(true)
    try {
      const result = await createProfileFn({ data: { name: name.trim() } })
      if (!result.ok) {
        toast.error(`Failed to create profile: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success(`Profile "${result.name}" created`)
      handleOpenChange(false)
      onSuccess(result.id)
    } catch {
      toast.error("Failed to create profile")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Profile</DialogTitle>
          <DialogDescription>
            Create a new profile. The name must be lowercase letters, digits, and hyphens (e.g.
            "work", "personal").
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="profile-name" label="Name" error={error}>
              <Input
                id="profile-name"
                placeholder="e.g. work, personal"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (error) setError(undefined)
                }}
                hasError={!!error}
                aria-required="true"
              />
            </Field>
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Create Profile"
            submittingLabel="Creating…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Delete profile dialog — uses shared ConfirmDialog (FIX 5).
// ---------------------------------------------------------------------------

interface DeleteProfileDialogProps {
  readonly profile: ProfileMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function DeleteProfileDialog({ profile, onOpenChange, onSuccess }: DeleteProfileDialogProps) {
  // Referencing-key count — fetched fresh whenever a new profile is targeted for
  // deletion (join rows are ON DELETE CASCADE: deleting the profile silently
  // shrinks any referencing key's scope — the user should see that coming).
  const [keyCount, setKeyCount] = useState<number | null>(null)

  useEffect(() => {
    if (!profile) {
      setKeyCount(null)
      return
    }
    let cancelled = false
    countKeysReferencingProfileFn({ data: { profileId: profile.id } })
      .then((result) => {
        if (!cancelled) setKeyCount(result.count)
      })
      .catch(() => {
        if (!cancelled) setKeyCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [profile])

  async function handleConfirm(): Promise<boolean> {
    if (!profile) return false
    try {
      const result = await deleteProfileFn({ data: { profileId: profile.id } })
      if (!result.ok) {
        toast.error(`Failed to delete profile: ${result.error}`)
        return false
      }
      toast.success(`Profile "${profile.name}" deleted`)
      onSuccess()
      return true
    } catch {
      toast.error("Failed to delete profile")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={profile !== null}
      title="Delete Profile"
      description={
        <>
          Delete profile <MonoCode>{profile?.name}</MonoCode>? All routes will be removed and this
          cannot be undone.
          {keyCount !== null && keyCount > 0 && (
            <p style={{ color: "var(--status-warning-fg)", marginTop: "8px", marginBottom: 0 }}>
              {keyCount} {keyCount === 1 ? "key references" : "keys reference"} this profile and
              will lose it.
            </p>
          )}
        </>
      }
      confirmLabel="Delete Profile"
      confirmingLabel="Deleting…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Add route dialog (FIX 6: includes credential picker to complete the multi-account wedge)
// ---------------------------------------------------------------------------

// Sentinel value for "no credential" select option (public/no-auth source).
const NO_CREDENTIAL = "__none__"

interface AddRouteDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly profileId: string
  readonly platforms: PlatformMeta[]
  readonly credentials: CredentialMeta[]
  readonly onSuccess: () => void
}

function AddRouteDialog({
  open,
  onOpenChange,
  profileId,
  platforms,
  credentials,
  onSuccess,
}: AddRouteDialogProps) {
  const [platformId, setPlatformId] = useState("")
  const [credentialId, setCredentialId] = useState(NO_CREDENTIAL)
  const [namespace, setNamespace] = useState("")
  const [errors, setErrors] = useState<{ platformId?: string; namespace?: string }>({})
  const [submitting, setSubmitting] = useState(false)

  // Filter credentials to those belonging to the selected platform.
  const platformCredentials = useMemo(
    () => credentials.filter((c) => c.platformId === platformId),
    [credentials, platformId],
  )

  function reset() {
    setPlatformId("")
    setCredentialId(NO_CREDENTIAL)
    setNamespace("")
    setErrors({})
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function handlePlatformChange(id: string) {
    setPlatformId(id)
    // Reset credential selection when platform changes — previous cred belongs to old platform.
    setCredentialId(NO_CREDENTIAL)
    if (errors.platformId) setErrors((prev) => ({ ...prev, platformId: undefined }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const newErrors: typeof errors = {}
    if (!platformId) newErrors.platformId = "Platform is required"
    if (!namespace.trim()) newErrors.namespace = "Namespace is required"
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    setSubmitting(true)
    try {
      const result = await addRouteFn({
        data: {
          profileId,
          platformId,
          namespace: namespace.trim(),
          // omit credentialId when the user chose "No credential (public/no-auth)"
          ...(credentialId !== NO_CREDENTIAL ? { credentialId } : {}),
        },
      })
      if (!result.ok) {
        toast.error(`Failed to add route: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Route added")
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to add route")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Route</DialogTitle>
          <DialogDescription>
            Add a platform source to this profile. The namespace is used to prefix tool names (e.g.
            "github" → <MonoCode>github__list_repos</MonoCode>). Namespaces must be unique within a
            profile.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="route-platform" label="Platform" error={errors.platformId}>
              <Select value={platformId} onValueChange={handlePlatformChange}>
                <SelectTrigger id="route-platform" aria-required="true">
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
            {/* Credential select — shows credentials for the selected platform.
                "No credential" is always offered (public/no-auth source). */}
            <Field
              id="route-credential"
              label="Credential"
              description="Choose which account to use for this platform source."
            >
              <Select value={credentialId} onValueChange={setCredentialId}>
                <SelectTrigger id="route-credential">
                  <SelectValue placeholder="No credential (public/no-auth)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CREDENTIAL}>No credential (public/no-auth)</SelectItem>
                  {platformCredentials.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.account}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="route-namespace"
              label="Namespace"
              description="Lowercase letters, digits, underscores (no double underscores). Example: github_work"
              error={errors.namespace}
            >
              <Input
                id="route-namespace"
                placeholder="e.g. github, linear_work"
                value={namespace}
                onChange={(e) => {
                  setNamespace(e.target.value)
                  if (errors.namespace) setErrors((prev) => ({ ...prev, namespace: undefined }))
                }}
                hasError={!!errors.namespace}
                aria-required="true"
              />
            </Field>
            {/* Tool filter is set at add-route time but ComingSoon this increment —
                filter editing in-place is deferred (no core op exists for update). */}
            <div
              style={{
                fontSize: "var(--text-caption)",
                color: "var(--gray-700)",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              Tool filter (allow/deny):
              <ComingSoon />
              <span style={{ color: "var(--gray-600)" }}>— use remove + re-add to change.</span>
            </div>
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Add Route"
            submittingLabel="Adding…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Remove route confirmation dialog — uses shared ConfirmDialog (FIX 5).
// ---------------------------------------------------------------------------

interface RemoveRouteDialogProps {
  readonly route: { namespace: string } | null
  readonly onOpenChange: (open: boolean) => void
  readonly profileId: string
  readonly onSuccess: () => void
}

function RemoveRouteDialog({ route, onOpenChange, profileId, onSuccess }: RemoveRouteDialogProps) {
  async function handleConfirm(): Promise<boolean> {
    if (!route) return false
    try {
      const result = await removeRouteFn({ data: { profileId, namespace: route.namespace } })
      if (!result.ok) {
        toast.error(`Failed to remove route: ${result.error}`)
        return false
      }
      toast.success(`Route "${route.namespace}" removed`)
      onSuccess()
      return true
    } catch {
      toast.error("Failed to remove route")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={route !== null}
      title="Remove Route"
      description={
        <>
          Remove route <MonoCode>{route?.namespace}</MonoCode> from this profile? This cannot be
          undone.
        </>
      }
      confirmLabel="Remove Route"
      confirmingLabel="Removing…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Edit tool filter dialog — in-place allow/deny editing (inc 26 slice D).
// ---------------------------------------------------------------------------

// Splits a comma/newline-separated tool-name list into a trimmed, non-empty array.
function parseToolList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

interface EditFilterDialogProps {
  readonly source: SourceMeta | null
  readonly profileId: string
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function EditFilterDialog({ source, profileId, onOpenChange, onSuccess }: EditFilterDialogProps) {
  const [allowText, setAllowText] = useState("")
  const [denyText, setDenyText] = useState("")
  const [submitting, setSubmitting] = useState(false)

  // Prefill from the source's current filter whenever a new source is opened.
  const sourceNamespace = source?.namespace
  const [prefilledFor, setPrefilledFor] = useState<string | undefined>(undefined)
  if (source && sourceNamespace !== prefilledFor) {
    setAllowText(source.toolFilter?.allow?.join(", ") ?? "")
    setDenyText(source.toolFilter?.deny?.join(", ") ?? "")
    setPrefilledFor(sourceNamespace)
  }

  function reset() {
    setAllowText("")
    setDenyText("")
    setSubmitting(false)
    setPrefilledFor(undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!source) return
    const allow = parseToolList(allowText)
    const deny = parseToolList(denyText)
    const toolFilter =
      allow.length > 0 || deny.length > 0
        ? { ...(allow.length > 0 ? { allow } : {}), ...(deny.length > 0 ? { deny } : {}) }
        : undefined

    setSubmitting(true)
    try {
      const result = await setRouteFilterFn({
        data: { profileId, namespace: source.namespace, toolFilter },
      })
      if (!result.ok) {
        toast.error(`Failed to update tool filter: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success(`Tool filter updated for "${source.namespace}"`)
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to update tool filter")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={source !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Tool Access</DialogTitle>
          <DialogDescription>
            Control which upstream tools are exposed for <MonoCode>{source?.namespace}</MonoCode>.
            Leave both empty to expose all tools.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field
              id="filter-allow"
              label="Allow"
              description="Comma or newline separated tool names. If set, ONLY these tools are exposed."
            >
              <Input
                id="filter-allow"
                placeholder="e.g. list_repos, create_issue"
                value={allowText}
                onChange={(e) => setAllowText(e.target.value)}
              />
            </Field>
            <Field
              id="filter-deny"
              label="Deny"
              description="Comma or newline separated tool names to hide (applied after Allow)."
            >
              <Input
                id="filter-deny"
                placeholder="e.g. delete_repo"
                value={denyText}
                onChange={(e) => setDenyText(e.target.value)}
              />
            </Field>
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Save Filter"
            submittingLabel="Saving…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Route rows table — the right-panel detail table
// ---------------------------------------------------------------------------

const ROUTE_COL_COUNT = 6

// Sortable columns for the route table — Platform / Account / Namespace / Status.
// Filter stays unsortable (a formatted summary string, not a natural sort key).
const routeColumns: TableColumn<SourceMeta>[] = [
  { key: "platform", compare: (a, b) => a.platform.localeCompare(b.platform) },
  { key: "account", compare: (a, b) => a.credentialAccount.localeCompare(b.credentialAccount) },
  { key: "namespace", compare: (a, b) => a.namespace.localeCompare(b.namespace) },
  { key: "status", compare: (a, b) => sourceStatus(a).localeCompare(sourceStatus(b)) },
]

interface RouteTableProps {
  readonly profile: ProfileMeta
  readonly onToggle: (s: SourceMeta, enabled: boolean) => void
  readonly onRemove: (s: SourceMeta) => void
  readonly onEditFilter: (s: SourceMeta) => void
  readonly onAddRoute: () => void
  readonly onDeleteProfile: (p: ProfileMeta) => void
}

function RouteTable({
  profile,
  onToggle,
  onRemove,
  onEditFilter,
  onAddRoute,
  onDeleteProfile,
}: RouteTableProps) {
  const {
    search,
    setSearch,
    toggleSort,
    sortDirectionFor,
    page,
    pageCount,
    setPage,
    total,
    pageRows,
  } = useTableView<SourceMeta>({
    rows: profile.sources,
    searchFields: (s) => [s.platform, s.credentialAccount, s.namespace],
    columns: routeColumns,
  })

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar: route search (left) + profile actions (right). The old full-width
          ProfileHeaderBar is gone — the profile name lives in the left list. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        <Input
          id="route-search"
          type="search"
          placeholder="Search routes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
          aria-label="Search routes"
        />
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Button variant="secondary" onClick={onAddRoute}>
            <PlusCircle className="h-4 w-4" aria-hidden="true" />
            Add Route
          </Button>
          <Button variant="destructive" onClick={() => onDeleteProfile(profile)}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              sortDirection={sortDirectionFor("platform")}
              onSort={() => toggleSort("platform")}
            >
              Platform
            </TableHead>
            <TableHead
              sortDirection={sortDirectionFor("account")}
              onSort={() => toggleSort("account")}
            >
              Account
            </TableHead>
            <TableHead
              sortDirection={sortDirectionFor("namespace")}
              onSort={() => toggleSort("namespace")}
            >
              Namespace
            </TableHead>
            <TableHead>Filter</TableHead>
            <TableHead
              sortDirection={sortDirectionFor("status")}
              onSort={() => toggleSort("status")}
            >
              Status
            </TableHead>
            <TableActionsHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {total === 0 ? (
            <EmptyTableRow
              colSpan={ROUTE_COL_COUNT}
              message={
                search.trim().length > 0
                  ? "No routes match your search."
                  : "No routes in this profile."
              }
              action={
                search.trim().length > 0 ? undefined : (
                  <span style={{ fontSize: "var(--text-body)", color: "var(--gray-700)" }}>
                    Use <strong>Add Route</strong> to add one.
                  </span>
                )
              }
            />
          ) : (
            pageRows.map((s) => (
              <TableRow key={s.namespace}>
                <TableCellMono>
                  <MonoCode>{s.platform}</MonoCode>
                </TableCellMono>
                <TableCell>
                  {s.credentialAccount === "(none)" ? (
                    <span style={{ color: "var(--gray-600)", fontStyle: "italic" }}>No Auth</span>
                  ) : (
                    s.credentialAccount
                  )}
                </TableCell>
                <TableCellMono>{s.namespace}</TableCellMono>
                <TableCell>
                  <span
                    style={{
                      fontSize: "var(--text-caption)",
                      color: "var(--gray-700)",
                    }}
                    title="Tool access filter"
                  >
                    {filterSummary(s.toolFilter)}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={sourceStatus(s)} />
                </TableCell>
                <TableActionsCell
                  menu={
                    <DropdownMenuContent align="end">
                      {s.enabled ? (
                        <DropdownMenuItem onSelect={() => onToggle(s, false)}>
                          <PowerOff className="h-4 w-4" aria-hidden="true" />
                          Disable Route
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => onToggle(s, true)}>
                          <Power className="h-4 w-4" aria-hidden="true" />
                          Enable Route
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => onEditFilter(s)}>
                        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                        Edit Tool Access
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => onRemove(s)}
                        style={{ color: "var(--status-error-fg)" }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Remove Route
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  }
                />
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Pagination footer — a profile rarely has >25 routes, but the hook + footer
          are included for consistency; the footer only shows page controls when useful. */}
      <TablePagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Profile routes panel (right side) — a route-table toolbar (search + Add Route
// + Delete) then the route table + dialogs. There is no separate header bar; the
// profile name lives in the left list, the actions sit beside the route search.
// ---------------------------------------------------------------------------

interface ProfileRoutesProps {
  readonly profile: ProfileMeta
  readonly platforms: PlatformMeta[]
  readonly credentials: CredentialMeta[]
  readonly addRouteOpen: boolean
  readonly onAddRouteOpenChange: (open: boolean) => void
  readonly removingRoute: SourceMeta | null
  readonly onRemovingRouteChange: (route: SourceMeta | null) => void
  readonly editingFilterRoute: SourceMeta | null
  readonly onEditingFilterRouteChange: (route: SourceMeta | null) => void
  readonly onDeleteProfile: (p: ProfileMeta) => void
  readonly onMutate: () => void
}

function ProfileRoutes({
  profile,
  platforms,
  credentials,
  addRouteOpen,
  onAddRouteOpenChange,
  removingRoute,
  onRemovingRouteChange,
  editingFilterRoute,
  onEditingFilterRouteChange,
  onDeleteProfile,
  onMutate,
}: ProfileRoutesProps) {
  async function handleToggle(s: SourceMeta, enabled: boolean) {
    try {
      const result = await toggleRouteFn({
        data: { profileId: profile.id, namespace: s.namespace, enabled },
      })
      if (!result.ok) {
        toast.error(`Failed to ${enabled ? "enable" : "disable"} route: ${result.error}`)
        return
      }
      toast.success(`Route "${s.namespace}" ${enabled ? "enabled" : "disabled"}`)
      onMutate()
    } catch {
      toast.error(`Failed to ${enabled ? "enable" : "disable"} route`)
    }
  }

  return (
    <div style={{ minWidth: 0 }}>
      {/* Routes table */}
      <RouteTable
        profile={profile}
        onToggle={handleToggle}
        onRemove={(s) => onRemovingRouteChange(s)}
        onEditFilter={(s) => onEditingFilterRouteChange(s)}
        onAddRoute={() => onAddRouteOpenChange(true)}
        onDeleteProfile={onDeleteProfile}
      />

      {/* Dialogs */}
      <AddRouteDialog
        open={addRouteOpen}
        onOpenChange={onAddRouteOpenChange}
        profileId={profile.id}
        platforms={platforms}
        credentials={credentials}
        onSuccess={onMutate}
      />
      <RemoveRouteDialog
        route={removingRoute}
        onOpenChange={(open) => {
          if (!open) onRemovingRouteChange(null)
        }}
        profileId={profile.id}
        onSuccess={onMutate}
      />
      <EditFilterDialog
        source={editingFilterRoute}
        profileId={profile.id}
        onOpenChange={(open) => {
          if (!open) onEditingFilterRouteChange(null)
        }}
        onSuccess={onMutate}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Profile list sort button — compact sort toggle for the <nav> list panel.
// Not a <table>, so TableHead's button (which sets aria-sort on a <th>) isn't
// reusable here — aria-sort is only valid on a columnheader/th role. Same
// chevron affordance, but the accessible state is conveyed via aria-pressed +
// a direction-aware aria-label instead.
// ---------------------------------------------------------------------------

interface ProfileListSortButtonProps {
  readonly label: string
  readonly direction: SortDirection
  readonly onClick: () => void
}

function ProfileListSortButton({ label, direction, onClick }: ProfileListSortButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={direction !== "none"}
      aria-label={`Sort by ${label}${direction === "none" ? "" : `, ${direction}`}`}
      className="inline-flex items-center gap-1 hover:text-[var(--gray-1000)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1 focus-visible:rounded-[var(--radius-6)] cursor-pointer select-none"
      style={{
        fontSize: "var(--text-caption)",
        color: "var(--gray-700)",
        background: "none",
        border: "none",
        padding: "2px 0",
      }}
    >
      {label}
      <span aria-hidden="true" style={{ flexShrink: 0, opacity: direction === "none" ? 0.4 : 1 }}>
        {direction === "ascending" ? "↑" : direction === "descending" ? "↓" : "↕"}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Profile list item (left panel row)
// ---------------------------------------------------------------------------

interface ProfileListItemProps {
  readonly profile: ProfileMeta
  readonly selected: boolean
  readonly onSelect: () => void
}

function ProfileListItem({ profile, selected, onSelect }: ProfileListItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-2)",
        width: "100%",
        padding: "10px var(--space-4)",
        background: selected ? "var(--gray-100)" : "transparent",
        border: "none",
        borderRadius: "var(--radius-6)",
        cursor: "pointer",
        textAlign: "left",
        transition: `background var(--motion-fast)`,
      }}
      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-1 focus-visible:rounded-[var(--radius-6)]"
    >
      <span
        style={{
          fontSize: "var(--text-body)",
          fontWeight: selected ? 600 : 400,
          color: "var(--gray-1000)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {profile.name}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: "var(--text-caption)",
            color: "var(--gray-700)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {profile.sources.length} {profile.sources.length === 1 ? "route" : "routes"}
        </span>
        <ChevronRight
          className="h-4 w-4"
          aria-hidden="true"
          style={{ color: "var(--gray-600)", flexShrink: 0 }}
        />
      </div>
    </button>
  )
}

// Sortable "columns" for the profiles list panel — Name (alpha) / Routes (count).
// The panel itself is a <nav> list (not a <table>), so these drive compact sort
// buttons above the list rather than TableHead.
const profileListColumns: TableColumn<ProfileMeta>[] = [
  { key: "name", compare: (a, b) => a.name.localeCompare(b.name) },
  { key: "routes", compare: (a, b) => a.sources.length - b.sources.length },
]

// ---------------------------------------------------------------------------
// Main page — master-detail layout
// ---------------------------------------------------------------------------

function ProfilesPage() {
  const {
    profiles,
    platforms,
    credentials,
  }: { profiles: ProfileMeta[]; platforms: PlatformMeta[]; credentials: CredentialMeta[] } =
    Route.useLoaderData()
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(
    profiles.length > 0 ? (profiles[0]?.id ?? null) : null,
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [deletingProfile, setDeletingProfile] = useState<ProfileMeta | null>(null)
  // Hoisted from ProfileDetail so the header-bar buttons and the route table
  // row-actions both share the same dialog state.
  const [addRouteOpen, setAddRouteOpen] = useState(false)
  const [removingRoute, setRemovingRoute] = useState<SourceMeta | null>(null)
  const [editingFilterRoute, setEditingFilterRoute] = useState<SourceMeta | null>(null)

  // The selected profile, falling back to the first one if selectedId no longer exists
  // (e.g. the selected profile was deleted out of band and the list was refreshed). This
  // keeps the detail pane populated instead of blanking while other profiles remain.
  const selectedProfile = useMemo(
    () => profiles.find((p: ProfileMeta) => p.id === selectedId) ?? profiles[0] ?? null,
    [profiles, selectedId],
  )

  const {
    search: filterQuery,
    setSearch: setFilterQuery,
    toggleSort: toggleProfileSort,
    sortDirectionFor: profileSortDirectionFor,
    pageRows: filteredProfiles,
  } = useTableView<ProfileMeta>({
    rows: profiles,
    searchFields: (p) => [p.name, p.id, ...p.sources.map((s) => s.platform)],
    columns: profileListColumns,
    // The list panel has no pagination footer (a profile count that large is
    // unlikely and the panel is a nav, not a table) — pageSize covers all rows.
    pageSize: Number.MAX_SAFE_INTEGER,
  })

  async function invalidate() {
    await router.invalidate()
  }

  async function invalidateAndClearIfDeleted(deletedId: string) {
    // After delete: if the deleted profile was selected, select the first remaining one.
    if (selectedId === deletedId) {
      const remaining = profiles.filter((p: ProfileMeta) => p.id !== deletedId)
      setSelectedId(remaining.length > 0 ? (remaining[0]?.id ?? null) : null)
    }
    await router.invalidate()
  }

  return (
    <div>
      <PageHeader
        title="Profiles"
        count={profiles.length > 0 ? profiles.length : undefined}
        actions={
          <>
            <RefreshButton />
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New Profile
            </Button>
          </>
        }
      />

      {profiles.length === 0 ? (
        /* Empty state — empty table (B3) */
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Routes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* No action here — "New Profile" lives in the PageHeader (avoid duplicating). */}
            <EmptyTableRow colSpan={2} message="No profiles yet." />
          </TableBody>
        </Table>
      ) : (
        <>
          {/* Master-detail split. The old full-width ProfileHeaderBar is gone — the
              profile name is the selected item in the left list, and Add Route /
              Delete live in the route-table toolbar on the right. */}
          <div
            className="profiles-master-detail"
            style={{
              display: "flex",
              gap: "var(--space-4)",
              alignItems: "flex-start",
            }}
          >
            {/* Left — profiles list. */}
            <section
              aria-label="Profile list"
              style={{
                width: "260px",
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                // Contained border panel
                border: "1px solid var(--alpha-400)",
                borderRadius: "var(--radius-12)",
                padding: "var(--space-2)",
                background: "var(--bg-100)",
                boxShadow: "var(--shadow-sm)",
              }}
            >
              {/* List filter */}
              <div style={{ padding: "4px 4px 0" }}>
                <Input
                  type="search"
                  placeholder="Filter profiles…"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  aria-label="Filter profiles"
                  style={{ fontSize: "var(--text-caption)" }}
                />
              </div>

              {/* Sort controls — the panel is a <nav> list, not a <table>, so these
                  are compact buttons rather than TableHead. */}
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  padding: "0 4px",
                }}
              >
                <ProfileListSortButton
                  label="Name"
                  direction={profileSortDirectionFor("name")}
                  onClick={() => toggleProfileSort("name")}
                />
                <ProfileListSortButton
                  label="Routes"
                  direction={profileSortDirectionFor("routes")}
                  onClick={() => toggleProfileSort("routes")}
                />
              </div>
              <nav aria-label="Profiles">
                {filteredProfiles.length === 0 ? (
                  <p
                    style={{
                      fontSize: "var(--text-caption)",
                      color: "var(--gray-700)",
                      textAlign: "center",
                      padding: "var(--space-4)",
                      margin: 0,
                    }}
                  >
                    No profiles match.
                  </p>
                ) : (
                  filteredProfiles.map((p: ProfileMeta) => (
                    <ProfileListItem
                      key={p.id}
                      profile={p}
                      selected={p.id === selectedId}
                      onSelect={() => setSelectedId(p.id)}
                    />
                  ))
                )}
              </nav>
            </section>

            {/* Right — route table (header has moved to ProfileHeaderBar above) */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {selectedProfile !== null ? (
                <ProfileRoutes
                  profile={selectedProfile}
                  platforms={platforms}
                  credentials={credentials}
                  addRouteOpen={addRouteOpen}
                  onAddRouteOpenChange={setAddRouteOpen}
                  removingRoute={removingRoute}
                  onRemovingRouteChange={setRemovingRoute}
                  editingFilterRoute={editingFilterRoute}
                  onEditingFilterRouteChange={setEditingFilterRoute}
                  onDeleteProfile={(p) => setDeletingProfile(p)}
                  onMutate={invalidate}
                />
              ) : (
                <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>
                  Select a profile to view details.
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {/* Dialogs */}
      <CreateProfileDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSuccess={(newId) => {
          setSelectedId(newId)
          return invalidate()
        }}
      />
      <DeleteProfileDialog
        profile={deletingProfile}
        onOpenChange={(open) => {
          if (!open) setDeletingProfile(null)
        }}
        onSuccess={() => {
          // A successful delete: clear selection if the deleted profile was selected,
          // then invalidate. Only runs on actual delete (not cancel).
          const id = deletingProfile?.id
          if (id) void invalidateAndClearIfDeleted(id)
        }}
      />
    </div>
  )
}
