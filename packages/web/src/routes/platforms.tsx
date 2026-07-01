// SPDX-License-Identifier: AGPL-3.0-only
// Platforms route — Add/Edit/Delete/Refresh write path (inc 26 slice C + wave 3 follow-up).
// inc 24.6: Base URL column removed (always `—`; noise). baseUrl shown inline under Name when present.
// wave 3: Add + Edit now share one PlatformDialog (mode: "add" | "edit"); kind Select is
// MCP/OpenAPI/GraphQL/CLI with an MCP transport sub-selector; CLI uses the guided
// CliConnectionForm; an auth-scheme note points at the Credentials page.
// No @junction/core import. All core access via createServerFn.

import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { Plus, RefreshCw, SquarePen, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { getCredentials, getPlatforms, type PlatformMeta } from "../server/data.functions.js"
import {
  type AddPlatformInput,
  addPlatformFn,
  deletePlatformFn,
  getPlatformDetailFn,
  type PlatformDetail,
  refreshPlatformFn,
  updatePlatformFn,
} from "../server/platform-mutations.functions.js"
import { MonoChip, MonoCode } from "../ui/code.js"
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
  Table,
  TableActionsCell,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from "../ui/index.js"
import { CliConnectionForm } from "./-components/cli-form/cli-connection-form.js"
import { connectionFromDetail, toConnectionInput } from "./-components/cli-form/convert.js"
import type { CliConnectionFormState } from "./-components/cli-form/types.js"
import { emptyConnection } from "./-components/cli-form/types.js"

export const Route = createFileRoute("/platforms")({
  loader: async () => {
    const [platforms, credentials] = await Promise.all([getPlatforms(), getCredentials()])
    // Derive connection counts per platform from the credential list.
    const connectionCounts = new Map<string, number>()
    for (const c of credentials) {
      connectionCounts.set(c.platformId, (connectionCounts.get(c.platformId) ?? 0) + 1)
    }
    return { platforms, connectionCounts: Object.fromEntries(connectionCounts) }
  },
  pendingComponent: PlatformsPending,
  component: PlatformsPage,
})

function PlatformsPending() {
  return (
    <div>
      <PageHeader title="Platforms" />
      <TableSkeleton
        rows={3}
        columns={[
          { width: "w-32" },
          { width: "w-24" },
          { width: "w-16" },
          { flex: true },
          { width: "w-8" },
        ]}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared PlatformDialog — Add and Edit are the same form, differing only in
// mode (add: blank state, submit → addPlatformFn) vs edit (mode: pre-filled
// from getPlatformDetailFn, submit → updatePlatformFn). See
// platform-mutations.server.ts mutateUpdatePlatform for why edit is a full
// rebuild (re-fetch/re-introspect on save), not a displayName-only patch.
//
// Kind Select offers MCP / OpenAPI / GraphQL / CLI. MCP has a Transport
// sub-select (HTTP / stdio); at submit, (kind===mcp, transport) maps to the
// server's discriminated "mcp-http" | "mcp-stdio".
//
// Auth exposed per kind (bearer-first subset — see platform-mutations.server.ts header):
//   mcp-http:  authHeader override only (bearer implied by the connection).
//   mcp-stdio: none (credential injection via tokenEnvVar stays a CLI-only flow).
//   openapi:   none | bearer | apiKey (header name).
//   graphql:   none | bearer | apiKey (header name).
//   cli:       none (connection carries its own credentialEnvVar).
// ---------------------------------------------------------------------------

type PlatformKind = "mcp" | "openapi" | "graphql" | "cli"
type McpTransport = "http" | "stdio"
type SimpleAuthScheme = "none" | "bearer" | "apiKey"

/** Auth-scheme note — points at the Credentials page where the actual secret is bound. */
function AuthSchemeNote() {
  return (
    <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
      This declares the auth scheme only. Add the actual token on the{" "}
      <Link to="/credentials" style={{ color: "var(--blue-text)" }}>
        Credentials page
      </Link>
      , then bind it to this platform in a Profile.
    </p>
  )
}

interface EnvVarRow {
  readonly id: string
  key: string
  value: string
}

let envRowCounter = 0
function emptyEnvVarRow(key = "", value = ""): EnvVarRow {
  envRowCounter += 1
  return { id: `env-${envRowCounter}`, key, value }
}

function envRowsToRecord(rows: EnvVarRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const { key, value } of rows) {
    if (key.trim()) out[key.trim()] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Repeatable [key][value][×] list for static env vars — used by mcp-stdio. */
function EnvVarListField({
  rows,
  onChange,
}: {
  readonly rows: EnvVarRow[]
  readonly onChange: (rows: EnvVarRow[]) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
        Env Vars
      </span>
      {rows.map((row, i) => (
        <div key={row.id} className="flex gap-2">
          <Input
            placeholder="KEY"
            value={row.key}
            onChange={(e) => {
              const next = [...rows]
              next[i] = { ...row, key: e.target.value }
              onChange(next)
            }}
          />
          <Input
            placeholder="value"
            value={row.value}
            onChange={(e) => {
              const next = [...rows]
              next[i] = { ...row, value: e.target.value }
              onChange(next)
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Remove env variable"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, emptyEnvVarRow()])}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add variable
      </Button>
    </div>
  )
}

interface PlatformFormState {
  kind: PlatformKind
  transport: McpTransport
  id: string
  displayName: string
  url: string
  authHeader: string
  command: string
  args: string
  tokenEnvVar: string
  env: EnvVarRow[]
  specUrl: string
  baseUrl: string
  endpoint: string
  authScheme: SimpleAuthScheme
  authName: string
  cli: CliConnectionFormState
}

function emptyFormState(): PlatformFormState {
  return {
    kind: "mcp",
    transport: "http",
    id: "",
    displayName: "",
    url: "",
    authHeader: "",
    command: "",
    args: "",
    tokenEnvVar: "",
    env: [],
    specUrl: "",
    baseUrl: "",
    endpoint: "",
    authScheme: "none",
    authName: "",
    cli: emptyConnection(),
  }
}

/** Map a getPlatformDetailFn DTO into the shared form's pre-filled state. */
function formStateFromDetail(detail: PlatformDetail): PlatformFormState {
  const base = emptyFormState()
  const authScheme: SimpleAuthScheme = detail.authScheme ?? "none"
  if (detail.kind === "mcp") {
    return {
      ...base,
      kind: "mcp",
      transport: detail.transport ?? "http",
      id: detail.id,
      displayName: detail.displayName,
      url: detail.url ?? "",
      authHeader: detail.authHeaderName ?? "",
      command: detail.command ?? "",
      args: (detail.args ?? []).join(", "),
      tokenEnvVar: detail.tokenEnvVarName ?? "",
      env: Object.entries(detail.env ?? {}).map(([key, value]) => emptyEnvVarRow(key, value)),
    }
  }
  if (detail.kind === "openapi") {
    return {
      ...base,
      kind: "openapi",
      id: detail.id,
      displayName: detail.displayName,
      specUrl: detail.specUrl ?? "",
      baseUrl: detail.baseUrl ?? "",
      authScheme,
      authName: authScheme === "apiKey" ? (detail.authHeaderOrName ?? "") : "",
    }
  }
  if (detail.kind === "graphql") {
    return {
      ...base,
      kind: "graphql",
      id: detail.id,
      displayName: detail.displayName,
      endpoint: detail.endpoint ?? "",
      authScheme,
      authName: authScheme === "apiKey" ? (detail.authHeaderOrName ?? "") : "",
    }
  }
  // cli
  return {
    ...base,
    kind: "cli",
    id: detail.id,
    displayName: detail.displayName,
    cli: connectionFromDetail(detail),
  }
}

type PlatformDialogMode = "add" | "edit"

interface PlatformDialogProps {
  readonly mode: PlatformDialogMode
  /** Non-null in edit mode: the platform being edited (also used as the open-sentinel). */
  readonly platform: PlatformMeta | null
  /** Add mode's own open flag (edit mode derives "open" from `platform !== null`). */
  readonly open?: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function PlatformDialog({ mode, platform, open, onOpenChange, onSuccess }: PlatformDialogProps) {
  const isOpen = mode === "edit" ? platform !== null : (open ?? false)
  const [state, setState] = useState<PlatformFormState>(emptyFormState())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const platformId = platform?.id

  const prefillFromDetail = useCallback(async (id: string) => {
    setLoadingDetail(true)
    try {
      const result = await getPlatformDetailFn({ data: { id } })
      if (!result.ok) {
        toast.error(`Failed to load platform: ${result.error}`)
        return
      }
      setState(formStateFromDetail(result.detail))
    } catch {
      toast.error("Failed to load platform")
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  useEffect(() => {
    if (mode !== "edit" || !isOpen || !platformId) return
    void prefillFromDetail(platformId)
  }, [mode, isOpen, platformId, prefillFromDetail])

  function reset() {
    setState(emptyFormState())
    setErrors({})
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function clearError(field: string) {
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: "" }))
  }

  function set<K extends keyof PlatformFormState>(key: K, value: PlatformFormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const newErrors: Record<string, string> = {}
    if (!state.id.trim()) newErrors.id = "ID is required"
    if (!state.displayName.trim()) newErrors.displayName = "Display name is required"
    if (state.kind === "mcp" && state.transport === "http" && !state.url.trim()) {
      newErrors.url = "URL is required"
    }
    if (state.kind === "mcp" && state.transport === "stdio" && !state.command.trim()) {
      newErrors.command = "Command is required"
    }
    if (state.kind === "openapi" && !state.specUrl.trim())
      newErrors.specUrl = "Spec URL is required"
    if (state.kind === "graphql" && !state.endpoint.trim())
      newErrors.endpoint = "Endpoint is required"
    if (state.authScheme === "apiKey" && !state.authName.trim()) {
      newErrors.authName = "Header name is required"
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    const auth =
      state.authScheme === "none"
        ? undefined
        : state.authScheme === "bearer"
          ? { scheme: "bearer" as const }
          : { scheme: "apiKey" as const, name: state.authName.trim() }

    let data: AddPlatformInput
    try {
      data =
        state.kind === "mcp"
          ? state.transport === "http"
            ? {
                kind: "mcp-http" as const,
                id: state.id.trim(),
                displayName: state.displayName.trim(),
                url: state.url.trim(),
                ...(state.authHeader.trim() ? { authHeader: state.authHeader.trim() } : {}),
              }
            : {
                kind: "mcp-stdio" as const,
                id: state.id.trim(),
                displayName: state.displayName.trim(),
                command: state.command.trim(),
                ...(state.args.trim() ? { args: state.args.split(",").map((a) => a.trim()) } : {}),
                ...(state.tokenEnvVar.trim() ? { tokenEnvVar: state.tokenEnvVar.trim() } : {}),
                ...(envRowsToRecord(state.env) ? { env: envRowsToRecord(state.env) } : {}),
              }
          : state.kind === "openapi"
            ? {
                kind: "openapi" as const,
                id: state.id.trim(),
                displayName: state.displayName.trim(),
                specUrl: state.specUrl.trim(),
                ...(state.baseUrl.trim() ? { baseUrl: state.baseUrl.trim() } : {}),
                ...(auth ? { auth } : {}),
              }
            : state.kind === "graphql"
              ? {
                  kind: "graphql" as const,
                  id: state.id.trim(),
                  displayName: state.displayName.trim(),
                  endpoint: state.endpoint.trim(),
                  ...(auth ? { auth } : {}),
                }
              : {
                  kind: "cli" as const,
                  id: state.id.trim(),
                  displayName: state.displayName.trim(),
                  connection: toConnectionInput(state.cli),
                }
    } catch {
      // JSON.parse failure from a CLI tool's advanced-mode rawJson escape hatch.
      toast.error("One or more tool descriptors have invalid JSON")
      return
    }

    setSubmitting(true)
    try {
      const result =
        mode === "add" ? await addPlatformFn({ data }) : await updatePlatformFn({ data })
      if (!result.ok) {
        toast.error(`Failed to ${mode === "add" ? "add" : "update"} platform: ${result.error}`)
        if (result.fieldErrors) setErrors((prev) => ({ ...prev, ...result.fieldErrors }))
        setSubmitting(false)
        return
      }
      toast.success(
        mode === "add" ? `Platform "${result.platform.displayName}" added` : "Platform updated",
      )
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error(`Failed to ${mode === "add" ? "add" : "update"} platform`)
      setSubmitting(false)
    }
  }

  const showAuthNote =
    state.kind === "openapi" || state.kind === "graphql"
      ? state.authScheme !== "none"
      : state.kind === "mcp" && state.transport === "http"

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Platform" : "Edit Platform"}</DialogTitle>
          <DialogDescription>
            {mode === "add" ? (
              <>
                Add a source platform. Junction discovers its tools and namespaces them under the
                platform's ID.
              </>
            ) : (
              <>
                Edit <MonoCode>{platform?.id}</MonoCode>'s connection. Saving re-runs discovery
                (re-fetches the spec for OpenAPI/GraphQL) — the same as adding fresh.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="platform-kind" label="Kind">
              <Select
                value={state.kind}
                onValueChange={(v) => set("kind", v as PlatformKind)}
                disabled={mode === "edit" && loadingDetail}
              >
                <SelectTrigger id="platform-kind">
                  <SelectValue placeholder="Select a kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mcp">MCP</SelectItem>
                  <SelectItem value="openapi">OpenAPI</SelectItem>
                  <SelectItem value="graphql">GraphQL</SelectItem>
                  <SelectItem value="cli">CLI (sandboxed)</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field id="platform-id" label="ID" error={errors.id}>
              <Input
                id="platform-id"
                placeholder="e.g. github"
                value={state.id}
                onChange={(e) => {
                  set("id", e.target.value)
                  clearError("id")
                }}
                hasError={!!errors.id}
                aria-required="true"
                disabled={mode === "edit"}
              />
            </Field>

            <Field id="platform-display-name" label="Display Name" error={errors.displayName}>
              <Input
                id="platform-display-name"
                placeholder="e.g. GitHub"
                value={state.displayName}
                onChange={(e) => {
                  set("displayName", e.target.value)
                  clearError("displayName")
                }}
                hasError={!!errors.displayName}
                aria-required="true"
              />
            </Field>

            {state.kind === "mcp" && (
              <>
                <Field id="platform-transport" label="Transport">
                  <Select
                    value={state.transport}
                    onValueChange={(v) => set("transport", v as McpTransport)}
                  >
                    <SelectTrigger id="platform-transport">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="stdio">stdio</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                {state.transport === "http" ? (
                  <>
                    <Field id="platform-url" label="URL" error={errors.url}>
                      <Input
                        id="platform-url"
                        placeholder="https://example.com/mcp"
                        value={state.url}
                        onChange={(e) => {
                          set("url", e.target.value)
                          clearError("url")
                        }}
                        hasError={!!errors.url}
                        aria-required="true"
                      />
                    </Field>
                    <Field
                      id="platform-auth-header"
                      label="Auth Header"
                      description='Header name for the bearer token. Defaults to "Authorization".'
                    >
                      <Input
                        id="platform-auth-header"
                        placeholder="Authorization"
                        value={state.authHeader}
                        onChange={(e) => set("authHeader", e.target.value)}
                      />
                    </Field>
                    <AuthSchemeNote />
                  </>
                ) : (
                  <>
                    <Field id="platform-command" label="Command" error={errors.command}>
                      <Input
                        id="platform-command"
                        placeholder="e.g. npx"
                        value={state.command}
                        onChange={(e) => {
                          set("command", e.target.value)
                          clearError("command")
                        }}
                        hasError={!!errors.command}
                        aria-required="true"
                      />
                    </Field>
                    <Field
                      id="platform-args"
                      label="Args"
                      description="Comma-separated command arguments."
                    >
                      <Input
                        id="platform-args"
                        placeholder="-y, @some/mcp-server"
                        value={state.args}
                        onChange={(e) => set("args", e.target.value)}
                      />
                    </Field>
                    <Field
                      id="platform-token-env-var"
                      label="Token Env Var"
                      description="Env var name the credential secret is injected under (optional)."
                    >
                      <Input
                        id="platform-token-env-var"
                        placeholder="e.g. GITHUB_TOKEN"
                        value={state.tokenEnvVar}
                        onChange={(e) => set("tokenEnvVar", e.target.value)}
                      />
                    </Field>
                    <EnvVarListField rows={state.env} onChange={(env) => set("env", env)} />
                  </>
                )}
              </>
            )}

            {state.kind === "openapi" && (
              <>
                <Field id="platform-spec-url" label="Spec URL" error={errors.specUrl}>
                  <Input
                    id="platform-spec-url"
                    placeholder="https://example.com/openapi.json"
                    value={state.specUrl}
                    onChange={(e) => {
                      set("specUrl", e.target.value)
                      clearError("specUrl")
                    }}
                    hasError={!!errors.specUrl}
                    aria-required="true"
                  />
                </Field>
                <Field
                  id="platform-base-url"
                  label="Base URL"
                  description="Override the spec's server URL (optional)."
                >
                  <Input
                    id="platform-base-url"
                    placeholder="https://api.example.com"
                    value={state.baseUrl}
                    onChange={(e) => set("baseUrl", e.target.value)}
                  />
                </Field>
              </>
            )}

            {state.kind === "graphql" && (
              <Field id="platform-endpoint" label="Endpoint" error={errors.endpoint}>
                <Input
                  id="platform-endpoint"
                  placeholder="https://example.com/graphql"
                  value={state.endpoint}
                  onChange={(e) => {
                    set("endpoint", e.target.value)
                    clearError("endpoint")
                  }}
                  hasError={!!errors.endpoint}
                  aria-required="true"
                />
              </Field>
            )}

            {state.kind === "cli" && (
              <CliConnectionForm connection={state.cli} onChange={(cli) => set("cli", cli)} />
            )}

            {(state.kind === "openapi" || state.kind === "graphql") && (
              <>
                <Field id="platform-auth-scheme" label="Auth">
                  <Select
                    value={state.authScheme}
                    onValueChange={(v) => set("authScheme", v as SimpleAuthScheme)}
                  >
                    <SelectTrigger id="platform-auth-scheme">
                      <SelectValue placeholder="No auth" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No auth</SelectItem>
                      <SelectItem value="bearer">Bearer token</SelectItem>
                      <SelectItem value="apiKey">API key (header)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {state.authScheme === "apiKey" && (
                  <Field id="platform-auth-name" label="Header Name" error={errors.authName}>
                    <Input
                      id="platform-auth-name"
                      placeholder="e.g. X-API-Key"
                      value={state.authName}
                      onChange={(e) => {
                        set("authName", e.target.value)
                        clearError("authName")
                      }}
                      hasError={!!errors.authName}
                      aria-required="true"
                    />
                  </Field>
                )}
                {showAuthNote && <AuthSchemeNote />}
              </>
            )}
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel={mode === "add" ? "Add Platform" : "Save Changes"}
            submittingLabel={mode === "add" ? "Adding…" : "Saving…"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Delete platform confirmation — uses shared ConfirmDialog.
// ---------------------------------------------------------------------------

interface DeletePlatformDialogProps {
  readonly platform: PlatformMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function DeletePlatformDialog({ platform, onOpenChange, onSuccess }: DeletePlatformDialogProps) {
  async function handleConfirm(): Promise<boolean> {
    if (!platform) return false
    try {
      const result = await deletePlatformFn({ data: { id: platform.id } })
      if (!result.ok) {
        toast.error(`Failed to delete platform: ${result.error}`)
        return false
      }
      toast.success(`Platform "${platform.displayName}" deleted`)
      onSuccess()
      return true
    } catch {
      toast.error("Failed to delete platform")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={platform !== null}
      title="Delete Platform"
      description={
        <>
          Delete platform <MonoCode>{platform?.displayName}</MonoCode>? This fails if any
          credentials or profile routes still reference it.
        </>
      }
      confirmLabel="Delete Platform"
      confirmingLabel="Deleting…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function PlatformsPage() {
  const { platforms, connectionCounts } = Route.useLoaderData()
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [editingPlatform, setEditingPlatform] = useState<PlatformMeta | null>(null)
  const [deletingPlatform, setDeletingPlatform] = useState<PlatformMeta | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)

  async function invalidate() {
    await router.invalidate()
  }

  async function handleRefresh(p: PlatformMeta) {
    setRefreshingId(p.id)
    try {
      const result = await refreshPlatformFn({ data: { id: p.id } })
      if (!result.ok) {
        toast.error(`Failed to refresh platform: ${result.error}`)
        return
      }
      if (result.zeroToolsWarning) {
        toast.warning(result.zeroToolsWarning)
      } else {
        toast.success(
          result.oldCount !== null
            ? `Refreshed — ${result.oldCount} → ${result.newCount} tools`
            : `Refreshed — ${result.newCount} tools`,
        )
      }
      await invalidate()
    } catch {
      toast.error("Failed to refresh platform")
    } finally {
      setRefreshingId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Platforms"
        count={platforms.length > 0 ? platforms.length : undefined}
        actions={
          <>
            <RefreshButton />
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add Platform
            </Button>
          </>
        }
      />

      {/* B3: always render the table — empty state is a full-width row, not bare text */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Connections</TableHead>
            {/* Base URL column removed inc 24.6 — always `—` for MCP platforms, pure noise. */}
            <TableActionsHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {platforms.length === 0 ? (
            <EmptyTableRow
              colSpan={4}
              message="No platforms yet."
              action={
                <span style={{ fontSize: "var(--text-body)", color: "var(--gray-700)" }}>
                  Use <strong>Add Platform</strong> above.
                </span>
              }
            />
          ) : (
            platforms.map((p: PlatformMeta) => (
              <TableRow key={p.id}>
                <TableCell>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ fontWeight: 500 }}>{p.displayName}</span>
                    {/* baseUrl shown inline only when present — avoids the always-empty column */}
                    {p.baseUrl ? (
                      <MonoCode style={{ color: "var(--gray-600)", fontSize: "var(--text-mono)" }}>
                        {p.baseUrl}
                      </MonoCode>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <MonoChip>{p.kind}</MonoChip>
                </TableCell>
                <TableCell>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-mono)",
                      color: "var(--gray-900)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {connectionCounts[p.id] ?? 0}
                  </span>
                </TableCell>
                <TableActionsCell
                  menu={
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditingPlatform(p)}>
                        <SquarePen className="h-4 w-4" aria-hidden="true" />
                        Edit
                      </DropdownMenuItem>
                      {p.kind === "openapi" && (
                        <DropdownMenuItem
                          disabled={refreshingId === p.id}
                          onSelect={() => void handleRefresh(p)}
                        >
                          <RefreshCw className="h-4 w-4" aria-hidden="true" />
                          {refreshingId === p.id ? "Refreshing…" : "Refresh"}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => setDeletingPlatform(p)}
                        style={{ color: "var(--status-error-fg)" }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  }
                />
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Dialogs — Add and Edit share PlatformDialog (see its header comment). */}
      <PlatformDialog
        mode="add"
        platform={null}
        open={addOpen}
        onOpenChange={setAddOpen}
        onSuccess={invalidate}
      />
      <PlatformDialog
        mode="edit"
        platform={editingPlatform}
        onOpenChange={(open) => {
          if (!open) setEditingPlatform(null)
        }}
        onSuccess={invalidate}
      />
      <DeletePlatformDialog
        platform={deletingPlatform}
        onOpenChange={(open) => {
          if (!open) setDeletingPlatform(null)
        }}
        onSuccess={invalidate}
      />
    </div>
  )
}
