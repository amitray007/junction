// SPDX-License-Identifier: AGPL-3.0-only
// /app/:id route (increment 30) — the per-app page: a list of the user's
// connections to this app (design doc §7), or an empty-state catalog CTA.
//
// id === "other" renders the synthetic "Other / uncatalogued" group — it is
// NOT in the catalog (getApp("other") returns undefined), so it is handled
// as a special case rather than calling getApp.
//
// The ⋯ lifecycle menu reuses ONLY shipped mutation server-fns (test/
// reconnect/rotate/rename/disconnect) — "Change method" is deferred to inc
// 30.5 (method file §5) and is NOT built here.
//
// No @junction/core import. Core access is only inside getApps' createServerFn.

import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router"
import { Plug, Plus, RefreshCw, TestTube, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { formatCheckedAt } from "../lib/format-date.js"
import type { AppMeta, AppsData, ConnectionMeta } from "../server/data.functions.js"
import { getApps } from "../server/data.functions.js"
import {
  removeCredentialFn,
  renameCredentialFn,
  rotateCredentialFn,
  testCredentialFn,
} from "../server/mutations.functions.js"
import { startReconnectFn } from "../server/oauth-connect.functions.js"
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
  EmptyState,
  Field,
  Input,
  MonoChip,
  MonoCode,
  PageHeader,
  RowActionsMenu,
  StatusBadge,
} from "../ui/index.js"

// The synthetic "Other" bucket is not a catalog AppDefinition — this is the
// fixed display shape used when id === "other" (method file §3, item 3). A
// plain unauthed/uncatalogued display record also covers the "app resolved
// only via connections, not in the catalog" edge (shouldn't normally happen
// given groupByApp only ever emits catalog ids or "other", but kept honest).
export interface AppDisplay {
  id: string
  displayName: string
  supportedKinds: string[]
  auth?: AppMeta["auth"]
  setupHints?: string[]
}

const OTHER_APP_DISPLAY: AppDisplay = {
  id: "other",
  displayName: "Other",
  supportedKinds: [],
}

interface AppDetailLoaderData {
  app: AppDisplay
  connections: ConnectionMeta[]
}

function loadAppDetail(id: string, { catalog, groups }: AppsData): AppDetailLoaderData {
  if (id === "other") {
    const group = groups.find((g) => g.appId === "other")
    return { app: OTHER_APP_DISPLAY, connections: group?.connections ?? [] }
  }

  const app = catalog.find((a) => a.id === id)
  const group = groups.find((g) => g.appId === id)
  // Unknown id: not in the catalog AND no connections attributed to it → 404.
  if (app === undefined && (group === undefined || group.connections.length === 0)) {
    throw notFound()
  }
  return {
    app: app ?? { id, displayName: id, supportedKinds: [] },
    connections: group?.connections ?? [],
  }
}

export const Route = createFileRoute("/app/$id")({
  loader: async ({ params }): Promise<AppDetailLoaderData> => {
    const data = await getApps()
    return loadAppDetail(params.id, data)
  },
  component: AppDetailPage,
})

// ---------------------------------------------------------------------------
// Status mapping — mirrors credentials.tsx's verifyResultToStatus/oauthStatus
// (rule of three not yet hit at 2 call sites, but kept identical so a
// connection's badge and the Credentials table's badge for the SAME
// credential never disagree).
// ---------------------------------------------------------------------------

const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000

function connectionStatus(
  conn: ConnectionMeta,
  now: number,
): "connected" | "expiring" | "auth-failed" | "configured" | "no-auth" {
  if (conn.credentialId === undefined) return "no-auth" // public/credential-less connection
  if (conn.oauthState !== undefined) {
    if (conn.oauthState.needsReauth) return "auth-failed"
    if (!conn.oauthState.hasRefreshToken && conn.oauthState.expiresAt !== null) {
      const expiresAtMs = Date.parse(conn.oauthState.expiresAt)
      if (!Number.isNaN(expiresAtMs) && expiresAtMs - now <= EXPIRING_WINDOW_MS) return "expiring"
    }
    return "connected"
  }
  if (conn.lastVerifyResult === "ok") return "connected"
  if (conn.lastVerifyResult === "auth-failed") return "auth-failed"
  return "configured"
}

// ---------------------------------------------------------------------------
// Rotate dialog (non-oauth connections only) — mirrors credentials.tsx's
// RotateCredentialDialog, scoped to a ConnectionMeta instead of CredentialMeta.
// ---------------------------------------------------------------------------

interface RotateDialogProps {
  readonly connection: ConnectionMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function RotateConnectionDialog({ connection, onOpenChange, onSuccess }: RotateDialogProps) {
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
    if (!connection?.credentialId) return
    setSubmitting(true)
    try {
      const result = await rotateCredentialFn({
        data: { credentialId: connection.credentialId, newSecret },
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
    <Dialog open={connection !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate Credential</DialogTitle>
          <DialogDescription>
            Enter a new secret for <MonoCode>{connection?.account}</MonoCode>. The old secret is
            deleted from the store on success.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="app-rotate-secret" label="New secret" error={error}>
              <Input
                id="app-rotate-secret"
                type="password"
                autoComplete="new-password"
                value={newSecret}
                onChange={(e) => setNewSecret(e.target.value)}
                hasError={!!error}
                aria-required="true"
                placeholder="Paste new secret here"
              />
            </Field>
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
// Rename dialog — mirrors credentials.tsx's EditAccountDialog.
// ---------------------------------------------------------------------------

function RenameConnectionDialog({ connection, onOpenChange, onSuccess }: RotateDialogProps) {
  const [account, setAccount] = useState(connection?.account ?? "")
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  const editingId = connection?.credentialId

  function handleOpenChange(next: boolean) {
    if (!next) {
      setAccount("")
      setError(undefined)
      setSubmitting(false)
    } else {
      setAccount(connection?.account ?? "")
    }
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!account.trim()) {
      setError("Account label is required")
      return
    }
    if (!editingId) return
    setSubmitting(true)
    try {
      const result = await renameCredentialFn({
        data: { credentialId: editingId, account: account.trim() },
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
    <Dialog open={connection !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit account label</DialogTitle>
          <DialogDescription>
            Rename the account label for this connection. This is a display label only — the secret
            and connection are unchanged.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="app-rename-account" label="Account label" error={error}>
              <Input
                id="app-rename-account"
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
// Disconnect confirmation — mirrors credentials.tsx's DeleteCredentialDialog.
// ---------------------------------------------------------------------------

interface DisconnectDialogProps {
  readonly connection: ConnectionMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function DisconnectDialog({ connection, onOpenChange, onSuccess }: DisconnectDialogProps) {
  async function handleConfirm(): Promise<boolean> {
    if (!connection?.credentialId) return false
    try {
      const result = await removeCredentialFn({ data: { credentialId: connection.credentialId } })
      if (!result.ok) {
        toast.error(`Failed to disconnect: ${result.error}`)
        return false
      }
      toast.success("Disconnected")
      onSuccess()
      return true
    } catch {
      toast.error("Failed to disconnect")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={connection !== null}
      title="Disconnect"
      description={
        <>
          Disconnect <MonoCode>{connection?.account}</MonoCode>? This removes the credential from
          the store and cannot be undone.
        </>
      }
      confirmLabel="Disconnect"
      confirmingLabel="Disconnecting…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Empty state — the catalog CTA (design doc §7 "Empty state").
// ---------------------------------------------------------------------------

function authModeLabel(mode: "oauth2" | "token" | "byo" | "none"): string {
  switch (mode) {
    case "oauth2":
      return "Connect via OAuth"
    case "token":
      return "Paste a token"
    case "byo":
      return "Bring your own connection details"
    case "none":
      return "No credential required"
    default: {
      const _: never = mode
      return _
    }
  }
}

function EmptyAppState({ app }: { readonly app: AppDisplay }) {
  const authModes = app.auth?.map((a) => a.mode) ?? []
  const hint = app.setupHints

  return (
    <div className="flex flex-col gap-4 py-8">
      <EmptyState
        icon={<Plug className="h-5 w-5" />}
        label={`No connections to ${app.displayName} yet.`}
        hint={
          app.supportedKinds.length > 0
            ? `junction can stand up: ${app.supportedKinds.join(", ")}.`
            : undefined
        }
      />
      {(authModes.length > 0 || (hint && hint.length > 0)) && (
        <div className="flex flex-col gap-3">
          {authModes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {authModes.map((mode) => (
                <span
                  key={mode}
                  style={{
                    fontSize: "var(--text-caption)",
                    color: "var(--gray-700)",
                    border: "1px solid var(--alpha-400)",
                    borderRadius: "var(--radius-6)",
                    padding: "4px 8px",
                  }}
                >
                  {authModeLabel(mode)}
                </span>
              ))}
            </div>
          )}
          {hint?.map((h) => (
            <p key={h} style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              {h}
            </p>
          ))}
          <div className="flex gap-2">
            {/* Connect hand-off: junction doesn't build a new connect flow here — it
                links to the existing Credentials/Platforms surfaces (method file §3,
                item 3). The Connect (OAuth) + Add Credential dialogs already select a
                provider/platform there; there is no per-app pre-filled deep link yet. */}
            {authModes.includes("oauth2") && (
              <Link to="/credentials">
                <Button variant="primary">
                  <Plug className="h-4 w-4" aria-hidden="true" />
                  Connect (OAuth)
                </Button>
              </Link>
            )}
            {(authModes.includes("token") || authModes.includes("byo")) && (
              <Link to="/credentials">
                <Button variant="secondary">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add Credential
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Connection row
// ---------------------------------------------------------------------------

function ConnectionRow({
  connection,
  now,
  onTest,
  onReconnect,
  onRotate,
  onRename,
  onDisconnect,
  testingId,
}: {
  readonly connection: ConnectionMeta
  readonly now: number
  readonly onTest: (c: ConnectionMeta) => void
  readonly onReconnect: (c: ConnectionMeta) => void
  readonly onRotate: (c: ConnectionMeta) => void
  readonly onRename: (c: ConnectionMeta) => void
  readonly onDisconnect: (c: ConnectionMeta) => void
  readonly testingId: string | null
}) {
  const status = connectionStatus(connection, now)
  const isOAuth = connection.oauthState !== undefined
  const hasCredential = connection.credentialId !== undefined
  const testing = testingId !== null && testingId === connection.credentialId

  return (
    <li
      className="flex items-center justify-between gap-3 py-3"
      style={{ borderBottom: "1px solid var(--alpha-200)" }}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ fontWeight: 500, color: "var(--gray-1000)" }}>{connection.account}</span>
          <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
            via {connection.kind}
          </span>
          <MonoChip>{connection.platformDisplayName}</MonoChip>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          {connection.lastVerifiedAt !== undefined && (
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              {formatCheckedAt(connection.lastVerifiedAt)}
            </span>
          )}
        </div>
      </div>
      {hasCredential && (
        <RowActionsMenu
          menu={
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onTest(connection)} disabled={testing}>
                <TestTube className="h-4 w-4" aria-hidden="true" />
                {testing ? "Testing…" : "Test Connection"}
              </DropdownMenuItem>
              {isOAuth ? (
                <DropdownMenuItem onSelect={() => onReconnect(connection)}>
                  <Plug className="h-4 w-4" aria-hidden="true" />
                  Reconnect
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onRotate(connection)}>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Rotate Secret
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => onRename(connection)}>Rename</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onDisconnect(connection)}
                style={{ color: "var(--status-error-fg)" }}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          }
        />
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Reconnect dialog — thin wrapper reusing startReconnectFn, scoped to a
// ConnectionMeta (mirrors credentials.tsx's ReconnectOAuthDialog, minus the
// "use different credentials" advanced path — kept here for parity/simplicity
// since the credential-id based reconnect is identical either way; the
// advanced swap-creds path is reachable from Credentials if ever needed).
// ---------------------------------------------------------------------------

function ReconnectDialog({
  connection,
  onOpenChange,
}: {
  readonly connection: ConnectionMeta | null
  readonly onOpenChange: (open: boolean) => void
}) {
  const [submitting, setSubmitting] = useState(false)

  function handleOpenChange(next: boolean) {
    if (!next) setSubmitting(false)
    onOpenChange(next)
  }

  async function handleReconnect() {
    if (!connection?.credentialId) return
    setSubmitting(true)
    try {
      const result = await startReconnectFn({ data: { credentialId: connection.credentialId } })
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
    <Dialog open={connection !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconnect</DialogTitle>
          <DialogDescription>
            Re-authorize <MonoCode>{connection?.account}</MonoCode>. junction reuses the OAuth app
            credentials you already provided — you'll just approve access again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={submitting}
            onClick={() => void handleReconnect()}
          >
            {submitting ? "Redirecting…" : "Reconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function AppDetailPage() {
  const { app, connections }: AppDetailLoaderData = Route.useLoaderData()
  const router = useRouter()
  const [testingId, setTestingId] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<ConnectionMeta | null>(null)
  const [rotating, setRotating] = useState<ConnectionMeta | null>(null)
  const [renaming, setRenaming] = useState<ConnectionMeta | null>(null)
  const [disconnecting, setDisconnecting] = useState<ConnectionMeta | null>(null)
  const now = Date.now()

  async function invalidate() {
    await router.invalidate()
  }

  async function handleTest(c: ConnectionMeta) {
    if (!c.credentialId) return
    setTestingId(c.credentialId)
    try {
      const result = await testCredentialFn({ data: { credentialId: c.credentialId } })
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
        title={app.displayName}
        count={connections.length > 0 ? connections.length : undefined}
        actions={
          connections.length > 0 ? (
            <Link to="/credentials">
              <Button variant="primary">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Connect account
              </Button>
            </Link>
          ) : undefined
        }
      />

      {connections.length === 0 ? (
        <EmptyAppState app={app} />
      ) : (
        <ul className="flex flex-col list-none m-0 p-0">
          {connections.map((c) => (
            <ConnectionRow
              key={c.credentialId ?? `${c.platformId}-${c.account}`}
              connection={c}
              now={now}
              onTest={(conn) => void handleTest(conn)}
              onReconnect={setReconnecting}
              onRotate={setRotating}
              onRename={setRenaming}
              onDisconnect={setDisconnecting}
              testingId={testingId}
            />
          ))}
        </ul>
      )}

      <ReconnectDialog
        connection={reconnecting}
        onOpenChange={(open) => {
          if (!open) setReconnecting(null)
        }}
      />
      <RotateConnectionDialog
        connection={rotating}
        onOpenChange={(open) => {
          if (!open) setRotating(null)
        }}
        onSuccess={invalidate}
      />
      <RenameConnectionDialog
        connection={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
        onSuccess={invalidate}
      />
      <DisconnectDialog
        connection={disconnecting}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null)
        }}
        onSuccess={invalidate}
      />
    </div>
  )
}
