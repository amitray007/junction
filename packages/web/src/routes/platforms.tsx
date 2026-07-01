// SPDX-License-Identifier: AGPL-3.0-only
// Platforms route — Add/Edit/Delete/Refresh write path (inc 26 slice C).
// inc 24.6: Base URL column removed (always `—`; noise). baseUrl shown inline under Name when present.
// No @junction/core import. All core access via createServerFn.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Plus, RefreshCw, SquarePen, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { getCredentials, getPlatforms, type PlatformMeta } from "../server/data.functions.js"
import {
  addPlatformFn,
  deletePlatformFn,
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
// Add Platform dialog — kind-select + kind-specific fields.
//
// Auth exposed per kind (bearer-first subset — see platform-mutations.server.ts header):
//   mcp-http:  authHeader override only (bearer implied by the connection).
//   mcp-stdio: none (credential injection via tokenEnvVar stays a CLI-only flow).
//   openapi:   none | bearer | apiKey (header name).
//   graphql:   none | bearer | apiKey (header name).
//   cli:       none (descriptor JSON carries its own credentialEnvVar).
// ---------------------------------------------------------------------------

type PlatformKindOption = "mcp-http" | "mcp-stdio" | "openapi" | "graphql" | "cli"
type SimpleAuthScheme = "none" | "bearer" | "apiKey"

interface AddPlatformDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function AddPlatformDialog({ open, onOpenChange, onSuccess }: AddPlatformDialogProps) {
  const [kind, setKind] = useState<PlatformKindOption>("mcp-http")
  const [id, setId] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [url, setUrl] = useState("")
  const [authHeader, setAuthHeader] = useState("")
  const [command, setCommand] = useState("")
  const [args, setArgs] = useState("")
  const [tokenEnvVar, setTokenEnvVar] = useState("")
  const [specUrl, setSpecUrl] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [descriptor, setDescriptor] = useState("")
  const [authScheme, setAuthScheme] = useState<SimpleAuthScheme>("none")
  const [authName, setAuthName] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setKind("mcp-http")
    setId("")
    setDisplayName("")
    setUrl("")
    setAuthHeader("")
    setCommand("")
    setArgs("")
    setTokenEnvVar("")
    setSpecUrl("")
    setBaseUrl("")
    setEndpoint("")
    setDescriptor("")
    setAuthScheme("none")
    setAuthName("")
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const newErrors: Record<string, string> = {}
    if (!id.trim()) newErrors.id = "ID is required"
    if (!displayName.trim()) newErrors.displayName = "Display name is required"
    if (kind === "mcp-http" && !url.trim()) newErrors.url = "URL is required"
    if (kind === "mcp-stdio" && !command.trim()) newErrors.command = "Command is required"
    if (kind === "openapi" && !specUrl.trim()) newErrors.specUrl = "Spec URL is required"
    if (kind === "graphql" && !endpoint.trim()) newErrors.endpoint = "Endpoint is required"
    if (kind === "cli" && !descriptor.trim()) newErrors.descriptor = "Descriptor is required"
    if (authScheme === "apiKey" && !authName.trim()) newErrors.authName = "Header name is required"
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    const auth =
      authScheme === "none"
        ? undefined
        : authScheme === "bearer"
          ? { scheme: "bearer" as const }
          : { scheme: "apiKey" as const, name: authName.trim() }

    const data =
      kind === "mcp-http"
        ? {
            kind,
            id: id.trim(),
            displayName: displayName.trim(),
            url: url.trim(),
            ...(authHeader.trim() ? { authHeader: authHeader.trim() } : {}),
          }
        : kind === "mcp-stdio"
          ? {
              kind,
              id: id.trim(),
              displayName: displayName.trim(),
              command: command.trim(),
              ...(args.trim() ? { args: args.split(",").map((a) => a.trim()) } : {}),
              ...(tokenEnvVar.trim() ? { tokenEnvVar: tokenEnvVar.trim() } : {}),
            }
          : kind === "openapi"
            ? {
                kind,
                id: id.trim(),
                displayName: displayName.trim(),
                specUrl: specUrl.trim(),
                ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                ...(auth ? { auth } : {}),
              }
            : kind === "graphql"
              ? {
                  kind,
                  id: id.trim(),
                  displayName: displayName.trim(),
                  endpoint: endpoint.trim(),
                  ...(auth ? { auth } : {}),
                }
              : {
                  kind,
                  id: id.trim(),
                  displayName: displayName.trim(),
                  descriptor: descriptor.trim(),
                }

    setSubmitting(true)
    try {
      const result = await addPlatformFn({ data })
      if (!result.ok) {
        toast.error(`Failed to add platform: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success(`Platform "${result.platform.displayName}" added`)
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to add platform")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Platform</DialogTitle>
          <DialogDescription>
            Add a source platform. Junction discovers its tools and namespaces them under the
            platform's ID.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="platform-kind" label="Kind">
              <Select value={kind} onValueChange={(v) => setKind(v as PlatformKindOption)}>
                <SelectTrigger id="platform-kind">
                  <SelectValue placeholder="Select a kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mcp-http">MCP (HTTP)</SelectItem>
                  <SelectItem value="mcp-stdio">MCP (stdio)</SelectItem>
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
                value={id}
                onChange={(e) => {
                  setId(e.target.value)
                  clearError("id")
                }}
                hasError={!!errors.id}
                aria-required="true"
              />
            </Field>

            <Field id="platform-display-name" label="Display Name" error={errors.displayName}>
              <Input
                id="platform-display-name"
                placeholder="e.g. GitHub"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value)
                  clearError("displayName")
                }}
                hasError={!!errors.displayName}
                aria-required="true"
              />
            </Field>

            {kind === "mcp-http" && (
              <>
                <Field id="platform-url" label="URL" error={errors.url}>
                  <Input
                    id="platform-url"
                    placeholder="https://example.com/mcp"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value)
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
                    value={authHeader}
                    onChange={(e) => setAuthHeader(e.target.value)}
                  />
                </Field>
              </>
            )}

            {kind === "mcp-stdio" && (
              <>
                <Field id="platform-command" label="Command" error={errors.command}>
                  <Input
                    id="platform-command"
                    placeholder="e.g. npx"
                    value={command}
                    onChange={(e) => {
                      setCommand(e.target.value)
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
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
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
                    value={tokenEnvVar}
                    onChange={(e) => setTokenEnvVar(e.target.value)}
                  />
                </Field>
              </>
            )}

            {kind === "openapi" && (
              <>
                <Field id="platform-spec-url" label="Spec URL" error={errors.specUrl}>
                  <Input
                    id="platform-spec-url"
                    placeholder="https://example.com/openapi.json"
                    value={specUrl}
                    onChange={(e) => {
                      setSpecUrl(e.target.value)
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
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </Field>
              </>
            )}

            {kind === "graphql" && (
              <Field id="platform-endpoint" label="Endpoint" error={errors.endpoint}>
                <Input
                  id="platform-endpoint"
                  placeholder="https://example.com/graphql"
                  value={endpoint}
                  onChange={(e) => {
                    setEndpoint(e.target.value)
                    clearError("endpoint")
                  }}
                  hasError={!!errors.endpoint}
                  aria-required="true"
                />
              </Field>
            )}

            {kind === "cli" && (
              <Field
                id="platform-descriptor"
                label="Descriptor (JSON)"
                description="A sandboxed CLI connection descriptor — see the CLI docs for the shape."
                error={errors.descriptor}
              >
                <textarea
                  id="platform-descriptor"
                  className="w-full rounded-[var(--radius-6)] border px-3 py-2 font-mono"
                  style={{
                    fontSize: "var(--text-mono)",
                    borderColor: errors.descriptor ? "var(--status-error-fg)" : "var(--alpha-400)",
                    background: "var(--bg-100)",
                    color: "var(--gray-1000)",
                    minHeight: "120px",
                  }}
                  placeholder='{"tools":[{"name":"...","argv":[...],"policy":{...}}]}'
                  value={descriptor}
                  onChange={(e) => {
                    setDescriptor(e.target.value)
                    clearError("descriptor")
                  }}
                  aria-required="true"
                />
              </Field>
            )}

            {(kind === "openapi" || kind === "graphql") && (
              <>
                <Field id="platform-auth-scheme" label="Auth">
                  <Select
                    value={authScheme}
                    onValueChange={(v) => setAuthScheme(v as SimpleAuthScheme)}
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
                {authScheme === "apiKey" && (
                  <Field id="platform-auth-name" label="Header Name" error={errors.authName}>
                    <Input
                      id="platform-auth-name"
                      placeholder="e.g. X-API-Key"
                      value={authName}
                      onChange={(e) => {
                        setAuthName(e.target.value)
                        clearError("authName")
                      }}
                      hasError={!!errors.authName}
                      aria-required="true"
                    />
                  </Field>
                )}
              </>
            )}
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Add Platform"
            submittingLabel="Adding…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Edit Platform dialog — displayName only (v1; see platform-mutations.server.ts
// mutateUpdatePlatform for the get+upsert rationale).
// ---------------------------------------------------------------------------

interface EditPlatformDialogProps {
  readonly platform: PlatformMeta | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

function EditPlatformDialog({ platform, onOpenChange, onSuccess }: EditPlatformDialogProps) {
  const [displayName, setDisplayName] = useState(platform?.displayName ?? "")
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  function handleOpenChange(next: boolean) {
    if (next && platform) setDisplayName(platform.displayName)
    if (!next) {
      setError(undefined)
      setSubmitting(false)
    }
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!displayName.trim()) {
      setError("Display name is required")
      return
    }
    if (!platform) return
    setSubmitting(true)
    try {
      const result = await updatePlatformFn({
        data: { id: platform.id, displayName: displayName.trim() },
      })
      if (!result.ok) {
        toast.error(`Failed to update platform: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Platform updated")
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to update platform")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={platform !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Platform</DialogTitle>
          <DialogDescription>
            Rename <MonoCode>{platform?.id}</MonoCode>. Other fields (connection, auth) are not
            editable here — remove and re-add the platform to change them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="edit-display-name" label="Display Name" error={error}>
              <Input
                id="edit-display-name"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value)
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
            submitLabel="Save"
            submittingLabel="Saving…"
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

      {/* Dialogs */}
      <AddPlatformDialog open={addOpen} onOpenChange={setAddOpen} onSuccess={invalidate} />
      <EditPlatformDialog
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
