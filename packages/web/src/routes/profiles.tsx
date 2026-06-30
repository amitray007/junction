// SPDX-License-Identifier: AGPL-3.0-only
// Profiles route — master-detail layout (Variant C, F13) + profile route editing (E11b).
// Left: profiles list (name + route count + › — no platform chips, inc-25 feedback).
// Right: selected profile detail — route rows table + editing actions.
//
// HONESTY GUARDS:
// - Edit tool access (filter update in-place) = ComingSoon: no core op exists
//   (SourceOp is only delete|setEnabled). Filter shown read-only with subtle hint.
//   Filters are set at ADD-route time only.
// - "N keys active" removed — was ComingSoon with no near-term plan (inc-25 feedback).
// - No per-profile HTTP endpoint URL (single-endpoint model — show CLI command).
//
// Responsive: at <700px the split stacks list-above-detail (CSS media query).
// No @junction/core import. All core access via createServerFn.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { ChevronRight, Plus, PlusCircle, Power, PowerOff, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import type {
  CredentialMeta,
  PlatformMeta,
  ProfileMeta,
  SourceMeta,
} from "../server/data.functions.js"
import { getCredentials, getPlatforms, getProfiles } from "../server/data.functions.js"
import {
  addRouteFn,
  createProfileFn,
  deleteProfileFn,
  removeRouteFn,
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
  DialogFooter,
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
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Creating…" : "Create Profile"}
            </Button>
          </DialogFooter>
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
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Adding…" : "Add Route"}
            </Button>
          </DialogFooter>
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
// Route rows table — the right-panel detail table
// ---------------------------------------------------------------------------

const ROUTE_COL_COUNT = 6

interface RouteTableProps {
  readonly profile: ProfileMeta
  readonly onToggle: (s: SourceMeta, enabled: boolean) => void
  readonly onRemove: (s: SourceMeta) => void
}

function RouteTable({ profile, onToggle, onRemove }: RouteTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Platform</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Namespace</TableHead>
          <TableHead>Filter</TableHead>
          <TableHead>Status</TableHead>
          <TableActionsHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {profile.sources.length === 0 ? (
          <EmptyTableRow
            colSpan={ROUTE_COL_COUNT}
            message="No routes in this profile."
            action={
              <span style={{ fontSize: "var(--text-body)", color: "var(--gray-700)" }}>
                Use <strong>Add Route</strong> to add one.
              </span>
            }
          />
        ) : (
          profile.sources.map((s) => (
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
                {/* Filter is read-only; editing in-place = ComingSoon (no core op for update).
                    The add-route dialog sets the filter at creation time. */}
                <span
                  style={{
                    fontSize: "var(--text-caption)",
                    color: "var(--gray-700)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                  title="Edit coming soon — remove and re-add the route to change the filter"
                >
                  {filterSummary(s.toolFilter)}
                  {s.toolFilter && (
                    <span
                      style={{ fontSize: "var(--text-caption)", color: "var(--gray-600)" }}
                      aria-hidden="true"
                    >
                      (read-only)
                    </span>
                  )}
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
  )
}

// ---------------------------------------------------------------------------
// Profile header bar — full-width, rendered ABOVE the master-detail split.
// Contains: profile name (h2) + CLI serve line (left), Add Route + Delete (right).
// ---------------------------------------------------------------------------

interface ProfileHeaderBarProps {
  readonly profile: ProfileMeta
  readonly onAddRoute: () => void
  readonly onDeleteProfile: (p: ProfileMeta) => void
}

function ProfileHeaderBar({ profile, onAddRoute, onDeleteProfile }: ProfileHeaderBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        flexWrap: "wrap",
        marginBottom: "var(--space-4)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h2
          style={{
            fontSize: "var(--text-h2)",
            fontWeight: 600,
            color: "var(--gray-1000)",
            margin: 0,
          }}
        >
          {profile.name}
        </h2>
        {/* CLI serve command — the single-endpoint model (no per-profile HTTP URL) */}
        <p
          style={{
            fontSize: "var(--text-caption)",
            color: "var(--gray-700)",
            margin: "4px 0 0",
          }}
        >
          Serve via{" "}
          <MonoCode style={{ color: "var(--blue-text)" }}>
            junction mcp serve --profile {profile.name}
          </MonoCode>
        </p>
      </div>

      {/* Actions */}
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
  )
}

// ---------------------------------------------------------------------------
// Profile routes panel (right side) — route table + dialogs only (no header).
// Header has been lifted to ProfileHeaderBar (full-width above the split).
// ---------------------------------------------------------------------------

interface ProfileRoutesProps {
  readonly profile: ProfileMeta
  readonly platforms: PlatformMeta[]
  readonly credentials: CredentialMeta[]
  readonly addRouteOpen: boolean
  readonly onAddRouteOpenChange: (open: boolean) => void
  readonly removingRoute: SourceMeta | null
  readonly onRemovingRouteChange: (route: SourceMeta | null) => void
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
    </div>
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
  const [filterQuery, setFilterQuery] = useState("")
  // Hoisted from ProfileDetail so the header-bar buttons and the route table
  // row-actions both share the same dialog state.
  const [addRouteOpen, setAddRouteOpen] = useState(false)
  const [removingRoute, setRemovingRoute] = useState<SourceMeta | null>(null)

  const selectedProfile = useMemo(
    () => profiles.find((p: ProfileMeta) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  )

  const filteredProfiles = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter(
      (p: ProfileMeta) =>
        p.name.toLowerCase().includes(q) ||
        p.sources.some((s: SourceMeta) => s.platform.toLowerCase().includes(q)),
    )
  }, [profiles, filterQuery])

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
          {/* Full-width profile header bar — rendered ABOVE the split when a profile is
              selected, so both the left list panel and the right route table start at the
              same row naturally (no offset hack needed). */}
          {selectedProfile !== null && (
            <ProfileHeaderBar
              profile={selectedProfile}
              onAddRoute={() => setAddRouteOpen(true)}
              onDeleteProfile={(p) => setDeletingProfile(p)}
            />
          )}

          {/* Master-detail split */}
          <div
            className="profiles-master-detail"
            style={{
              display: "flex",
              gap: "var(--space-4)",
              alignItems: "flex-start",
            }}
          >
            {/* Left — profiles list. No marginTop offset needed: the header bar lives
                above the split, so both columns naturally top-align. */}
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
