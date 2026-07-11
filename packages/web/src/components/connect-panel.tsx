// SPDX-License-Identifier: AGPL-3.0-only
// Connect panel (increment 36, Component 1) — the two-mode "ready to connect"
// dialog: an explicit segmented toggle, "I already have credentials" (fast
// paste-and-connect) vs "Help me set this up" (guided, per auth type). This
// is the SAME write path as the shipped inc-30.11/30.12 ConnectSurfaceDialog
// (connectSurfaceFn for token/byo, a deep-link hand-off to /credentials for
// oauth2 via the shipped startConnect/startReconnect flow) — this component
// EXTENDS it with guidance, it does not add a new way to write a credential.
//
// Guards preserved verbatim from the shipped dialog: empty-secret block,
// double-submit (disabled while submitting), verify-before-commit (server
// round-trip via connectSurfaceFn), duplicate-account (client pre-check +
// server-authoritative `duplicateAccount` branch).
//
// No @junction/core import. Only *.functions.js server-fn wrappers + ui
// primitives — same server-only boundary as the route that renders this.

import { Plug } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { AUTH_MODE_ORDER, authModeLabel } from "../lib/auth-mode-label.js"
import { formatCheckedAt } from "../lib/format-date.js"
import type { ConnectFnResult } from "../server/connect.functions.js"
import { connectSurfaceFn } from "../server/connect.functions.js"
import type {
  AppHelp,
  OAuthProviderMeta,
  SurfaceConnectable,
  SurfaceView,
} from "../server/data.functions.js"
import { startConnectFn } from "../server/oauth-connect.functions.js"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  MonoCode,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../ui/index.js"
import { CliSandboxExplainer } from "./cli-sandbox-explainer.js"

/** Sort a surface's offered auth modes into a stable, predictable Select order. */
function sortAuthModes(modes: SurfaceConnectable["authModes"]): SurfaceConnectable["authModes"] {
  return [...modes].sort((a, b) => AUTH_MODE_ORDER.indexOf(a) - AUTH_MODE_ORDER.indexOf(b))
}

/**
 * The mode the dialog OPENS in. Prefer the first *inline-writable* mode (token /
 * byo / none) over oauth2 — oauth2 is a deep-link hand-off, so defaulting to it
 * would open a verifiable surface on the one path that does nothing inline and
 * hide the working token flow behind a Select change. oauth2 stays selectable;
 * it just isn't the default. (Mirrors the shipped ConnectSurfaceDialog rule.)
 */
function defaultAuthMode(
  modes: SurfaceConnectable["authModes"],
): SurfaceConnectable["authModes"][number] {
  return modes.find((m) => m !== "oauth2") ?? modes[0] ?? "token"
}

function verifyFailedMessage(outcome: "auth-failed" | "unreachable"): string {
  if (outcome === "auth-failed") {
    return "Couldn't verify — authentication failed. Check the token."
  }
  return "Couldn't reach this surface — this may be a catalog/base-URL issue, not your token."
}

function duplicateAccountMessage(account: string): string {
  return `'${account}' is already connected here — pick a different account name.`
}

/**
 * The "Auth mode" Select — identical markup in both the fast and guided tabs
 * (they differ only by the field `id`). Factored out so the two tabs can't
 * drift. Rendered only when the surface offers >1 mode.
 */
function AuthModeField({
  id,
  modes,
  authMode,
  onAuthModeChange,
}: {
  readonly id: string
  readonly modes: SurfaceConnectable["authModes"]
  readonly authMode: SurfaceConnectable["authModes"][number]
  readonly onAuthModeChange: (mode: string) => void
}) {
  if (modes.length <= 1) return null
  return (
    <Field id={id} label="Auth mode">
      <Select value={authMode} onValueChange={onAuthModeChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Select an auth mode" />
        </SelectTrigger>
        <SelectContent>
          {modes.map((m) => (
            <SelectItem key={m} value={m}>
              {authModeLabel(m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Guided-mode content — per auth type, driven by AppDetail.app.help +
// OAuthProviderMeta.registrationHint. Purely informational (no write).
// ---------------------------------------------------------------------------

function GuidedOAuth({
  appDisplayName,
  help,
  provider,
}: {
  readonly appDisplayName: string
  readonly help: AppHelp | undefined
  readonly provider: OAuthProviderMeta | undefined
}) {
  const registerUrl = help?.oauthApp?.registerUrl
  // Prefer the PROVIDER's registrationHint.redirectUri — it is redirect-mode-aware
  // (a loopback-ephemeral provider like Google uses `http://127.0.0.1:<ephemeral
  // -port>/`, NOT a fixed callback path), so it tells the user the CORRECT thing
  // to register. Fall back to the app-level help.oauthApp.callbackPath only when
  // the provider carries no hint. (Fixes the inherited Gmail/Calendar case where
  // a fixed "/oauth/callback/google" was advertised for an ephemeral-loopback
  // provider — inc 40 follow-up.)
  const callbackHint = provider?.registrationHint.redirectUri ?? help?.oauthApp?.callbackPath
  const scopes = provider?.registrationHint.scopes ?? help?.authSetup?.env

  return (
    <div className="flex flex-col gap-2">
      <p style={{ fontSize: "var(--text-body)", color: "var(--gray-900)", margin: 0 }}>
        junction is self-hosted — there's no shared junction OAuth app, so you register your own
        with {appDisplayName} once. After that, Connect is one click.
      </p>
      <ol className="flex flex-col gap-1.5 list-decimal pl-5 m-0">
        {registerUrl !== undefined && (
          <li style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
            <a
              href={registerUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--blue-text)" }}
            >
              Register a new OAuth app with {appDisplayName}
            </a>
          </li>
        )}
        {callbackHint !== undefined && (
          <li style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
            Set the redirect / callback URL to <MonoCode>{callbackHint}</MonoCode>
          </li>
        )}
        {scopes !== undefined && (
          <li style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
            Request scopes: <MonoCode>{scopes}</MonoCode>
          </li>
        )}
        <li style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
          Come back here and paste the client ID/secret to connect.
        </li>
      </ol>
    </div>
  )
}

function GuidedToken({ help }: { readonly help: AppHelp | undefined }) {
  const authSetup = help?.authSetup
  if (authSetup === undefined) {
    return (
      <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
        Mint a token or API key from this app's settings, then paste it below.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {authSetup.interactive !== undefined && (
        <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
          Mint it with <MonoCode>{authSetup.interactive}</MonoCode>, or from the app's settings.
        </p>
      )}
      {authSetup.env !== undefined && (
        <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
          Expected as <MonoCode>{authSetup.env}</MonoCode> — paste the value below.
        </p>
      )}
    </div>
  )
}

function GuidedContent({
  authMode,
  appDisplayName,
  help,
  provider,
}: {
  readonly authMode: SurfaceConnectable["authModes"][number]
  readonly appDisplayName: string
  readonly help: AppHelp | undefined
  readonly provider: OAuthProviderMeta | undefined
}) {
  if (authMode === "oauth2") {
    return <GuidedOAuth appDisplayName={appDisplayName} help={help} provider={provider} />
  }
  if (authMode === "token" || authMode === "byo") {
    return <GuidedToken help={help} />
  }
  return null
}

// ---------------------------------------------------------------------------
// Connect panel dialog — the two-mode toggle wraps the SAME credential
// fields + write path in both modes; guided mode only prepends explanatory
// content above the identical form (or, for a cli surface, the sandbox
// explainer).
// ---------------------------------------------------------------------------

export function ConnectPanelDialog({
  open,
  onOpenChange,
  appId,
  appDisplayName,
  surface,
  connectable,
  hasConnections,
  existingAccounts,
  help,
  oauthProviders,
  onConnected,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly appId: string
  readonly appDisplayName: string
  readonly surface: SurfaceView
  readonly connectable: SurfaceConnectable
  readonly hasConnections: boolean
  readonly existingAccounts: string[]
  readonly help: AppHelp | undefined
  readonly oauthProviders: OAuthProviderMeta[]
  readonly onConnected: () => void
}) {
  const modes = useMemo(() => sortAuthModes(connectable.authModes), [connectable.authModes])
  const [mode, setMode] = useState<"fast" | "guided">("fast")
  const [authMode, setAuthMode] = useState<SurfaceConnectable["authModes"][number]>(
    defaultAuthMode(modes),
  )
  const [account, setAccount] = useState(hasConnections ? "" : "default")
  const [secret, setSecret] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [accountError, setAccountError] = useState<string | undefined>(undefined)

  const isOAuth = authMode === "oauth2"
  const isCli = surface.kind === "cli"
  const oauthProviderId = surface.auth.find(
    (a): a is Extract<typeof a, { mode: "oauth2" }> => a.mode === "oauth2",
  )?.providerId
  const provider = oauthProviders.find((p) => p.id === oauthProviderId)

  // Increment 38 D2 — guided oauth2 mode's BYO client-app fields (the
  // one-time OAuth-app registration inc-36 already explains above these
  // fields; this is the actual input collection that was missing). Scopes
  // default from the provider's defaultScopes (space-separated, editable) —
  // matches the raw /credentials ConnectOAuthDialog's own default.
  const [oauthClientId, setOAuthClientId] = useState("")
  const [oauthClientSecret, setOAuthClientSecret] = useState("")
  const [oauthScopes, setOAuthScopes] = useState(provider?.defaultScopes.join(" ") ?? "")
  const [oauthClientIdError, setOAuthClientIdError] = useState<string | undefined>(undefined)
  const [oauthClientSecretError, setOAuthClientSecretError] = useState<string | undefined>(
    undefined,
  )

  function reset() {
    setMode("fast")
    setAuthMode(defaultAuthMode(modes))
    setAccount(hasConnections ? "" : "default")
    setSecret("")
    setSubmitting(false)
    setError(undefined)
    setAccountError(undefined)
    setOAuthClientId("")
    setOAuthClientSecret("")
    setOAuthScopes(provider?.defaultScopes.join(" ") ?? "")
    setOAuthClientIdError(undefined)
    setOAuthClientSecretError(undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function handleAuthModeChange(next: string) {
    setAuthMode(next as SurfaceConnectable["authModes"][number])
    setError(undefined)
    setAccountError(undefined)
  }

  function handleAccountChange(value: string) {
    setAccount(value)
    if (accountError !== undefined) setAccountError(undefined)
  }

  function handleOAuthClientIdChange(value: string) {
    setOAuthClientId(value)
    if (oauthClientIdError !== undefined) setOAuthClientIdError(undefined)
  }

  function handleOAuthClientSecretChange(value: string) {
    setOAuthClientSecret(value)
    if (oauthClientSecretError !== undefined) setOAuthClientSecretError(undefined)
  }

  async function handleConfirm() {
    if (isOAuth) {
      // Fast mode's oauth2 tab stays the pre-inc-38 deep-link (no BYO fields
      // shown there — "register an OAuth app on the Credentials page"). Only
      // guided mode collects clientId/clientSecret/scopes inline (inc 36's
      // approved design) and drives the new bind-across-the-round-trip flow.
      if (mode !== "guided") {
        handleOpenChange(false)
        window.location.href = "/credentials"
        return
      }
      await handleGuidedOAuthConfirm()
      return
    }

    if (secret.trim() === "") {
      setError("A secret is required to connect this surface.")
      return
    }

    const submittedAccount = account.trim() || "default"
    if (existingAccounts.includes(submittedAccount)) {
      setAccountError(duplicateAccountMessage(submittedAccount))
      return
    }

    setSubmitting(true)
    setError(undefined)
    setAccountError(undefined)
    try {
      const result: ConnectFnResult = await connectSurfaceFn({
        data: {
          appId,
          surfaceKind: surface.kind,
          authMode,
          account: submittedAccount,
          secret,
        },
      })
      handleConnectResult(result)
    } catch {
      setError("Failed to connect this surface.")
      setSubmitting(false)
    }
  }

  /**
   * Post-38 trust-boundary fix — guided oauth2 confirm: re-run
   * connectSurfaceFn server-side (NEVER trust a client-built plan) just to
   * get `providerId` + confirm this surface really is an oauth2 handoff, then
   * call startConnectFn with the user's BYO clientId/clientSecret/scopes +
   * a minimal `surfaceSelector` ({appId, surfaceKind, authMode}) — NOT an
   * assembled platformInput. `startConnect` re-derives platformInput/
   * platformId/displayName from the catalog itself server-side (the SAME
   * planConnect path connectSurfaceFn uses), and pre-checks the platform-kind
   * collision BEFORE the redirect. Then navigate the BROWSER to the
   * provider's authorize URL — a top-level nav (off-origin consent page),
   * not a client-side router transition.
   */
  async function handleGuidedOAuthConfirm() {
    const clientId = oauthClientId.trim()
    const clientSecret = oauthClientSecret
    let hasFieldError = false
    if (clientId === "") {
      setOAuthClientIdError("Client ID is required")
      hasFieldError = true
    }
    if (clientSecret === "") {
      setOAuthClientSecretError("Client secret is required")
      hasFieldError = true
    }
    if (hasFieldError) return

    const submittedAccount = account.trim() || "default"
    if (existingAccounts.includes(submittedAccount)) {
      setAccountError(duplicateAccountMessage(submittedAccount))
      return
    }

    setSubmitting(true)
    setError(undefined)
    setAccountError(undefined)
    try {
      const planResult: ConnectFnResult = await connectSurfaceFn({
        data: { appId, surfaceKind: surface.kind, authMode: "oauth2", account: submittedAccount },
      })
      if (!("handoff" in planResult)) {
        handleConnectResult(planResult)
        return
      }

      const scopes = oauthScopes.split(/\s+/).filter((s) => s.length > 0)
      const startResult = await startConnectFn({
        data: {
          providerId: planResult.providerId,
          clientId,
          clientSecret,
          scopes,
          account: submittedAccount,
          surfaceSelector: { appId, surfaceKind: surface.kind, authMode: "oauth2" },
        },
      })
      if (!startResult.ok) {
        if ("conflict" in startResult) {
          setError(
            `A ${startResult.conflict.existingKind} platform already uses this id; connecting this surface would overwrite it.`,
          )
        } else {
          setError(startResult.error)
        }
        setSubmitting(false)
        return
      }
      handleOpenChange(false)
      window.location.href = startResult.authorizeUrl
    } catch {
      setError("Failed to start connect.")
      setSubmitting(false)
    }
  }

  function handleConnectResult(result: ConnectFnResult) {
    if ("handoff" in result) {
      // Fast-mode oauth2 result (guided mode never reaches connectSurfaceFn's
      // oauth-handoff branch through THIS path — see handleGuidedOAuthConfirm,
      // which inspects the handoff payload directly instead).
      handleOpenChange(false)
      window.location.href = "/credentials"
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
    if ("duplicateAccount" in result) {
      setAccountError(duplicateAccountMessage(result.duplicateAccount))
      setSubmitting(false)
      return
    }
    setError(result.error)
    setSubmitting(false)
  }

  const honestyNote = connectable.verifiable
    ? `junction will verify this against ${appDisplayName} before saving — nothing is stored if verification fails.`
    : "junction can't automatically verify this surface; it will be saved as you confirm."

  // Increment 38 D2 — guided oauth2 now writes inline (BYO clientId/
  // clientSecret + account required); fast-mode oauth2 stays the deep-link
  // fallback (no inline fields shown there, nothing to validate/disable on).
  const isGuidedOAuth = isOAuth && mode === "guided"
  const isConfirmDisabled = isGuidedOAuth
    ? oauthClientId.trim() === "" || oauthClientSecret === "" || account.trim() === ""
    : !isOAuth && (secret.trim() === "" || account.trim() === "")
  const confirmLabel = isGuidedOAuth ? "Connect" : isOAuth ? "Continue to Credentials" : "Connect"

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect this surface?</DialogTitle>
          <DialogDescription>
            {appDisplayName} · {surface.displayName}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as "fast" | "guided")}>
          <TabsList aria-label="Connect mode">
            <TabsTrigger value="fast">I already have credentials</TabsTrigger>
            <TabsTrigger value="guided">Help me set this up</TabsTrigger>
          </TabsList>

          <TabsContent value="fast">
            <div className="flex flex-col gap-4 pt-2">
              <AuthModeField
                id="connect-auth-mode"
                modes={modes}
                authMode={authMode}
                onAuthModeChange={handleAuthModeChange}
              />

              {isOAuth ? (
                <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
                  {appDisplayName} uses OAuth — register an OAuth app on the Credentials page.
                </p>
              ) : (
                <CredentialFields
                  account={account}
                  onAccountChange={handleAccountChange}
                  accountError={accountError}
                  secret={secret}
                  onSecretChange={setSecret}
                  secretError={error}
                  honestyNote={honestyNote}
                />
              )}
            </div>
          </TabsContent>

          <TabsContent value="guided">
            <div className="flex flex-col gap-4 pt-2">
              <AuthModeField
                id="connect-auth-mode-guided"
                modes={modes}
                authMode={authMode}
                onAuthModeChange={handleAuthModeChange}
              />

              {isCli && <CliSandboxExplainer install={help?.install} notes={surface.notes} />}

              <GuidedContent
                authMode={authMode}
                appDisplayName={appDisplayName}
                help={help}
                provider={provider}
              />

              {isOAuth ? (
                <GuidedOAuthConnectFields
                  account={account}
                  onAccountChange={handleAccountChange}
                  accountError={accountError}
                  clientId={oauthClientId}
                  onClientIdChange={handleOAuthClientIdChange}
                  clientIdError={oauthClientIdError}
                  clientSecret={oauthClientSecret}
                  onClientSecretChange={handleOAuthClientSecretChange}
                  clientSecretError={oauthClientSecretError}
                  scopes={oauthScopes}
                  onScopesChange={setOAuthScopes}
                  error={error}
                />
              ) : (
                <CredentialFields
                  account={account}
                  onAccountChange={handleAccountChange}
                  accountError={accountError}
                  secret={secret}
                  onSecretChange={setSecret}
                  secretError={error}
                  honestyNote={honestyNote}
                />
              )}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={submitting || isConfirmDisabled}
            onClick={() => void handleConfirm()}
          >
            {submitting ? "Connecting…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The shared account+secret fields — identical markup in both modes so guided
 *  mode is genuinely "explain, then the SAME form", not a divergent copy. */
function CredentialFields({
  account,
  onAccountChange,
  accountError,
  secret,
  onSecretChange,
  secretError,
  honestyNote,
}: {
  readonly account: string
  readonly onAccountChange: (value: string) => void
  readonly accountError: string | undefined
  readonly secret: string
  readonly onSecretChange: (value: string) => void
  readonly secretError: string | undefined
  readonly honestyNote: string
}) {
  return (
    <>
      <Field id="connect-account" label="Account" error={accountError}>
        <Input
          id="connect-account"
          value={account}
          onChange={(e) => onAccountChange(e.target.value)}
          hasError={accountError !== undefined}
        />
      </Field>
      <Field id="connect-secret" label="Secret" error={secretError}>
        <Input
          id="connect-secret"
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
          hasError={secretError !== undefined}
          aria-required="true"
          placeholder="Paste your token here"
        />
      </Field>
      <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
        {honestyNote}
      </p>
    </>
  )
}

/**
 * Guided oauth2 mode's inline field set (increment 38 D2) — account + the
 * BYO client-app fields (`GuidedOAuth`'s explainer above already tells the
 * user to "come back here and paste the client ID/secret"; this is that
 * paste target). Confirm calls startConnectFn with these + the surface's
 * server-assembled platformInput, then navigates to the OAuth provider.
 */
function GuidedOAuthConnectFields({
  account,
  onAccountChange,
  accountError,
  clientId,
  onClientIdChange,
  clientIdError,
  clientSecret,
  onClientSecretChange,
  clientSecretError,
  scopes,
  onScopesChange,
  error,
}: {
  readonly account: string
  readonly onAccountChange: (value: string) => void
  readonly accountError: string | undefined
  readonly clientId: string
  readonly onClientIdChange: (value: string) => void
  readonly clientIdError: string | undefined
  readonly clientSecret: string
  readonly onClientSecretChange: (value: string) => void
  readonly clientSecretError: string | undefined
  readonly scopes: string
  readonly onScopesChange: (value: string) => void
  readonly error: string | undefined
}) {
  return (
    <>
      <Field id="connect-oauth-account" label="Account" error={accountError}>
        <Input
          id="connect-oauth-account"
          value={account}
          onChange={(e) => onAccountChange(e.target.value)}
          hasError={accountError !== undefined}
        />
      </Field>
      <Field id="connect-oauth-client-id" label="Client ID" error={clientIdError}>
        <Input
          id="connect-oauth-client-id"
          value={clientId}
          onChange={(e) => onClientIdChange(e.target.value)}
          hasError={clientIdError !== undefined}
          aria-required="true"
        />
      </Field>
      <Field id="connect-oauth-client-secret" label="Client secret" error={clientSecretError}>
        <Input
          id="connect-oauth-client-secret"
          type="password"
          autoComplete="new-password"
          value={clientSecret}
          onChange={(e) => onClientSecretChange(e.target.value)}
          hasError={clientSecretError !== undefined}
          aria-required="true"
          placeholder="Paste your OAuth app's client secret"
        />
      </Field>
      <Field id="connect-oauth-scopes" label="Scopes (space-separated)">
        <Input
          id="connect-oauth-scopes"
          value={scopes}
          onChange={(e) => onScopesChange(e.target.value)}
        />
      </Field>
      {error !== undefined && (
        <p
          role="alert"
          style={{ fontSize: "var(--text-caption)", color: "var(--status-error-fg)", margin: 0 }}
        >
          {error}
        </p>
      )}
      <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
        You'll be redirected to authorize, then brought back here connected.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// Trigger button — same relabeling rule as the shipped affordance ("Add
// account" once the surface already has ≥1 connection).
// ---------------------------------------------------------------------------

export function ConnectPanelButton({
  appId,
  appDisplayName,
  surface,
  connectable,
  hasConnections,
  help,
  oauthProviders,
  onConnected,
}: {
  readonly appId: string
  readonly appDisplayName: string
  readonly surface: SurfaceView
  readonly connectable: SurfaceConnectable
  readonly hasConnections: boolean
  readonly help: AppHelp | undefined
  readonly oauthProviders: OAuthProviderMeta[]
  readonly onConnected: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div>
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          <Plug className="h-4 w-4" aria-hidden="true" />
          {hasConnections ? "Add account" : `Connect ${appDisplayName} · ${surface.displayName}`}
        </Button>
      </div>
      <ConnectPanelDialog
        open={open}
        onOpenChange={setOpen}
        appId={appId}
        appDisplayName={appDisplayName}
        surface={surface}
        connectable={connectable}
        hasConnections={hasConnections}
        existingAccounts={surface.connections
          .map((c) => c.account.trim())
          .filter((a) => a !== "" && a !== "—")}
        help={help}
        oauthProviders={oauthProviders}
        onConnected={onConnected}
      />
    </>
  )
}
