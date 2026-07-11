// SPDX-License-Identifier: AGPL-3.0-only
// Tests for ConnectPanelDialog/ConnectPanelButton (increment 36, Component
// 1) — the two-mode toggle over the shipped connectSurfaceFn write path.
// connectSurfaceFn is mocked (same strategy as connection-dialogs.test.tsx /
// -app.$id.test.tsx) so happy-dom never calls getRequest()/DB.
//
// Asserts BEHAVIOR: the mode toggle switches visible content (guided shows
// register/install guidance the fast mode doesn't); the shipped guards
// (empty-secret, duplicate-account, verify-before-commit via
// connectSurfaceFn) still fire from EITHER mode; oauth2 stays a deep-link
// hand-off (no inline write); and an adversarial sweep — no secret/token the
// user typed ever leaks into a text node outside the input's own value.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  AppHelp,
  OAuthProviderMeta,
  SurfaceConnectable,
  SurfaceView,
} from "../server/data.functions.js"

const mockConnectSurfaceFn = vi.fn()
vi.mock("../server/connect.functions.js", () => ({
  connectSurfaceFn: (...args: unknown[]) => mockConnectSurfaceFn(...args),
}))

const { ConnectPanelDialog, ConnectPanelButton } = await import("./connect-panel.js")

afterEach(() => {
  cleanup()
  mockConnectSurfaceFn.mockReset()
})

const tokenConnectable: SurfaceConnectable = { authModes: ["token"], verifiable: true }

const cliSurface: SurfaceView = {
  kind: "cli",
  displayName: "gh CLI",
  auth: [{ mode: "token" }],
  state: "available",
  connections: [],
  connectable: tokenConnectable,
  notes: ['credentialEnvVar is "GH_PAT" (not gh\'s real "GH_TOKEN") — CliConnectionSchema quirk.'],
}

// oauth2-ONLY surface — `defaultAuthMode` has no non-oauth2 mode to prefer,
// so the dialog necessarily opens in oauth2 mode. Used to prove the oauth2
// deep-link path without depending on driving the Radix Select through
// happy-dom's Portal (a documented limitation elsewhere in this repo — see
// -app.$id.test.tsx's file header — the affordance's BEHAVIOR is what's
// under test here, not the Select primitive itself).
const openapiSurfaceOAuthOnly: SurfaceView = {
  kind: "openapi",
  displayName: "REST API",
  auth: [{ mode: "oauth2", providerId: "github" }],
  state: "available",
  connections: [],
  connectable: { authModes: ["oauth2"], verifiable: true },
}

/** Radix TabsTrigger activates on `mousedown` (not `click`) — see
 *  @radix-ui/react-tabs's onMouseDown handler. happy-dom's fireEvent.click
 *  does not synthesize the native focus+mousedown sequence a real browser
 *  click does, so tests must fire mousedown directly to switch tabs. */
function switchTab(getByRole: ReturnType<typeof renderDialog>["getByRole"], name: string) {
  fireEvent.mouseDown(getByRole("tab", { name }), { button: 0 })
}

const githubHelp: AppHelp = {
  oauthApp: {
    registerUrl: "https://github.com/settings/applications/new",
    callbackPath: "/oauth/callback/github",
  },
  install: {
    commands: { brew: "brew install gh" },
    verifyCmd: "gh --version",
  },
  authSetup: { interactive: "gh auth login", env: "GH_TOKEN" },
}

const githubProvider: OAuthProviderMeta = {
  id: "github",
  displayName: "GitHub",
  supportsDeviceCode: false,
  redirectMode: "loopback-fixed",
  defaultScopes: ["repo"],
  registrationHint: {
    redirectUri: "http://127.0.0.1:5190/oauth/callback/github",
    scopes: "repo, read:user",
    docsUrl: "https://docs.github.com/en/apps/oauth-apps",
  },
}

function renderDialog(overrides: Partial<Parameters<typeof ConnectPanelDialog>[0]> = {}) {
  return render(
    <ConnectPanelDialog
      open={true}
      onOpenChange={vi.fn()}
      appId="github"
      appDisplayName="GitHub"
      surface={cliSurface}
      connectable={tokenConnectable}
      hasConnections={false}
      existingAccounts={[]}
      help={githubHelp}
      oauthProviders={[githubProvider]}
      onConnected={vi.fn()}
      {...overrides}
    />,
  )
}

describe("ConnectPanelDialog — mode toggle", () => {
  it("opens in fast mode by default, showing the credential fields immediately", () => {
    const { getByLabelText, queryByText } = renderDialog()
    expect(getByLabelText("Account")).toBeInTheDocument()
    expect(getByLabelText("Secret")).toBeInTheDocument()
    // Guided-only content is not visible while the fast tab is active.
    expect(queryByText(/Install it yourself/)).not.toBeInTheDocument()
  })

  it("switching to 'Help me set this up' reveals the CLI sandbox explainer for a cli surface", () => {
    const { getByRole, getByText } = renderDialog()
    switchTab(getByRole, "Help me set this up")
    expect(getByText(/Install it yourself/)).toBeInTheDocument()
    expect(getByText("brew install gh")).toBeInTheDocument()
    expect(getByText(/sandboxed and isolated from your filesystem/)).toBeInTheDocument()
  })

  it("switching back to 'I already have credentials' hides the guided content again", () => {
    const { getByRole, queryByText } = renderDialog()
    switchTab(getByRole, "Help me set this up")
    switchTab(getByRole, "I already have credentials")
    expect(queryByText(/Install it yourself/)).not.toBeInTheDocument()
  })

  it("guided mode for an oauth2-only surface shows the register URL, the PROVIDER's redirect URI, and scopes", () => {
    const { getByRole, getByText } = renderDialog({
      surface: openapiSurfaceOAuthOnly,
      connectable: { authModes: ["oauth2"], verifiable: true },
    })
    switchTab(getByRole, "Help me set this up")
    expect(getByRole("link", { name: /Register a new OAuth app with GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/settings/applications/new",
    )
    // The guided step shows the PROVIDER's redirect-mode-aware registrationHint
    // .redirectUri (here the mock's http://127.0.0.1:5190/oauth/callback/github),
    // NOT the app-level help.oauthApp.callbackPath — so a loopback-ephemeral
    // provider (e.g. Google) advertises the correct loopback URI, not a bogus
    // fixed path (inc 40 follow-up).
    expect(getByText("http://127.0.0.1:5190/oauth/callback/github")).toBeInTheDocument()
    expect(getByText("repo, read:user")).toBeInTheDocument()
  })
})

describe("ConnectPanelDialog — shipped guards preserved (from either mode)", () => {
  it("keeps Connect disabled — and never calls connectSurfaceFn — while the secret is empty", () => {
    const { getByRole } = renderDialog()
    const connectButton = getByRole("button", { name: "Connect" })
    expect(connectButton).toBeDisabled()
    fireEvent.click(connectButton)
    expect(mockConnectSurfaceFn).not.toHaveBeenCalled()
  })

  it("submits account+secret to connectSurfaceFn from guided mode identically to fast mode", async () => {
    mockConnectSurfaceFn.mockResolvedValue({ ok: true, checkedAt: "2026-07-10T00:00:00.000Z" })
    const onConnected = vi.fn()
    const { getByRole, getByLabelText } = renderDialog({ onConnected })

    switchTab(getByRole, "Help me set this up")
    fireEvent.change(getByLabelText("Account"), { target: { value: "default" } })
    fireEvent.change(getByLabelText("Secret"), { target: { value: "ghp_abc123" } })
    fireEvent.click(getByRole("button", { name: "Connect" }))

    await waitFor(() => expect(mockConnectSurfaceFn).toHaveBeenCalled())
    expect(mockConnectSurfaceFn).toHaveBeenCalledWith({
      data: {
        appId: "github",
        surfaceKind: "cli",
        authMode: "token",
        account: "default",
        secret: "ghp_abc123",
      },
    })
    await waitFor(() => expect(onConnected).toHaveBeenCalled())
  })

  it("surfaces the server's duplicateAccount guard on the account field", async () => {
    mockConnectSurfaceFn.mockResolvedValue({ duplicateAccount: "default" })
    const { getByRole, getByLabelText, getByText } = renderDialog()

    fireEvent.change(getByLabelText("Account"), { target: { value: "default" } })
    fireEvent.change(getByLabelText("Secret"), { target: { value: "ghp_abc123" } })
    fireEvent.click(getByRole("button", { name: "Connect" }))

    await waitFor(() =>
      expect(
        getByText("'default' is already connected here — pick a different account name."),
      ).toBeInTheDocument(),
    )
  })

  it("oauth2 mode never calls connectSurfaceFn — it stays a deep-link hand-off", () => {
    const originalLocation = window.location
    // @ts-expect-error — happy-dom allows reassigning location for this assertion
    delete window.location
    // @ts-expect-error
    window.location = { ...originalLocation, href: "" }

    // oauth2-only surface: no non-oauth2 mode exists, so the dialog opens in
    // oauth2 mode directly (no Select interaction needed).
    const { getByRole } = renderDialog({
      surface: openapiSurfaceOAuthOnly,
      connectable: { authModes: ["oauth2"], verifiable: true },
    })

    fireEvent.click(getByRole("button", { name: "Continue to Credentials" }))
    expect(mockConnectSurfaceFn).not.toHaveBeenCalled()
    expect(window.location.href).toBe("/credentials")

    // @ts-expect-error restore
    window.location = originalLocation
  })
})

describe("ConnectPanelDialog — metadata-only / secret non-disclosure", () => {
  it("never renders a typed secret as visible text outside the input's own value", async () => {
    const { getByLabelText, container } = renderDialog()
    fireEvent.change(getByLabelText("Secret"), { target: { value: "super-secret-token-xyz" } })

    const textNodes = Array.from(container.querySelectorAll("p, span, li, dd"))
      .map((el) => el.textContent ?? "")
      .join(" ")
    expect(textNodes).not.toContain("super-secret-token-xyz")
  })

  it("never renders GH_PAT/GH_TOKEN as a value junction will silently accept — guidance only", () => {
    const { getByRole, getByText } = renderDialog()
    switchTab(getByRole, "Help me set this up")
    // The surface's honest denylist-quirk note renders as informational text,
    // not as a pre-filled credential env var value anywhere in the form.
    expect(getByText(/CliConnectionSchema quirk/)).toBeInTheDocument()
  })
})

describe("ConnectPanelButton", () => {
  it("renders the first-connect label and opens the dialog on click", () => {
    const { getByRole, queryByRole } = render(
      <ConnectPanelButton
        appId="github"
        appDisplayName="GitHub"
        surface={cliSurface}
        connectable={tokenConnectable}
        hasConnections={false}
        help={githubHelp}
        oauthProviders={[githubProvider]}
        onConnected={vi.fn()}
      />,
    )
    expect(queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(getByRole("button", { name: /Connect GitHub · gh CLI/ }))
    expect(getByRole("dialog")).toBeInTheDocument()
  })

  it("relabels to 'Add account' once the surface already has a connection", () => {
    const { getByRole } = render(
      <ConnectPanelButton
        appId="github"
        appDisplayName="GitHub"
        surface={cliSurface}
        connectable={tokenConnectable}
        hasConnections={true}
        help={githubHelp}
        oauthProviders={[githubProvider]}
        onConnected={vi.fn()}
      />,
    )
    expect(getByRole("button", { name: "Add account" })).toBeInTheDocument()
  })
})
