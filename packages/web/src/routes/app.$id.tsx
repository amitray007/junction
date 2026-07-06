// SPDX-License-Identifier: AGPL-3.0-only
// /app/:id route (increment 30.10 + 30.11) — the surface-first per-app
// capability view: for each catalog surface (MCP/OpenAPI/GraphQL/HTTP/CLI),
// show whether it's connected, its live tools (via the platform-scoped
// probe), and its catalog details. Increment 30.11 adds the one-click
// **Connect** affordance for an unconnected surface (ConnectSurfaceDialog,
// below) — token/byo modes write through the verify-gated
// connectSurfaceFn; oauth2 mode is a deep-link hand-off to /credentials
// (no inline write; see the method file's scope decision, §0).
// See docs/methods/30.10-surface-first-app-page.md,
// docs/methods/30.11-catalog-driven-connect.md + design doc §7/§4.7.
//
// Thin/undefined-catalog apps (incl. id==="other") fall back to the
// pre-30.10 flat-connections-list + EmptyAppState — surface-first is
// ADDITIVE, never worse than today (§2 item 4).
//
// The ⋯ lifecycle menu reuses ONLY shipped mutation server-fns (test/
// reconnect/rotate/rename/disconnect) — "Change method" is deferred to inc
// 30.5 (method file §5) and is NOT built here.
//
// No @junction/core import. Core/probe/connect access is only inside
// createServerFn handlers (data.functions.ts / connect.functions.ts →
// data.server.ts / connect.server.ts → probe.server.ts / core /
// source-runtime).

import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { AlertTriangle, Plug, Plus, RefreshCw, TestTube, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import type { ConnectionTarget } from "../components/connection-dialogs.js"
import {
  DisconnectDialog,
  EditAccountLabelDialog,
  RotateSecretDialog,
} from "../components/connection-dialogs.js"
import { formatCheckedAt } from "../lib/format-date.js"
import { testConnection } from "../lib/test-connection.js"
import type { ConnectFnResult } from "../server/connect.functions.js"
import { connectSurfaceFn } from "../server/connect.functions.js"
import type {
  AppDetail,
  ConnectionMeta,
  SurfaceConnectable,
  SurfaceConnection,
  SurfaceView,
} from "../server/data.functions.js"
import { getAppDetail } from "../server/data.functions.js"
import { startReconnectFn } from "../server/oauth-connect.functions.js"
import {
  Badge,
  BrandIcon,
  Button,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from "../ui/index.js"

export const Route = createFileRoute("/app/$id")({
  loader: async ({ params }): Promise<AppDetail> => {
    return getAppDetail({ data: { id: params.id } })
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
// Rotate / rename / disconnect dialogs now live in
// components/connection-dialogs.tsx (shared with credentials.tsx — rule of
// three, inc 30 jscpd dedupe). AppDetailPage maps its ConnectionMeta to the
// shared ConnectionTarget shape at each call site below (only rendered when
// credentialId is defined — a credential-less connection has nothing to
// rotate/rename/disconnect).
// ---------------------------------------------------------------------------

/** Maps a ConnectionMeta with a defined credentialId to the shared ConnectionTarget shape. */
function connectionToTarget(connection: ConnectionMeta | null): ConnectionTarget | null {
  if (connection === null || connection.credentialId === undefined) return null
  return { credentialId: connection.credentialId, account: connection.account }
}

// ---------------------------------------------------------------------------
// Auth mode label — reused for both the empty-app CTA and a surface's auth chip.
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

// ---------------------------------------------------------------------------
// Empty state — the catalog CTA (design doc §7 "Empty state"). Used both by
// the thin-app fallback (no surfaces authored) and reachable whenever an app
// has zero connections at all.
// ---------------------------------------------------------------------------

function EmptyAppState({
  displayName,
  authModes,
}: {
  readonly displayName: string
  readonly authModes: ("oauth2" | "token" | "byo" | "none")[]
}) {
  return (
    <div className="flex flex-col gap-4 py-8">
      <EmptyState
        icon={<Plug className="h-5 w-5" />}
        label={`No connections to ${displayName} yet.`}
      />
      {authModes.length > 0 && (
        <div className="flex flex-col gap-3">
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
// Connection lifecycle callbacks — the shared prop shape both ConnectionRow
// and SurfaceCard forward down to a connection row (test/reconnect/rotate/
// rename/disconnect + the in-flight testingId). Factored out once (jscpd —
// the two components' destructured prop lists were otherwise byte-identical).
// ---------------------------------------------------------------------------

interface ConnectionLifecycleProps {
  readonly now: number
  readonly onTest: (c: ConnectionMeta) => void
  readonly onReconnect: (c: ConnectionMeta) => void
  readonly onRotate: (c: ConnectionMeta) => void
  readonly onRename: (c: ConnectionMeta) => void
  readonly onDisconnect: (c: ConnectionMeta) => void
  readonly testingId: string | null
}

// ---------------------------------------------------------------------------
// Connection row — reused VERBATIM under a surface card and in the "Other
// connections" bucket and the thin-app fallback list.
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
  children,
}: ConnectionLifecycleProps & {
  readonly connection: ConnectionMeta
  /** Optional content rendered BELOW the row, inside the same <li> (e.g. a
   *  per-connection ToolsPanel under a surface card) — kept inside this <li>
   *  rather than a sibling <li> so the DOM never nests <li> inside <li>. */
  readonly children?: ReactNode
}) {
  const status = connectionStatus(connection, now)
  const isOAuth = connection.oauthState !== undefined
  const hasCredential = connection.credentialId !== undefined
  const testing = testingId !== null && testingId === connection.credentialId

  return (
    <li className="flex flex-col gap-2 py-3" style={{ borderBottom: "1px solid var(--alpha-200)" }}>
      <div className="flex items-center justify-between gap-3">
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
      </div>
      {children}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Tools panel — THREE distinct renderings (method file §2 item 2), never
// conflated: a tools list, an honest "no tools available", or a visibly
// DIFFERENT "couldn't list tools" error state.
// ---------------------------------------------------------------------------

function ToolsPanel({ tools }: { readonly tools: SurfaceConnection["tools"] }) {
  if (tools.status === "error") {
    return (
      <div
        className="flex items-center gap-2 rounded-[var(--radius-6)] px-3 py-2"
        style={{
          border: "1px solid color-mix(in srgb, var(--status-error-fg) 30%, transparent)",
          backgroundColor: "color-mix(in srgb, var(--status-error-fg) 8%, transparent)",
        }}
        role="alert"
      >
        <AlertTriangle
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--status-error-fg)" }}
          aria-hidden="true"
        />
        <span style={{ fontSize: "var(--text-caption)", color: "var(--status-error-fg)" }}>
          Couldn't list tools — {tools.reason}
        </span>
      </div>
    )
  }

  if (tools.tools.length === 0) {
    return (
      <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
        No tools available.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5 list-none m-0 p-0">
      {tools.tools.map((tool) => (
        <li key={tool.raw} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <MonoChip>{tool.raw}</MonoChip>
            {tool.params !== undefined && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-mono)",
                  color: "var(--gray-600)",
                }}
              >
                {tool.params}
              </span>
            )}
          </div>
          {tool.description !== undefined && (
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              {tool.description}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Connect (increment 30.11) — the one-click catalog-driven connect
// affordance for an unconnected surface. token/byo modes write through the
// verify-gated connectSurfaceFn (core's build recipe → source-runtime's
// verifyThenAdd/confirmThenAdd); oauth2 mode is a deep-link hand-off to
// /credentials — NO inline write (method file §0 scope decision). The button
// only renders in the `connections.length === 0` branch (SurfaceCard, above)
// — once a surface has ≥1 connection this affordance disappears by design
// (multi-account-via-Connect is deferred, §2e).
// ---------------------------------------------------------------------------

const AUTH_MODE_ORDER = ["oauth2", "token", "byo", "none"] as const

function ConnectSurfaceButton({
  appId,
  appDisplayName,
  surface,
  connectable,
  onConnected,
}: {
  readonly appId: string
  readonly appDisplayName: string
  readonly surface: SurfaceView
  readonly connectable: SurfaceConnectable
  readonly onConnected: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div>
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          <Plug className="h-4 w-4" aria-hidden="true" />
          Connect {appDisplayName} · {surface.displayName}
        </Button>
      </div>
      <ConnectSurfaceDialog
        open={open}
        onOpenChange={setOpen}
        appId={appId}
        appDisplayName={appDisplayName}
        surface={surface}
        connectable={connectable}
        onConnected={onConnected}
      />
    </>
  )
}

/** Sort a surface's offered auth modes into a stable, predictable Select order. */
function sortAuthModes(modes: SurfaceConnectable["authModes"]): SurfaceConnectable["authModes"] {
  return [...modes].sort((a, b) => AUTH_MODE_ORDER.indexOf(a) - AUTH_MODE_ORDER.indexOf(b))
}

/**
 * The mode the dialog OPENS in. Prefer the first *inline-writable* mode (token /
 * byo / none) over oauth2 — oauth2 is a deferred deep-link hand-off (§0), so
 * defaulting to it would open a verifiable surface on the one path that does
 * nothing inline and hide the working token flow behind a Select change (3
 * reviewers flagged this). oauth2 stays selectable; it just isn't the default.
 */
function defaultAuthMode(
  modes: SurfaceConnectable["authModes"],
): SurfaceConnectable["authModes"][number] {
  return modes.find((m) => m !== "oauth2") ?? modes[0] ?? "token"
}

/** Per-outcome copy for a failed verify (§2a) — never a generic "failed" string. */
function verifyFailedMessage(outcome: "auth-failed" | "unreachable"): string {
  if (outcome === "auth-failed") {
    return "Couldn't verify — authentication failed. Check the token."
  }
  return "Couldn't reach this surface — this may be a catalog/base-URL issue, not your token."
}

function ConnectSurfaceDialog({
  open,
  onOpenChange,
  appId,
  appDisplayName,
  surface,
  connectable,
  onConnected,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly appId: string
  readonly appDisplayName: string
  readonly surface: SurfaceView
  readonly connectable: SurfaceConnectable
  readonly onConnected: () => void
}) {
  const modes = useMemo(() => sortAuthModes(connectable.authModes), [connectable.authModes])
  const [authMode, setAuthMode] = useState<SurfaceConnectable["authModes"][number]>(
    defaultAuthMode(modes),
  )
  const [account, setAccount] = useState("default")
  const [secret, setSecret] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const isOAuth = authMode === "oauth2"

  function reset() {
    setAuthMode(defaultAuthMode(modes))
    setAccount("default")
    setSecret("")
    setSubmitting(false)
    setError(undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function handleAuthModeChange(mode: string) {
    setAuthMode(mode as SurfaceConnectable["authModes"][number])
    setError(undefined)
  }

  async function handleConfirm() {
    if (isOAuth) {
      // Deep-link hand-off — no server round-trip needed to navigate; the
      // provider is resolved server-side too (connectSurfaceFn), but for the
      // pure navigation case there is nothing to await.
      handleOpenChange(false)
      window.location.href = "/credentials"
      return
    }

    if (secret.trim() === "") {
      setError("A secret is required to connect this surface.")
      return
    }

    setSubmitting(true)
    setError(undefined)
    try {
      const result: ConnectFnResult = await connectSurfaceFn({
        data: {
          appId,
          surfaceKind: surface.kind,
          authMode,
          account: account.trim() || "default",
          secret,
        },
      })
      handleConnectResult(result)
    } catch {
      setError("Failed to connect this surface.")
      setSubmitting(false)
    }
  }

  function handleConnectResult(result: ConnectFnResult) {
    if ("handoff" in result) {
      handleOpenChange(false)
      window.location.href = result.handoff
      return
    }
    if ("ok" in result) {
      const checkedAt = "checkedAt" in result ? result.checkedAt : undefined
      toast.success(
        checkedAt !== undefined
          ? `Connected · ${formatCheckedAt(checkedAt)}`
          : "Saved (unverified)",
      )
      handleOpenChange(false)
      onConnected()
      return
    }
    if ("verifyFailed" in result) {
      setError(verifyFailedMessage(result.verifyFailed))
      setSubmitting(false)
      return
    }
    if ("conflict" in result) {
      setError(
        `A ${result.conflict.existingKind} platform already uses this id; connecting this surface would overwrite it. (Multi-surface-per-app is coming in a later step.)`,
      )
      setSubmitting(false)
      return
    }
    setError(result.error)
    setSubmitting(false)
  }

  const honestyNote = connectable.verifiable
    ? `junction will verify this against ${appDisplayName} before saving — nothing is stored if verification fails.`
    : "junction can't automatically verify this surface; it will be saved as you confirm."

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect this surface?</DialogTitle>
          <DialogDescription>
            {appDisplayName} · {surface.displayName}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {modes.length > 1 && (
            <Field id="connect-auth-mode" label="Auth mode">
              <Select value={authMode} onValueChange={handleAuthModeChange}>
                <SelectTrigger id="connect-auth-mode">
                  <SelectValue placeholder="Select an auth mode" />
                </SelectTrigger>
                <SelectContent>
                  {modes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {authModeLabel(mode)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {isOAuth ? (
            <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
              {appDisplayName} uses OAuth — register an OAuth app on the Credentials page.
            </p>
          ) : (
            <>
              <Field id="connect-account" label="Account">
                <Input
                  id="connect-account"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                />
              </Field>
              <Field id="connect-secret" label="Secret" error={error}>
                <Input
                  id="connect-secret"
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  hasError={error !== undefined}
                  aria-required="true"
                  placeholder="Paste your token here"
                />
              </Field>
              <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
                {honestyNote}
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={submitting || (!isOAuth && secret.trim() === "")}
            onClick={() => void handleConfirm()}
          >
            {submitting ? "Connecting…" : isOAuth ? "Continue to Credentials" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Surface card — kind tag + displayName + state, auth chip, tools panel,
// catalog details, connection rows. All surfaces render equally (§4.7).
// ---------------------------------------------------------------------------

function SurfaceCard({
  appId,
  appDisplayName,
  surface,
  now,
  onTest,
  onReconnect,
  onRotate,
  onRename,
  onDisconnect,
  onConnected,
  testingId,
}: ConnectionLifecycleProps & {
  readonly appId: string
  readonly appDisplayName: string
  readonly surface: SurfaceView
  readonly onConnected: () => void
}) {
  const primaryAuth = surface.auth[0]
  const isUnconnected = surface.connections.length === 0

  return (
    <section
      className="flex flex-col gap-3 rounded-[var(--radius-6)] p-4"
      style={{ border: "1px solid var(--alpha-200)" }}
      aria-label={surface.displayName}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Unknown/future kind: renders the raw kind string, never crashes
              (kind is `string` at the DTO edge on purpose — doc-review I5). */}
          <Badge variant="neutral">{surface.kind}</Badge>
          <span style={{ fontWeight: 500, color: "var(--gray-1000)" }}>{surface.displayName}</span>
        </div>
        <StatusBadge status={surface.state} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {primaryAuth !== undefined && <MonoChip>{authModeLabel(primaryAuth.mode)}</MonoChip>}
        {surface.docs !== undefined && (
          <a
            href={surface.docs}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "var(--text-caption)", color: "var(--blue-700)" }}
          >
            Docs
          </a>
        )}
      </div>

      {surface.agentGuidance !== undefined && (
        <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
          {surface.agentGuidance}
        </p>
      )}

      {isUnconnected && surface.connectable !== undefined && (
        <ConnectSurfaceButton
          appId={appId}
          appDisplayName={appDisplayName}
          surface={surface}
          connectable={surface.connectable}
          onConnected={onConnected}
        />
      )}

      {surface.connections.length === 0 ? (
        <ToolsPanel tools={{ status: "ok", tools: [] }} />
      ) : (
        <ul className="flex flex-col list-none m-0 p-0">
          {surface.connections.map((conn) => (
            <ConnectionRow
              key={conn.credentialId ?? `${conn.platformId}-${conn.account}`}
              connection={conn}
              now={now}
              onTest={onTest}
              onReconnect={onReconnect}
              onRotate={onRotate}
              onRename={onRename}
              onDisconnect={onDisconnect}
              testingId={testingId}
            >
              <ToolsPanel tools={conn.tools} />
            </ConnectionRow>
          ))}
        </ul>
      )}

      {surface.notes !== undefined && surface.notes.length > 0 && (
        <ul className="flex flex-col gap-1 list-none m-0 p-0">
          {surface.notes.map((note) => (
            <li key={note} style={{ fontSize: "var(--text-caption)", color: "var(--gray-600)" }}>
              {note}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function AppDetailPage() {
  const { app, surfaces, otherConnections }: AppDetail = Route.useLoaderData()
  const router = useRouter()
  const [testingId, setTestingId] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<ConnectionMeta | null>(null)
  const [rotating, setRotating] = useState<ConnectionMeta | null>(null)
  const [renaming, setRenaming] = useState<ConnectionMeta | null>(null)
  const [disconnecting, setDisconnecting] = useState<ConnectionMeta | null>(null)
  // Memoized so the Expiring/Connected boundary is stable across re-renders
  // (test/rotate/rename/disconnect state changes) + SSR-hydration consistent —
  // mirrors credentials.tsx's FlatCredentialsTable.
  const now = useMemo(() => Date.now(), [])

  async function invalidate() {
    await router.invalidate()
  }

  async function handleTest(c: ConnectionMeta) {
    if (!c.credentialId) return
    setTestingId(c.credentialId)
    try {
      await testConnection(c.credentialId, invalidate)
    } finally {
      setTestingId(null)
    }
  }

  const hasSurfaces = surfaces.length > 0
  const connectedSurfaceCount = surfaces.filter((s) => s.state !== "available").length
  const totalConnectionCount =
    surfaces.reduce((sum, s) => sum + s.connections.length, 0) + otherConnections.length

  return (
    <div>
      <PageHeader
        title={app.displayName}
        leading={<BrandIcon slug={app.iconSlug} displayName={app.displayName} />}
        subtitle={
          hasSurfaces
            ? `${surfaces.length} surfaces · ${connectedSurfaceCount} connected`
            : undefined
        }
        count={!hasSurfaces && totalConnectionCount > 0 ? totalConnectionCount : undefined}
        actions={
          totalConnectionCount > 0 ? (
            <Link to="/credentials">
              <Button variant="primary">
                <Plus className="h-4 w-4" aria-hidden="true" />
                Connect account
              </Button>
            </Link>
          ) : undefined
        }
      />

      {!hasSurfaces && otherConnections.length === 0 ? (
        <EmptyAppState displayName={app.displayName} authModes={[]} />
      ) : (
        <div className="flex flex-col gap-4">
          {hasSurfaces && (
            <div className="flex flex-col gap-4">
              {surfaces.map((surface) => (
                <SurfaceCard
                  // kind+displayName: `kind` alone can collide if a catalog
                  // ever authors two same-kind surfaces (the 30.12
                  // LIMITATION, latent today — see intersectSurfaces) —
                  // displayName is authored per-surface and distinguishes
                  // them (e.g. GitHub's http surface vs a hypothetical 2nd
                  // http surface would need distinct displayNames anyway,
                  // for the UI to be legible) — defensive, review fix.
                  key={`${surface.kind}-${surface.displayName}`}
                  appId={app.id}
                  appDisplayName={app.displayName}
                  surface={surface}
                  now={now}
                  onTest={(conn) => void handleTest(conn)}
                  onReconnect={setReconnecting}
                  onRotate={setRotating}
                  onRename={setRenaming}
                  onDisconnect={setDisconnecting}
                  onConnected={() => void invalidate()}
                  testingId={testingId}
                />
              ))}
            </div>
          )}

          {otherConnections.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: 500,
                  color: "var(--gray-900)",
                  margin: 0,
                }}
              >
                Other connections
              </h2>
              <ul className="flex flex-col list-none m-0 p-0">
                {otherConnections.map((c) => (
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
            </div>
          )}
        </div>
      )}

      <ReconnectDialog
        connection={reconnecting}
        onOpenChange={(open) => {
          if (!open) setReconnecting(null)
        }}
      />
      <RotateSecretDialog
        target={connectionToTarget(rotating)}
        onOpenChange={(open) => {
          if (!open) setRotating(null)
        }}
        onSuccess={invalidate}
      />
      <EditAccountLabelDialog
        target={connectionToTarget(renaming)}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
        onSuccess={invalidate}
      />
      <DisconnectDialog
        target={connectionToTarget(disconnecting)}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null)
        }}
        onSuccess={invalidate}
      />
    </div>
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
