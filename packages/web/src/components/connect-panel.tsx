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
  const callbackPath = help?.oauthApp?.callbackPath
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
        {callbackPath !== undefined && (
          <li style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
            Set the callback URL to <MonoCode>{callbackPath}</MonoCode>
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

  function reset() {
    setMode("fast")
    setAuthMode(defaultAuthMode(modes))
    setAccount(hasConnections ? "" : "default")
    setSecret("")
    setSubmitting(false)
    setError(undefined)
    setAccountError(undefined)
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

  async function handleConfirm() {
    if (isOAuth) {
      handleOpenChange(false)
      window.location.href = "/credentials"
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
              {modes.length > 1 && (
                <Field id="connect-auth-mode" label="Auth mode">
                  <Select value={authMode} onValueChange={handleAuthModeChange}>
                    <SelectTrigger id="connect-auth-mode">
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
              )}

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
              {modes.length > 1 && (
                <Field id="connect-auth-mode-guided" label="Auth mode">
                  <Select value={authMode} onValueChange={handleAuthModeChange}>
                    <SelectTrigger id="connect-auth-mode-guided">
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
              )}

              {isCli && <CliSandboxExplainer install={help?.install} notes={surface.notes} />}

              <GuidedContent
                authMode={authMode}
                appDisplayName={appDisplayName}
                help={help}
                provider={provider}
              />

              {isOAuth ? (
                <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
                  Once your OAuth app is registered, continue to the Credentials page to finish
                  connecting.
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
        </Tabs>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={submitting || (!isOAuth && (secret.trim() === "" || account.trim() === ""))}
            onClick={() => void handleConfirm()}
          >
            {submitting ? "Connecting…" : isOAuth ? "Continue to Credentials" : "Connect"}
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
