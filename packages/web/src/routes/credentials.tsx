// SPDX-License-Identifier: AGPL-3.0-only
// Credentials route — flat paginated table with platform group-dividers (Variant C, F12).
// Replaces the grouped-card layout (inc-24.5) with ONE table: columns ID · Platform ·
// Account · Kind (true: bearer) · Status · ⋯, group-divider rows per platform, search,
// sort (Platform/Account), and a TablePagination footer (page size 25).
// The inc-24 add/rotate/delete mutations stay wired unchanged.
// No @junction/core import. Secret is input-only; never rendered or returned.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Copy, Pencil, Plug, Plus, RefreshCw, TestTube, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import type { TableColumn } from "../lib/use-table-view.js"
import { useTableView } from "../lib/use-table-view.js"
import type { CredentialMeta, OAuthProviderMeta, PlatformMeta } from "../server/data.functions.js"
import { getCredentials, getOAuthProviders, getPlatforms } from "../server/data.functions.js"
import {
  addCredentialFn,
  removeCredentialFn,
  renameCredentialFn,
  rotateCredentialFn,
  testCredentialFn,
} from "../server/mutations.functions.js"
import { startConnectFn, startReconnectFn } from "../server/oauth-connect.functions.js"
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
  Textarea,
} from "../ui/index.js"

// Manual search validation (no zod — not a web dependency; mirrors
// oauth.callback.tsx's plain typeof checks). Drives the post-callback toast.
interface CredentialsSearch {
  connect?: "ok" | "error" | "error-state"
}

function validateCredentialsSearch(search: Record<string, unknown>): CredentialsSearch {
  const c = search.connect
  return { connect: c === "ok" || c === "error" || c === "error-state" ? c : undefined }
}

export const Route = createFileRoute("/credentials")({
  validateSearch: validateCredentialsSearch,
  loader: async () => {
    const [credentials, platforms, oauthProviders] = await Promise.all([
      getCredentials(),
      getPlatforms(),
      getOAuthProviders(),
    ])
    return { credentials, platforms, oauthProviders }
  },
  pendingComponent: CredentialsPending,
  component: CredentialsPage,
})

// ---------------------------------------------------------------------------
// Verify-result badge mapping (28.9 — makes the reserved status taxonomy real).
// "connected" renders ONLY from a persisted "ok" verify — never inferred. An
// "unreachable" result or a never-verified credential both stay "Configured"
// (honest — a network hiccup is not a verdict, and absence-of-check is not a
// green light either); auth-failed maps to the reserved Auth Failed badge.
// ---------------------------------------------------------------------------

function verifyResultToStatus(
  result: CredentialMeta["lastVerifyResult"],
): "connected" | "auth-failed" | "configured" {
  if (result === "ok") return "connected"
  if (result === "auth-failed") return "auth-failed"
  return "configured"
}

// ---------------------------------------------------------------------------
// OAuth status mapping (inc 29 — activates the reserved Expiring/Reconnect
// wires). needsReauth wins (the only "must act now" state → auth-failed/Reconnect).
// Otherwise, a REFRESHABLE credential (has a refresh token) stays Connected even
// near expiry — junction auto-refreshes it, so the expiry is a detail it manages,
// not the user's problem; surfacing "Expiring" would be a false alarm (a healthy
// Google cred, whose access token is always ≤1h, would read Expiring forever).
// "Expiring" is reserved for the ONLY actionable case: no refresh token + near
// expiry → junction can't self-heal → the user WILL need to reconnect.
// ---------------------------------------------------------------------------

const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000 // ~a day

function oauthStatus(
  oauthState: CredentialMeta["oauthState"],
  now: number,
): "connected" | "expiring" | "auth-failed" {
  if (oauthState === undefined) return "connected"
  if (oauthState.needsReauth) return "auth-failed"
  // Auto-refreshable → Connected, never Expiring. Only warn when there's no
  // refresh path AND expiry is near (the credential can't self-heal).
  if (!oauthState.hasRefreshToken && oauthState.expiresAt !== null) {
    const expiresAtMs = Date.parse(oauthState.expiresAt)
    if (!Number.isNaN(expiresAtMs) && expiresAtMs - now <= EXPIRING_WINDOW_MS) return "expiring"
  }
  return "connected"
}

// Pinned-UTC timestamp formatter (inc-27 SSR-hydration rule — see keys.tsx).
// NEVER render relative time ("2h ago"): server and client clocks/renders can
// disagree, producing a hydration mismatch. Module-scope so the Intl instance
// is built once, not per render.
const CHECKED_AT_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
})

function formatCheckedAt(ms: number): string {
  return `checked ${CHECKED_AT_FORMAT.format(new Date(ms))} UTC`
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
  /**
   * kind "file" stores multiline content (e.g. a service-account JSON or
   * kubeconfig) — a single-line password input can't hold that comfortably.
   * Swaps to a Textarea (still never rendered/echoed elsewhere — input only).
   */
  readonly multiline?: boolean
}

function SecretField({
  id,
  label,
  value,
  onChange,
  error,
  placeholder,
  multiline,
}: SecretFieldProps) {
  return (
    <Field id={id} label={label} error={error}>
      {multiline ? (
        <Textarea
          id={id}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          hasError={!!error}
          aria-required="true"
          placeholder={placeholder}
          rows={6}
        />
      ) : (
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
      )}
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Add credential dialog
// ---------------------------------------------------------------------------

interface AddDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly platforms: PlatformMeta[]
  readonly onSuccess: () => void
}

/** Human labels for the kind Select — matches core's CredentialKind values (oauth2 excluded, gated to inc 29). */
const KIND_LABELS: Record<string, string> = {
  bearer: "Bearer token",
  "api-key": "API key",
  env: "Environment variable",
  file: "File",
}

function AddCredentialDialog({ open, onOpenChange, platforms, onSuccess }: AddDialogProps) {
  const [platformId, setPlatformId] = useState("")
  const [account, setAccount] = useState("")
  const [kind, setKind] = useState("")
  const [secret, setSecret] = useState("")
  const [verify, setVerify] = useState(true)
  const [errors, setErrors] = useState<{ platformId?: string; account?: string; secret?: string }>(
    {},
  )
  const [submitting, setSubmitting] = useState(false)

  const platformMap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms])
  const selectedPlatform = platformId ? platformMap.get(platformId) : undefined
  const compatibleKinds = selectedPlatform?.compatibleKinds ?? []
  const verifiable = selectedPlatform?.verifiable ?? false

  function selectPlatform(id: string) {
    setPlatformId(id)
    // Default kind = the matrix's first (preferred) entry for the newly selected platform.
    const platform = platformMap.get(id)
    setKind(platform?.compatibleKinds[0] ?? "")
    setVerify(platform?.verifiable ?? false)
  }

  function reset() {
    setPlatformId("")
    setAccount("")
    setKind("")
    setSecret("")
    setVerify(true)
    setErrors({})
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function toastVerifyOutcome(outcome: { status: string; detail?: string; reason?: string }) {
    if (outcome.status === "ok") {
      toast.success("Connected")
    } else if (outcome.status === "auth-failed") {
      toast.error("Auth failed — check the token")
    } else if (outcome.status === "unreachable") {
      toast.warning("Couldn't reach the source")
    }
    // "not-verifiable" is silent — the checkbox is hidden for non-verifiable platforms.
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
        data: {
          platformId,
          account: account.trim(),
          kind: (kind || "bearer") as "bearer" | "api-key" | "env" | "file",
          secret,
          verify: verifiable && verify,
        },
      })
      if (!result.ok) {
        toast.error(`Failed to add credential: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Credential added")
      if (result.verify) toastVerifyOutcome(result.verify)
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
            Add a credential for a platform. The secret is never stored in plaintext.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="add-platform" label="Platform" error={errors.platformId}>
              <Select value={platformId} onValueChange={selectPlatform}>
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
            {compatibleKinds.length > 0 ? (
              <Field id="add-kind" label="Kind">
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger id="add-kind">
                    <SelectValue placeholder="Select a kind" />
                  </SelectTrigger>
                  <SelectContent>
                    {compatibleKinds.map((k) => (
                      <SelectItem key={k} value={k}>
                        {KIND_LABELS[k] ?? k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <Field
                id="add-kind"
                label="Kind"
                description={
                  platformId
                    ? "This platform does not accept a credential kind."
                    : "Select a platform to see its supported kinds."
                }
              >
                <Input id="add-kind" value="—" disabled aria-disabled="true" />
              </Field>
            )}
            <SecretField
              id="add-secret"
              label="Secret"
              value={secret}
              onChange={setSecret}
              error={errors.secret}
              placeholder={
                kind === "file"
                  ? "Paste the file content here (e.g. a service-account JSON)"
                  : "Paste your secret here"
              }
              multiline={kind === "file"}
            />
            {verifiable && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="add-verify"
                  checked={verify}
                  onCheckedChange={(checked) => setVerify(checked === true)}
                />
                <label
                  htmlFor="add-verify"
                  style={{ fontSize: "var(--text-body)", color: "var(--gray-1000)" }}
                >
                  Test connection after adding
                </label>
              </div>
            )}
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
// Edit account dialog (Task 5) — rename the account LABEL in place. The ONLY
// editable metadata: the secret stays rotate-only, and client_id is a reconnect
// concern. Pre-fills the current account; submits the trimmed new label.
// ---------------------------------------------------------------------------

// Exported for direct unit testing — the Edit action is a Radix dropdown item,
// which happy-dom can't reliably click (same limitation the Rotate/Delete tests
// document), so the dialog is exercised directly, like FlatCredentialsTable.
export function EditAccountDialog({ credential, onOpenChange, onSuccess }: RotateDialogProps) {
  const [account, setAccount] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  // Pre-fill with the current account when the dialog opens for a credential.
  // Keyed off the credential ID (not the object) so a same-id re-render with a
  // fresh object reference can't clobber an in-progress edit.
  const editingId = credential?.id
  const editingAccount = credential?.account
  useEffect(() => {
    if (editingId !== undefined) {
      setAccount(editingAccount ?? "")
      setError(undefined)
      setSubmitting(false)
    }
  }, [editingId, editingAccount])

  function handleOpenChange(next: boolean) {
    if (!next) {
      setAccount("")
      setError(undefined)
      setSubmitting(false)
    }
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!account.trim()) {
      setError("Account label is required")
      return
    }
    if (!credential) return
    setSubmitting(true)
    try {
      const result = await renameCredentialFn({
        data: { credentialId: credential.id, account: account.trim() },
      })
      if (!result.ok) {
        toast.error(`Failed to rename: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Account label updated")
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to rename")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={credential !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit account label</DialogTitle>
          <DialogDescription>
            Rename the account label for this credential on{" "}
            <MonoCode>{credential?.platformId}</MonoCode>. This is a display label only — the secret
            and connection are unchanged.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="edit-account" label="Account label" error={error}>
              <Input
                id="edit-account"
                autoComplete="off"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
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
              {submitting ? "Saving…" : "Save"}
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
// Connect (OAuth) dialog — the web "Connect" flow (inc 29, slice C). Picks a
// catalog provider, takes BYO client_id/client_secret (secret is input-only,
// NEVER rendered back), scopes, and an account name, shows the guided
// registration panel (exact redirectUri + scopes + docsUrl to register with
// the provider), then POSTs startConnectFn and navigates the BROWSER to the
// returned authorizeUrl. state/codeVerifier/clientSecret never reach this
// component — startConnectFn returns {authorizeUrl} only.
// ---------------------------------------------------------------------------

interface ConnectDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly platforms: PlatformMeta[]
  readonly oauthProviders: OAuthProviderMeta[]
}

/** Copy-able row inside the guided-registration panel. */
function RegistrationField({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable (non-secure context) — silently ignore
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>{label}</span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 10px",
          borderRadius: "var(--radius-6)",
          border: "1px solid var(--alpha-200)",
          backgroundColor: "var(--bg-200)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-mono)",
            color: "var(--gray-1000)",
            flex: 1,
            wordBreak: "break-all",
            userSelect: "text",
          }}
        >
          {value}
        </span>
        <Button type="button" variant="secondary" onClick={() => void handleCopy()}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          {copied ? "Copied!" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

function ConnectOAuthDialog({ open, onOpenChange, platforms, oauthProviders }: ConnectDialogProps) {
  const [providerId, setProviderId] = useState("")
  const [platformId, setPlatformId] = useState("")
  const [account, setAccount] = useState("")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [scopes, setScopes] = useState("")
  const [errors, setErrors] = useState<{
    providerId?: string
    platformId?: string
    account?: string
    clientId?: string
    clientSecret?: string
  }>({})
  const [submitting, setSubmitting] = useState(false)

  const providerMap = useMemo(() => new Map(oauthProviders.map((p) => [p.id, p])), [oauthProviders])
  const selectedProvider = providerId ? providerMap.get(providerId) : undefined

  function selectProvider(id: string) {
    setProviderId(id)
    const provider = providerMap.get(id)
    setScopes(provider?.defaultScopes.join(" ") ?? "")
  }

  function reset() {
    setProviderId("")
    setPlatformId("")
    setAccount("")
    setClientId("")
    setClientSecret("")
    setScopes("")
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
    if (!providerId) newErrors.providerId = "Provider is required"
    if (!platformId) newErrors.platformId = "Platform is required"
    if (!account.trim()) newErrors.account = "Account is required"
    if (!clientId.trim()) newErrors.clientId = "Client ID is required"
    if (!clientSecret) newErrors.clientSecret = "Client secret is required"
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    setSubmitting(true)
    try {
      const result = await startConnectFn({
        data: {
          providerId,
          clientId: clientId.trim(),
          clientSecret,
          scopes: scopes.split(/\s+/).filter((s) => s.length > 0),
          account: account.trim(),
          platformId,
        },
      })
      if (!result.ok) {
        toast.error(`Failed to start connect: ${result.error}`)
        setSubmitting(false)
        return
      }
      // Navigate the BROWSER to the authorize URL — this is a top-level nav,
      // not a client-side router transition (the provider's consent page is
      // off-origin). window.location is the correct primitive here.
      window.location.href = result.authorizeUrl
    } catch {
      toast.error("Failed to start connect")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect (OAuth)</DialogTitle>
          <DialogDescription>
            Register your own OAuth app with the provider, paste its client credentials here, then
            connect. junction never sees or stores your provider account password.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="connect-provider" label="Provider" error={errors.providerId}>
              <Select value={providerId} onValueChange={selectProvider}>
                <SelectTrigger id="connect-provider" aria-required="true">
                  <SelectValue placeholder="Select an OAuth provider" />
                </SelectTrigger>
                <SelectContent>
                  {oauthProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="connect-platform" label="Platform" error={errors.platformId}>
              <Select value={platformId} onValueChange={setPlatformId}>
                <SelectTrigger id="connect-platform" aria-required="true">
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
            <Field id="connect-account" label="Account" error={errors.account}>
              <Input
                id="connect-account"
                placeholder="e.g. work, personal"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                hasError={!!errors.account}
                aria-required="true"
              />
            </Field>

            {selectedProvider && (
              <div className="flex flex-col gap-2">
                <span style={{ fontSize: "var(--text-body)", color: "var(--gray-1000)" }}>
                  Register an OAuth app with {selectedProvider.displayName} using:
                </span>
                <RegistrationField
                  label="Redirect URI"
                  value={selectedProvider.registrationHint.redirectUri}
                />
                <RegistrationField
                  label="Scopes"
                  value={selectedProvider.registrationHint.scopes}
                />
                {selectedProvider.registrationHint.docsUrl && (
                  <a
                    href={selectedProvider.registrationHint.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: "var(--text-caption)", color: "var(--blue-text)" }}
                  >
                    {selectedProvider.displayName} OAuth docs
                  </a>
                )}
              </div>
            )}

            <Field id="connect-client-id" label="Client ID" error={errors.clientId}>
              <Input
                id="connect-client-id"
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                hasError={!!errors.clientId}
                aria-required="true"
              />
            </Field>
            <SecretField
              id="connect-client-secret"
              label="Client Secret"
              value={clientSecret}
              onChange={setClientSecret}
              error={errors.clientSecret}
              placeholder="Paste the client secret here"
            />
            <Field
              id="connect-scopes"
              label="Scopes"
              description="Space-separated. Pre-filled with the provider's default scopes."
            >
              <Input
                id="connect-scopes"
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
              />
            </Field>
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Connect"
            submittingLabel="Redirecting…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Reconnect dialog — needsReauth one-click fix (inc 29). Re-enters BYO client
// creds (not read back from the old refs) and re-runs the SAME connect flow
// in mode:update, repointing the existing credential's refs on success.
// ---------------------------------------------------------------------------

interface ReconnectDialogProps {
  readonly credential: CredentialMeta | null
  readonly onOpenChange: (open: boolean) => void
}

function ReconnectOAuthDialog({ credential, onOpenChange }: ReconnectDialogProps) {
  // Reconnect REUSES the stored client creds by default — the user just
  // re-authorizes (approves consent), no re-typing. "Use different credentials"
  // reveals the fields for the one case that needs new creds: the OAuth app's
  // secret was rotated provider-side.
  const [useDifferent, setUseDifferent] = useState(false)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({})
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setUseDifferent(false)
    setClientId("")
    setClientSecret("")
    setErrors({})
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (useDifferent) {
      const newErrors: typeof errors = {}
      if (!clientId.trim()) newErrors.clientId = "Client ID is required"
      if (!clientSecret) newErrors.clientSecret = "Client secret is required"
      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors)
        return
      }
    }
    if (!credential) return
    setSubmitting(true)
    try {
      // Omit client creds → the server reuses the stored ones. Only send them
      // when the user explicitly chose to swap OAuth apps.
      const result = await startReconnectFn({
        data: useDifferent
          ? { credentialId: credential.id, clientId: clientId.trim(), clientSecret }
          : { credentialId: credential.id },
      })
      if (!result.ok) {
        toast.error(`Failed to reconnect: ${result.error}`)
        setSubmitting(false)
        return
      }
      window.location.href = result.authorizeUrl
    } catch {
      toast.error("Failed to reconnect")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={credential !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconnect</DialogTitle>
          <DialogDescription>
            Re-authorize <MonoCode>{credential?.account}</MonoCode> on{" "}
            <MonoCode>{credential?.platformId}</MonoCode>.{" "}
            {useDifferent
              ? "Enter the new OAuth app's client credentials to swap them."
              : "junction reuses the OAuth app credentials you already provided — you'll just approve access again."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            {!useDifferent ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setUseDifferent(true)}
                className="self-start"
              >
                Use different client credentials
              </Button>
            ) : (
              <>
                <Field id="reconnect-client-id" label="Client ID" error={errors.clientId}>
                  <Input
                    id="reconnect-client-id"
                    autoComplete="off"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    hasError={!!errors.clientId}
                    aria-required="true"
                  />
                </Field>
                <SecretField
                  id="reconnect-client-secret"
                  label="Client Secret"
                  value={clientSecret}
                  onChange={setClientSecret}
                  error={errors.clientSecret}
                  placeholder="Paste the new client secret here"
                />
              </>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Redirecting…" : "Reconnect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  readonly onEdit: (c: CredentialMeta) => void
  readonly onTestConnection: (c: CredentialMeta) => void
  /** needsReauth oauth2 credentials show a prominent Reconnect action (inc 29). */
  readonly onReconnect: (c: CredentialMeta) => void
  /** Credential id currently mid-test, or null — disables its row's Test Connection item. */
  readonly testingId?: string | null
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
  onEdit,
  onTestConnection,
  onReconnect,
  testingId = null,
  pageSize = PAGE_SIZE,
}: FlatTableProps) {
  // A single "now" per render pass, not a fresh Date.now() per row: the
  // oauthStatus Expiring↔Connected boundary is a wall-clock threshold, so a
  // per-row inline Date.now() could cross it mid-render (rows disagreeing) or
  // differ between the SSR render and client hydration → a hydration mismatch
  // (the same class the file's CHECKED_AT_FORMAT rule guards against). Computed
  // once at mount and reused for every oauthStatus() call.
  const now = useMemo(() => Date.now(), [])
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
                const platform = platformMap.get(c.platformId)
                const platformName = platform?.displayName ?? c.platformId
                const verifiable = platform?.verifiable ?? false
                const isOAuth = c.kind === "oauth2"
                // oauth2 status is derived from oauthState (Expiring/Reconnect wires, inc 29);
                // every other kind keeps the existing persisted-verify mapping (28.9).
                const status = isOAuth
                  ? oauthStatus(c.oauthState, now)
                  : verifyResultToStatus(c.lastVerifyResult)
                const needsReauth = isOAuth && c.oauthState?.needsReauth === true
                const unreachable = c.lastVerifyResult === "unreachable"
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
                    <TableCellMono>{c.kind}</TableCellMono>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span
                          title={unreachable ? "last check couldn't reach the source" : undefined}
                        >
                          <StatusBadge status={status} />
                        </span>
                        {c.lastVerifiedAt !== undefined && (
                          <span
                            style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}
                          >
                            {formatCheckedAt(c.lastVerifiedAt)}
                          </span>
                        )}
                        {/* Prominent inline Reconnect — the one-click fix for the OAuth
                            lockout state, deliberately NOT buried in the ⋯ menu. */}
                        {needsReauth && (
                          <Button
                            type="button"
                            variant="primary"
                            onClick={() => onReconnect(c)}
                            style={{
                              height: "24px",
                              padding: "0 8px",
                              fontSize: "var(--text-caption)",
                            }}
                          >
                            <Plug className="h-3 w-3" aria-hidden="true" />
                            Reconnect
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableActionsCell
                      menu={
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => onTestConnection(c)}
                            disabled={!verifiable || testingId === c.id}
                            title={verifiable ? undefined : "not auto-verifiable for this source"}
                          >
                            <TestTube className="h-4 w-4" aria-hidden="true" />
                            {testingId === c.id ? "Testing…" : "Test Connection"}
                          </DropdownMenuItem>
                          {isOAuth ? (
                            <DropdownMenuItem onSelect={() => onReconnect(c)}>
                              <Plug className="h-4 w-4" aria-hidden="true" />
                              Reconnect
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onSelect={() => onRotate(c)}>
                              <RefreshCw className="h-4 w-4" aria-hidden="true" />
                              Rotate Secret
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => onEdit(c)}>
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                            Edit account
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

// Toast copy for the post-callback ?connect= outcome (inc 29). Kept as a plain
// map (not a component) — this is a one-shot side effect on mount/search
// change, not rendered UI.
const CONNECT_OUTCOME_MESSAGE: Record<NonNullable<CredentialsSearch["connect"]>, string> = {
  ok: "Connected",
  error: "Connect failed — the provider rejected the exchange",
  "error-state": "Connect failed — the request expired or was already used",
}

function CredentialsPage() {
  // oauthProviders defaults to [] — older test fixtures / a loader race that
  // resolves before the catalog read both degrade to an empty picker rather
  // than throwing (the Connect dialog just shows no providers to choose).
  const { credentials, platforms, oauthProviders = [] } = Route.useLoaderData()
  const { connect }: CredentialsSearch = Route.useSearch()
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [rotatingCred, setRotatingCred] = useState<CredentialMeta | null>(null)
  const [deletingCred, setDeletingCred] = useState<CredentialMeta | null>(null)
  const [reconnectingCred, setReconnectingCred] = useState<CredentialMeta | null>(null)
  const [editingCred, setEditingCred] = useState<CredentialMeta | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  // Post-/oauth/callback toast — the redirect lands here with ?connect=ok|
  // error|error-state (never a token/secret in the query). Clear the search
  // param after showing the toast so a page refresh doesn't re-toast.
  useEffect(() => {
    if (connect === "ok") {
      toast.success(CONNECT_OUTCOME_MESSAGE.ok)
    } else if (connect === "error" || connect === "error-state") {
      toast.error(CONNECT_OUTCOME_MESSAGE[connect])
    } else {
      return
    }
    void router.navigate({ to: "/credentials", search: {}, replace: true })
  }, [connect, router])

  async function invalidate() {
    await router.invalidate()
  }

  async function handleTestConnection(c: CredentialMeta) {
    setTestingId(c.id)
    try {
      const result = await testCredentialFn({ data: { credentialId: c.id } })
      if (!result.ok) {
        toast.error(`Failed to test connection: ${result.error}`)
        return
      }
      if (result.status === "ok") {
        toast.success("Connected")
      } else if (result.status === "auth-failed") {
        toast.error("Auth failed — check the token")
      } else if (result.status === "unreachable") {
        toast.warning("Couldn't reach the source")
      } else {
        toast.message(result.detail ?? "Not auto-verifiable for this source")
      }
      await invalidate()
    } catch {
      toast.error("Failed to test connection")
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Credentials"
        count={credentials.length > 0 ? credentials.length : undefined}
        actions={
          <>
            <RefreshButton />
            <Button variant="secondary" onClick={() => setConnectOpen(true)}>
              <Plug className="h-4 w-4" aria-hidden="true" />
              Connect (OAuth)
            </Button>
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
        onEdit={setEditingCred}
        onTestConnection={(c) => void handleTestConnection(c)}
        onReconnect={setReconnectingCred}
        testingId={testingId}
      />

      <ConnectOAuthDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        platforms={platforms}
        oauthProviders={oauthProviders}
      />
      <ReconnectOAuthDialog
        credential={reconnectingCred}
        onOpenChange={(open) => {
          if (!open) setReconnectingCred(null)
        }}
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
      <EditAccountDialog
        credential={editingCred}
        onOpenChange={(open) => {
          if (!open) setEditingCred(null)
        }}
        onSuccess={invalidate}
      />
    </div>
  )
}
