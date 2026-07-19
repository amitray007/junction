// SPDX-License-Identifier: AGPL-3.0-only
// Platforms route — Add/Edit/Delete/Refresh write path (inc 26 slice C + wave 3 follow-up).
// inc 24.6: Base URL column removed (always `—`; noise). baseUrl shown inline under Name when present.
// wave 3: Add + Edit now share one PlatformDialog (mode: "add" | "edit"); kind Select is
// MCP/OpenAPI/GraphQL/CLI with an MCP transport sub-selector; CLI uses the guided
// CliConnectionForm; an auth-scheme note points at the Credentials page.
// No @junction/core import. All core access via createServerFn.

import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { Plus, RefreshCw, SquarePen, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import type { TableColumn } from "../lib/use-table-view.js"
import { useTableView } from "../lib/use-table-view.js"
import { getCredentials, getPlatforms, type PlatformMeta } from "../server/data.functions.js"
import { addCredentialFn, rotateCredentialFn } from "../server/mutations.functions.js"
import {
  type AddPlatformInput,
  addFullAccessCliPlatformFn,
  addPlatformFn,
  bindCredentialToPlatformFn,
  deletePlatformFn,
  getPlatformDetailFn,
  type PlatformDetail,
  refreshPlatformFn,
  setFullAccessCliShortcutsFn,
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
  Table,
  TableActionsCell,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TablePagination,
  TableRow,
  TableSkeleton,
} from "../ui/index.js"
import { CliConnectionForm } from "./-components/cli-form/cli-connection-form.js"
import {
  connectionFromDetail,
  toConnectionInput,
  toToolInput,
} from "./-components/cli-form/convert.js"
import { ShortcutsPanel } from "./-components/cli-form/shortcuts-panel.js"
import type { CliConnectionFormState } from "./-components/cli-form/types.js"
import { emptyConnection } from "./-components/cli-form/types.js"
import { httpConnectionFromDetail, toHttpConnectionInput } from "./-components/http-form/convert.js"
import { HttpConnectionForm } from "./-components/http-form/http-connection-form.js"
import type { HttpConnectionFormState } from "./-components/http-form/types.js"
import { emptyHttpConnection } from "./-components/http-form/types.js"
import { KeyValueRepeater } from "./-components/key-value-repeater.js"

export const Route = createFileRoute("/platforms")({
  loader: async () => {
    const [platforms, credentials] = await Promise.all([getPlatforms(), getCredentials()])
    // Derive connection counts per platform from the credential list. An
    // UNLINKED credential (platformId: null, increment 42) has no platform
    // to count against — skip it.
    const connectionCounts = new Map<string, number>()
    for (const c of credentials) {
      if (c.platformId === null) continue
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
// Kind Select offers MCP / OpenAPI / GraphQL / CLI / HTTP. MCP has a Transport
// sub-select (HTTP / stdio); at submit, (kind===mcp, transport) maps to the
// server's discriminated "mcp-http" | "mcp-stdio".
//
// Auth exposed per kind (bearer-first subset — see platform-mutations.server.ts header):
//   mcp-http:  authHeader override only (bearer implied by the connection).
//   mcp-stdio: none (credential injection via tokenEnvVar stays a CLI-only flow).
//   openapi:   none | bearer | apiKey (header name).
//   graphql:   none | bearer | apiKey (header name).
//   cli:       none (connection carries its own credentialEnvVar).
//   http:      none | bearer | apiKey (header name) — same shared auth Select as
//              openapi/graphql. The form is metadata-only: it collects the auth
//              SCHEME/NAME, never a token — the actual secret is bound separately
//              on the Credentials page, exactly like every other credentialed kind.
// ---------------------------------------------------------------------------

type PlatformKind = "mcp" | "openapi" | "graphql" | "cli" | "http"
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
  /** Operator-designated verify operationId (28.9) — openapi only, optional. */
  verifyOperationId: string
  cli: CliConnectionFormState
  http: HttpConnectionFormState
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
    verifyOperationId: "",
    cli: emptyConnection(),
    http: emptyHttpConnection(),
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
      verifyOperationId: detail.verifyOperationId ?? "",
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
  if (detail.kind === "http") {
    return {
      ...base,
      kind: "http",
      id: detail.id,
      displayName: detail.displayName,
      authScheme,
      authName: authScheme === "apiKey" ? (detail.authHeaderOrName ?? "") : "",
      http: httpConnectionFromDetail(detail),
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

  /**
   * After a successful Full CLI Access install, bind/create the chosen
   * credential against the just-installed platform.id (increment 43, Slice
   * B2). Skip → no-op (unchanged public-CLI behavior). The platform is
   * ALREADY installed by the time this runs — a bind/create failure here is
   * reported as "platform installed, credential not bound" and does NOT roll
   * back the platform (it's a legitimately-installed public CLI until a
   * secret is added; see the method file's B2 note).
   *
   * Returns true if the credential step is fully resolved (including "skip"
   * and a duplicate-account collision, which stays open for the user to
   * recover from inline) — the caller uses this to decide whether to close
   * the dialog.
   */
  async function resolveFullAccessCredential(platformId: string): Promise<boolean> {
    const fa = state.cli.fullAccess
    const cred = fa.credential

    if (cred.mode === "skip") return true

    if (cred.mode === "existing") {
      if (!cred.selectedCredentialId) {
        toast.error("Choose an existing credential, or switch to Skip / Create new")
        return false
      }
      // "Use it" recovery (see CredentialSection): the selected credential IS
      // duplicateCredentialId — it's already bound to THIS platform+account
      // (that's precisely why create-new collided). Re-calling bind would
      // hit the SAME duplicate-account guard against itself (core has no
      // own-row exclusion — bindCredentialToPlatform's contract is "not yet
      // on this platform"). Nothing to do — it's already correctly bound.
      if (
        cred.duplicateAccount !== undefined &&
        cred.selectedCredentialId === cred.duplicateCredentialId
      ) {
        toast.success("Using the existing credential for this account")
        return true
      }
      const result = await bindCredentialToPlatformFn({
        data: { credentialId: cred.selectedCredentialId, platformId },
      })
      if (result.ok) {
        toast.success(
          result.verified
            ? "Credential bound and verified"
            : "Credential bound (not verified — this platform can't run a live check)",
        )
        return true
      }
      if ("verifyFailed" in result) {
        toast.error(
          `Platform installed, but the credential failed verification (${result.verifyFailed}${result.detail ? `: ${result.detail}` : ""}) — it was NOT bound. Retry from /credentials.`,
        )
        set("cli", {
          ...state.cli,
          fullAccess: { ...fa, credential: { ...cred, error: result.verifyFailed } },
        })
        return false
      }
      toast.error(`Platform installed, but binding the credential failed: ${result.error}`)
      set("cli", {
        ...state.cli,
        fullAccess: { ...fa, credential: { ...cred, error: result.error } },
      })
      return false
    }

    // cred.mode === "new" but the user clicked "Use it" on a duplicate-account
    // collision (CredentialSection flips mode to "existing" for that click —
    // this branch is unreachable in practice but kept as a defensive no-op:
    // the colliding credential is ALREADY bound to this platform+account, so
    // there is nothing to bind — re-calling bindCredentialToPlatformFn would
    // hit its own duplicate-account guard against itself).

    // cred.mode === "new" — replace-secret recovery takes priority: the user
    // already resolved a duplicate-account collision and typed a new secret.
    if (cred.duplicateAccount && cred.replacingSecret) {
      if (!cred.replaceSecretValue) {
        toast.error("Enter the new secret")
        return false
      }
      if (!cred.duplicateCredentialId) {
        toast.error("Could not identify the existing credential to replace — reload and retry")
        return false
      }
      const rotateResult = await rotateCredentialFn({
        data: { credentialId: cred.duplicateCredentialId, newSecret: cred.replaceSecretValue },
      })
      if (!rotateResult.ok) {
        toast.error(`Platform installed, but replacing the secret failed: ${rotateResult.error}`)
        return false
      }
      toast.success("Secret replaced")
      return true
    }

    // A collision is already surfaced and awaiting the user's explicit
    // choice (Use it / Replace its secret) — do not re-submit create.
    if (cred.duplicateAccount) return false

    if (!cred.newName.trim() || !cred.newSecret) {
      toast.error(
        "Enter a name and secret for the new credential, or switch to Skip / Use existing",
      )
      return false
    }
    // Slug pre-check (inc 43 web-review should-fix): an invalid credential name
    // otherwise reaches addCredentialFn's validator, which throws a 400 that the
    // outer catch mis-reports as "install failed" — even though the platform
    // installed fine. Refuse it here with an actionable message instead.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(cred.newName.trim())) {
      toast.error(
        "Credential name must be a lowercase slug (letters, digits, hyphens; starts with a letter or digit) — e.g. github-work",
      )
      return false
    }
    const createResult = await addCredentialFn({
      data: {
        platformId,
        account: cred.newAccount.trim() || "default",
        name: cred.newName.trim(),
        kind: "env",
        secret: cred.newSecret,
      },
    })
    if (createResult.ok) {
      toast.success("Credential created and bound")
      return true
    }
    // Duplicate-account collision: surface the explicit use-existing/replace
    // recovery — NEVER silently overwrite (R4, method file B1). Resolve the
    // colliding credential's id by re-fetching the (already metadata-only)
    // credential list and matching on {platformId, account} — addCredentialFn
    // returns only a human message, not a structured error, so this is the
    // one lookup available to find WHICH credential to offer for "Use it" /
    // "Replace its secret".
    const accountLabel = cred.newAccount.trim() || "default"
    if (createResult.error.includes("already connected")) {
      const allCredentials = await getCredentials()
      const existing = allCredentials.find(
        (c) => c.platformId === platformId && c.account === accountLabel,
      )
      set("cli", {
        ...state.cli,
        fullAccess: {
          ...fa,
          credential: {
            ...cred,
            duplicateAccount: accountLabel,
            duplicateCredentialId: existing?.id,
          },
        },
      })
      return false
    }
    toast.error(`Platform installed, but creating the credential failed: ${createResult.error}`)
    set("cli", {
      ...state.cli,
      fullAccess: { ...fa, credential: { ...cred, error: createResult.error } },
    })
    return false
  }

  /**
   * Full CLI access install (inc 41.4): resolve the chosen binary path (manual
   * override or the discovery picker's selection), then call
   * addFullAccessCliPlatformFn directly — discover→extract→upsert happens
   * server-side. Shows the "Mapped N commands…" summary inline rather than
   * closing the dialog immediately, so the user sees what got learned.
   * Increment 43 (Slice B2): after a successful install, resolves the inline
   * Credential section's choice (skip/existing/new) against the newly
   * installed platform.id.
   */
  async function handleFullAccessSubmit() {
    const fa = state.cli.fullAccess
    const binaryPath = fa.manualPath ? fa.manualPathValue.trim() : fa.selectedRealpath
    if (!binaryPath) {
      toast.error("Choose a discovered binary or enter a path manually")
      return
    }

    // Map the network mode to the allowNet payload the install expects:
    //  denied → [] (no network); full → ["*"] (any host/port); allowlist → the
    //  host:port rows (translated to enforceable port scopes server-side).
    const allowNet =
      fa.netMode === "full"
        ? ["*"]
        : fa.netMode === "allowlist"
          ? fa.allowNet.map((h) => h.value.trim()).filter(Boolean)
          : []

    setSubmitting(true)
    try {
      const result = await addFullAccessCliPlatformFn({
        data: {
          id: state.id.trim(),
          displayName: state.displayName.trim(),
          binaryPath,
          ...(fa.credentialEnvVar.trim() ? { credentialEnvVar: fa.credentialEnvVar.trim() } : {}),
          allowNet,
        },
      })
      if (!result.ok) {
        toast.error(`Failed to install: ${result.error}`)
        setSubmitting(false)
        return
      }
      const summary = `Mapped ${result.nodeCount} command node(s)${result.truncated ? " (partial — some branches deferred)" : ""}`
      set("cli", { ...state.cli, fullAccess: { ...fa, installSummary: summary } })
      toast.success(`Platform "${result.platform.displayName}" installed — ${summary}`)

      const credentialResolved = await resolveFullAccessCredential(result.platform.id)
      setSubmitting(false)
      if (!credentialResolved) {
        // Platform IS installed — leave the dialog open so the user can see
        // and act on the credential error/recovery UI, per the method file's
        // "do NOT roll back the platform" instruction. onSuccess() still
        // refreshes the table so the new platform shows up immediately.
        onSuccess()
        return
      }
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to install Full CLI access platform")
      setSubmitting(false)
    }
  }

  /**
   * Edit a Full CLI access platform's shortcuts (inc 41.5): a SEPARATE submit
   * path from both handleFullAccessSubmit (add-only, installs a new binary)
   * and the declared-mode handleSubmit path below — there's no
   * CliConnectionInput (tools/credentialEnvVar/binary) to resubmit here, only
   * the shortcuts[] replacement. setFullAccessCliShortcutsFn re-fetches the
   * existing platform server-side and replaces shortcuts wholesale.
   */
  async function handleShortcutsSubmit() {
    setSubmitting(true)
    try {
      const result = await setFullAccessCliShortcutsFn({
        data: {
          id: state.id.trim(),
          shortcuts: state.cli.tools.map(toToolInput),
        },
      })
      if (!result.ok) {
        toast.error(`Failed to update shortcuts: ${result.error}`)
        if (result.fieldErrors) setErrors((prev) => ({ ...prev, ...result.fieldErrors }))
        setSubmitting(false)
        return
      }
      toast.success("Shortcuts updated")
      setSubmitting(false)
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to update shortcuts")
      setSubmitting(false)
    }
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
    if (state.kind === "http" && !state.http.baseUrl.trim()) {
      newErrors.baseUrl = "Base URL is required"
    }
    if (state.authScheme === "apiKey" && !state.authName.trim()) {
      newErrors.authName = "Header name is required"
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    // Editing an EXISTING Full CLI access platform only ever touches
    // shortcuts[] — check this before the add-only full-access branch below
    // (mode==="edit" here always means "this cli platform's mode is already
    // full-access", since Add is the only place the toggle is user-driven).
    if (mode === "edit" && state.kind === "cli" && state.cli.mode === "full-access") {
      await handleShortcutsSubmit()
      return
    }

    // Full CLI access takes a SEPARATE submit path — no CliConnectionInput
    // (tools/args) shape to assemble; discovery already resolved a realpath
    // client-side and the install fn does discover→extract→upsert server-side.
    if (state.kind === "cli" && state.cli.mode === "full-access") {
      await handleFullAccessSubmit()
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
                ...(state.verifyOperationId.trim()
                  ? { verifyOperationId: state.verifyOperationId.trim() }
                  : {}),
              }
            : state.kind === "graphql"
              ? {
                  kind: "graphql" as const,
                  id: state.id.trim(),
                  displayName: state.displayName.trim(),
                  endpoint: state.endpoint.trim(),
                  ...(auth ? { auth } : {}),
                }
              : state.kind === "http"
                ? {
                    kind: "http" as const,
                    id: state.id.trim(),
                    displayName: state.displayName.trim(),
                    connection: { ...toHttpConnectionInput(state.http), auth },
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
    state.kind === "openapi" || state.kind === "graphql" || state.kind === "http"
      ? state.authScheme !== "none"
      : state.kind === "mcp" && state.transport === "http"

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {/* no-scrollbar: keep the modal bounded + scrollable but hide the
          scrollbar chrome (the form still scrolls when tall). */}
      <DialogContent className="no-scrollbar">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Platform" : "Edit Platform"}</DialogTitle>
          <DialogDescription>
            {mode === "add" ? (
              <>
                Add a source platform. Junction discovers its tools and namespaces them under the
                platform's ID.
              </>
            ) : state.kind === "cli" && state.cli.mode === "full-access" ? (
              <>
                Edit <MonoCode>{platform?.id}</MonoCode>'s shortcuts. Agents can already run any
                command via execute/help — shortcuts are optional saved commands on top.
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
                  <SelectItem value="http">HTTP</SelectItem>
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
                    <KeyValueRepeater
                      label="Env Vars"
                      rows={state.env}
                      onChange={(env) => set("env", env)}
                      addLabel="Add variable"
                      removeAriaLabel="Remove env variable"
                      makeRow={() => emptyEnvVarRow()}
                    />
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
                <Field
                  id="platform-verify-op"
                  label="Verify Operation ID"
                  error={errors.verifyOperationId}
                  description="A safe GET operation (no required params) used to test the connection. Leave blank if none is safe to call — the platform stays honestly 'not auto-verifiable'."
                >
                  <Input
                    id="platform-verify-op"
                    placeholder="e.g. getUser"
                    value={state.verifyOperationId}
                    onChange={(e) => {
                      set("verifyOperationId", e.target.value)
                      clearError("verifyOperationId")
                    }}
                    hasError={!!errors.verifyOperationId}
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

            {state.kind === "cli" && mode === "edit" && state.cli.mode === "full-access" ? (
              // Editing an existing Full CLI access platform only exposes the
              // shortcuts editing surface (inc 41.5) — the binary/policy/schema
              // aren't editable here (out of scope; see connectionFromDetail).
              <ShortcutsPanel
                shortcuts={state.cli.tools}
                onChange={(tools) => set("cli", { ...state.cli, tools })}
              />
            ) : (
              state.kind === "cli" && (
                <CliConnectionForm connection={state.cli} onChange={(cli) => set("cli", cli)} />
              )
            )}

            {state.kind === "http" && (
              <HttpConnectionForm
                connection={state.http}
                onChange={(http) => {
                  set("http", http)
                  // Clear the inline baseUrl error as the user edits — consistent
                  // with url/command/specUrl/endpoint. (inc-30.7 CodeRabbit #518.)
                  clearError("baseUrl")
                }}
                baseUrlError={errors.baseUrl}
              />
            )}

            {(state.kind === "openapi" || state.kind === "graphql" || state.kind === "http") && (
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

// Sortable columns for the Platforms table — Connections sorts numerically off
// the connectionCounts record (not a field on PlatformMeta itself).
function buildPlatformColumns(
  connectionCounts: Record<string, number>,
): TableColumn<PlatformMeta>[] {
  return [
    { key: "name", compare: (a, b) => a.displayName.localeCompare(b.displayName) },
    { key: "kind", compare: (a, b) => a.kind.localeCompare(b.kind) },
    {
      key: "connections",
      compare: (a, b) => (connectionCounts[a.id] ?? 0) - (connectionCounts[b.id] ?? 0),
    },
  ]
}

// Kind facet options — hardcoded to the known platform kinds (simpler than
// deriving from the loaded data, per the method-file note). "all" is the
// clear-filter sentinel ("All kinds").
const KIND_FILTER_OPTIONS = ["all", "mcp", "openapi", "graphql", "cli", "http"] as const
type KindFilter = (typeof KIND_FILTER_OPTIONS)[number]

function PlatformsPage() {
  const { platforms, connectionCounts } = Route.useLoaderData()
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [editingPlatform, setEditingPlatform] = useState<PlatformMeta | null>(null)
  const [deletingPlatform, setDeletingPlatform] = useState<PlatformMeta | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>("all")

  const columns = useMemo(() => buildPlatformColumns(connectionCounts), [connectionCounts])
  const predicate = useCallback(
    (p: PlatformMeta) => kindFilter === "all" || p.kind === kindFilter,
    [kindFilter],
  )
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
  } = useTableView<PlatformMeta>({
    rows: platforms,
    searchFields: (p) => [p.id, p.displayName, p.kind],
    columns,
    predicate,
  })

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

      {/* Search + Kind facet filter — row, composes as AND (Task 5's predicate). */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-2)",
          marginBottom: "var(--space-2)",
        }}
      >
        <Input
          id="platform-search"
          type="search"
          placeholder="Search platforms…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
          aria-label="Search platforms"
        />
        <FacetSelect
          ariaLabel="Filter by kind"
          allLabel="All kinds"
          value={kindFilter}
          onValueChange={(v) => setKindFilter(v as KindFilter)}
          options={[
            { value: "mcp" },
            { value: "openapi" },
            { value: "graphql" },
            { value: "cli" },
            { value: "http" },
          ]}
        />
      </div>

      {/* B3: always render the table — empty state is a full-width row, not bare text */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead sortDirection={sortDirectionFor("name")} onSort={() => toggleSort("name")}>
              Name
            </TableHead>
            <TableHead sortDirection={sortDirectionFor("kind")} onSort={() => toggleSort("kind")}>
              Kind
            </TableHead>
            <TableHead
              sortDirection={sortDirectionFor("connections")}
              onSort={() => toggleSort("connections")}
            >
              Connections
            </TableHead>
            {/* Base URL column removed inc 24.6 — always `—` for MCP platforms, pure noise. */}
            <TableActionsHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {total === 0 ? (
            <EmptyTableRow
              colSpan={4}
              message={
                search.trim().length > 0 || kindFilter !== "all"
                  ? "No platforms match your search."
                  : "No platforms yet."
              }
              action={
                search.trim().length > 0 || kindFilter !== "all" ? undefined : (
                  <span style={{ fontSize: "var(--text-body)", color: "var(--gray-700)" }}>
                    Use <strong>Add Platform</strong> above.
                  </span>
                )
              }
            />
          ) : (
            pageRows.map((p: PlatformMeta) => (
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

      {/* Pagination footer — hidden seed sizes here just mean 1 page (correct, not a bug) */}
      <TablePagination page={page} pageCount={pageCount} total={total} onPageChange={setPage} />

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
