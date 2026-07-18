// SPDX-License-Identifier: AGPL-3.0-only
// Custom OAuth-design create dialog (increment 45, Slice D2) — two entry
// modes mirroring the inc-36 connect-panel Tabs pattern: "From an issuer URL"
// (OIDC discovery pre-fills authorization/token/userinfo URLs + scopes, the
// user supplies displayName + slug + confirms) and "Manual" (the full field
// set, advanced fields collapsed). The tokenUrl is the token-exfil surface —
// always shown in full, never hidden, and the user must see it before Create.
//
// No @junction/core import. Only *.functions.js server-fn wrappers + ui
// primitives — same server-only boundary as connection-dialogs.tsx.

import { useState } from "react"
import { toast } from "sonner"
import {
  designSlugError,
  designUrlError,
  issuerUrlError,
} from "../routes/-components/oauth-design-form-validation.js"
import { addCustomDesignFn, discoverOidcFn } from "../server/oauth-design-mutations.functions.js"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFormFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  MonoCode,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
} from "../ui/index.js"

export interface CreateDesignDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onCreated: () => void
}

type EntryMode = "issuer" | "manual"

const EMPTY_FORM = {
  slug: "",
  displayName: "",
  authorizationUrl: "",
  tokenUrl: "",
  userinfoUrl: "",
  scopes: "",
  docsUrl: "",
}

export function CreateDesignDialog({ open, onOpenChange, onCreated }: CreateDesignDialogProps) {
  const [mode, setMode] = useState<EntryMode>("issuer")
  const [issuerUrl, setIssuerUrl] = useState("")
  const [discovering, setDiscovering] = useState(false)
  const [issuerError, setIssuerErrorState] = useState<string | undefined>(undefined)
  const [discovered, setDiscovered] = useState(false)

  const [form, setForm] = useState(EMPTY_FORM)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [pkce, setPkce] = useState<"S256" | "plain" | "disabled">("S256")
  const [supportsRefresh, setSupportsRefresh] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [slugError, setSlugError] = useState<string | undefined>(undefined)
  const [authUrlError, setAuthUrlError] = useState<string | undefined>(undefined)
  const [tokenUrlError, setTokenUrlError] = useState<string | undefined>(undefined)
  const [tokenUrlConfirmed, setTokenUrlConfirmed] = useState(false)

  function reset() {
    setMode("issuer")
    setIssuerUrl("")
    setDiscovering(false)
    setIssuerErrorState(undefined)
    setDiscovered(false)
    setForm(EMPTY_FORM)
    setShowAdvanced(false)
    setPkce("S256")
    setSupportsRefresh(true)
    setSubmitting(false)
    setError(undefined)
    setSlugError(undefined)
    setAuthUrlError(undefined)
    setTokenUrlError(undefined)
    setTokenUrlConfirmed(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleDiscover() {
    const urlErr = issuerUrlError(issuerUrl)
    if (issuerUrl === "" || urlErr !== undefined) {
      setIssuerErrorState(urlErr ?? "Issuer URL is required")
      return
    }
    setIssuerErrorState(undefined)
    setDiscovering(true)
    setError(undefined)
    try {
      const result = await discoverOidcFn({ data: { issuerUrl } })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setForm((prev) => ({
        ...prev,
        authorizationUrl: result.design.authorizationUrl ?? prev.authorizationUrl,
        tokenUrl: result.design.tokenUrl ?? prev.tokenUrl,
        userinfoUrl: result.design.userinfoUrl ?? prev.userinfoUrl,
        scopes: result.design.defaultScopes?.join(" ") ?? prev.scopes,
      }))
      if (result.design.pkce !== undefined) setPkce(result.design.pkce)
      setDiscovered(true)
      setTokenUrlConfirmed(false)
      toast.success("Endpoints discovered — review, then confirm the token URL below.")
    } finally {
      setDiscovering(false)
    }
  }

  function handleSlugChange(value: string) {
    setForm((prev) => ({ ...prev, slug: value }))
    setSlugError(designSlugError(value))
  }

  function handleAuthUrlChange(value: string) {
    setForm((prev) => ({ ...prev, authorizationUrl: value }))
    setAuthUrlError(designUrlError(value))
  }

  function handleTokenUrlChange(value: string) {
    setForm((prev) => ({ ...prev, tokenUrl: value }))
    setTokenUrlError(designUrlError(value))
    setTokenUrlConfirmed(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(undefined)

    const sErr = form.slug === "" ? "Slug is required" : designSlugError(form.slug)
    const aErr =
      form.authorizationUrl === ""
        ? "Authorization URL is required"
        : designUrlError(form.authorizationUrl)
    const tErr = form.tokenUrl === "" ? "Token URL is required" : designUrlError(form.tokenUrl)
    setSlugError(sErr)
    setAuthUrlError(aErr)
    setTokenUrlError(tErr)
    if (sErr || aErr || tErr) return
    if (form.displayName.trim() === "") {
      setError("Display name is required")
      return
    }
    if (!tokenUrlConfirmed) {
      setError("Confirm the token URL below before creating — it's where refresh tokens are sent.")
      return
    }

    setSubmitting(true)
    try {
      const result = await addCustomDesignFn({
        data: {
          id: `custom:${form.slug}`,
          displayName: form.displayName.trim(),
          authorizationUrl: form.authorizationUrl,
          tokenUrl: form.tokenUrl,
          // Echo the confirmed tokenUrl so the SERVER enforces the exfil-surface
          // confirmation at the trust boundary (not just this form's state) —
          // the checkbox above gates reaching here; this proves it to the server.
          confirmedTokenUrl: form.tokenUrl,
          userinfoUrl: form.userinfoUrl === "" ? undefined : form.userinfoUrl,
          scopeSeparator: " ",
          pkce,
          supportsRefresh,
          expiryStrategy: "expires_in",
          redirectMode: "loopback-fixed",
          defaultScopes: form.scopes.trim() === "" ? undefined : form.scopes.trim().split(/\s+/),
          registrationHint: { redirectUri: "", scopes: "", docsUrl: form.docsUrl },
        },
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(`Custom design "${result.design.displayName}" created`)
      onCreated()
      handleOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create a custom OAuth design</DialogTitle>
          <DialogDescription>
            Define a bespoke OAuth2/OIDC provider — discover its endpoints from an issuer URL, or
            enter them yourself.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as EntryMode)}>
          <TabsList aria-label="Design entry mode">
            <TabsTrigger value="issuer">From an issuer URL</TabsTrigger>
            <TabsTrigger value="manual">Manual</TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === "issuer" && (
          <div className="flex flex-col gap-3">
            <Field id="design-issuer-url" label="Issuer URL" error={issuerError}>
              <div className="flex gap-2">
                <Input
                  id="design-issuer-url"
                  type="text"
                  value={issuerUrl}
                  onChange={(e) => {
                    setIssuerUrl(e.target.value)
                    if (issuerError !== undefined) setIssuerErrorState(undefined)
                  }}
                  placeholder="https://accounts.example.com"
                  hasError={issuerError !== undefined}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={discovering}
                  onClick={handleDiscover}
                >
                  {discovering ? "Discovering…" : "Discover"}
                </Button>
              </div>
            </Field>
            {discovered && (
              <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)", margin: 0 }}>
                Endpoints filled below from {issuerUrl}/.well-known/openid-configuration — review,
                supply a display name + slug, and confirm the token URL.
              </p>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Field id="design-display-name" label="Display name">
            <Input
              id="design-display-name"
              type="text"
              value={form.displayName}
              onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
              placeholder="Acme OAuth"
              autoComplete="off"
            />
          </Field>

          <Field
            id="design-slug"
            label="Design id"
            error={slugError}
            description={`Resolves to custom:${form.slug || "<slug>"}`}
          >
            <Input
              id="design-slug"
              type="text"
              value={form.slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="acme-oauth"
              hasError={slugError !== undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field id="design-auth-url" label="Authorization URL" error={authUrlError}>
            <Input
              id="design-auth-url"
              type="text"
              value={form.authorizationUrl}
              onChange={(e) => handleAuthUrlChange(e.target.value)}
              placeholder="https://acme.example.com/oauth/authorize"
              hasError={authUrlError !== undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            id="design-token-url"
            label="Token URL"
            error={tokenUrlError}
            description="Refresh tokens are POSTed here — verify this is the provider's real token endpoint."
          >
            <Input
              id="design-token-url"
              type="text"
              value={form.tokenUrl}
              onChange={(e) => handleTokenUrlChange(e.target.value)}
              placeholder="https://acme.example.com/oauth/token"
              hasError={tokenUrlError !== undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {form.tokenUrl !== "" && tokenUrlError === undefined && (
            <label
              className="flex items-start gap-2"
              style={{ fontSize: "var(--text-caption)", color: "var(--gray-900)" }}
            >
              <input
                type="checkbox"
                checked={tokenUrlConfirmed}
                onChange={(e) => setTokenUrlConfirmed(e.target.checked)}
                style={{ marginTop: "2px" }}
              />
              <span>
                I confirm <MonoCode>{form.tokenUrl}</MonoCode> is the correct token endpoint for
                this provider.
              </span>
            </label>
          )}

          <Button type="button" variant="ghost" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide advanced fields" : "Show advanced fields"}
          </Button>

          {showAdvanced && (
            <div className="flex flex-col gap-3">
              <Field id="design-userinfo-url" label="Userinfo URL (optional)">
                <Input
                  id="design-userinfo-url"
                  type="text"
                  value={form.userinfoUrl}
                  onChange={(e) => setForm((prev) => ({ ...prev, userinfoUrl: e.target.value }))}
                  placeholder="https://acme.example.com/oauth/userinfo"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field id="design-scopes" label="Default scopes (space-separated, optional)">
                <Input
                  id="design-scopes"
                  type="text"
                  value={form.scopes}
                  onChange={(e) => setForm((prev) => ({ ...prev, scopes: e.target.value }))}
                  placeholder="openid profile email"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field id="design-docs-url" label="Registration docs URL (optional)">
                <Input
                  id="design-docs-url"
                  type="text"
                  value={form.docsUrl}
                  onChange={(e) => setForm((prev) => ({ ...prev, docsUrl: e.target.value }))}
                  placeholder="https://acme.example.com/docs/oauth"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <div className="flex items-center justify-between">
                <span style={{ fontSize: "var(--text-label)", color: "var(--gray-1000)" }}>
                  Supports refresh
                </span>
                <Switch checked={supportsRefresh} onCheckedChange={setSupportsRefresh} />
              </div>
              <Field id="design-pkce" label="PKCE method">
                <select
                  id="design-pkce"
                  value={pkce}
                  onChange={(e) => setPkce(e.target.value as "S256" | "plain" | "disabled")}
                  className="h-9 rounded-[var(--radius-6)] border px-2"
                  style={{ borderColor: "var(--alpha-200)", background: "var(--bg-100)" }}
                >
                  <option value="S256">S256</option>
                  <option value="plain">plain</option>
                  <option value="disabled">disabled</option>
                </select>
              </Field>
            </div>
          )}

          {error && (
            <p
              role="alert"
              style={{
                fontSize: "var(--text-caption)",
                color: "var(--status-error-fg)",
                margin: 0,
              }}
            >
              {error}
            </p>
          )}

          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Create"
            submittingLabel="Creating…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
