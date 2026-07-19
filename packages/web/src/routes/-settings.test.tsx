// SPDX-License-Identifier: AGPL-3.0-only
// Route tests for /settings.
// Strategy: mock createFileRoute + useRouter so Route.useLoaderData() returns
// test fixtures, then import the module and render the route component.
// Server-fns are mocked so happy-dom never calls getRequest() / DB.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// ── Mocks --------------------------------------------------------------------

const mockUseLoaderData = vi.fn()
const mockInvalidate = vi.fn().mockResolvedValue(undefined)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  useRouter: () => ({ invalidate: mockInvalidate }),
  Link: ({
    to,
    children,
    style,
  }: {
    to: string
    children: React.ReactNode
    style?: React.CSSProperties
  }) => (
    <a href={to} style={style}>
      {children}
    </a>
  ),
}))

vi.mock("../server/data.functions.js", () => ({
  getSettings: vi.fn(),
  getOAuthDesigns: vi.fn(),
}))

const mockSetMcpHostFn = vi.fn()
vi.mock("../server/settings.functions.js", () => ({
  setMcpHostFn: (...args: unknown[]) => mockSetMcpHostFn(...args),
}))

// Mock the sidebar ThemeToggle so we don't need the full sidebar context.
vi.mock("../ui/sidebar.js", () => ({
  ThemeToggle: ({ collapsed }: { collapsed: boolean }) => (
    <button type="button" aria-label={`Theme: Dark (collapsed=${String(collapsed)})`}>
      Toggle
    </button>
  ),
  readStoredTheme: () => "dark",
  applyTheme: vi.fn(),
}))

const { Route } = await import("./settings.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — typing the internal options shape is not worth the boilerplate
const SettingsPage = (Route as any).options.component as React.FC

// ── Fixtures -----------------------------------------------------------------

// The loader returns { settings, oauthDesigns } (increment 44). Two built-in
// designs cover the assertions below: a real provider (github, refresh:false)
// referenced by a platform, and the `generic` template (empty endpoints,
// unreferenced).
const oauthDesigns = [
  {
    id: "github",
    displayName: "GitHub",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    pkce: "S256" as const,
    supportsRefresh: false,
    docsUrl: "https://docs.github.com/en/apps/oauth-apps",
    isTemplate: false,
    referencedByPlatformIds: ["gh-work"],
  },
  {
    id: "generic",
    displayName: "Generic OAuth2",
    authorizationUrl: "",
    tokenUrl: "",
    pkce: "S256" as const,
    supportsRefresh: true,
    docsUrl: "",
    isTemplate: true,
    referencedByPlatformIds: [],
  },
]

/** Wrap a settings fixture in the full loader shape ({ settings, oauthDesigns }). */
function loaderData(settings: {
  mcpHost: string | undefined
  mcpHostSource: "none" | "config" | "env"
}) {
  return { settings, oauthDesigns }
}

const noHostData = loaderData({ mcpHost: undefined, mcpHostSource: "none" })
const configHostData = loaderData({
  mcpHost: "junction.example.com",
  mcpHostSource: "config",
})
const envHostData = loaderData({
  mcpHost: "env.example.com",
  mcpHostSource: "env",
})

// ── Cleanup ------------------------------------------------------------------

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
  mockSetMcpHostFn.mockReset()
  mockInvalidate.mockReset().mockResolvedValue(undefined)
})

// ── Tests --------------------------------------------------------------------

describe("SettingsPage", () => {
  // ── Landmark + heading ──────────────────────────────────────────────────────

  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByRole } = render(<SettingsPage />)
    expect(getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument()
  })

  it("renders the MCP Host field (labelled input)", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByLabelText } = render(<SettingsPage />)
    expect(getByLabelText("Host")).toBeInTheDocument()
  })

  it("renders the Save button", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByRole } = render(<SettingsPage />)
    expect(getByRole("button", { name: /save/i })).toBeInTheDocument()
  })

  it("renders the Appearance / Theme section heading", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByRole } = render(<SettingsPage />)
    expect(getByRole("heading", { name: /appearance/i })).toBeInTheDocument()
  })

  it("renders the theme toggle", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByRole } = render(<SettingsPage />)
    expect(getByRole("button", { name: /theme/i })).toBeInTheDocument()
  })

  // ── Host unset state ────────────────────────────────────────────────────────

  it("input is empty when no host is set", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByLabelText } = render(<SettingsPage />)
    const input = getByLabelText("Host") as HTMLInputElement
    expect(input.value).toBe("")
  })

  it("does not render Clear button when no host is set", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { queryByRole } = render(<SettingsPage />)
    expect(queryByRole("button", { name: /clear/i })).not.toBeInTheDocument()
  })

  // ── Host set state (config source) ─────────────────────────────────────────

  it("input is pre-filled with the resolved host when set", () => {
    mockUseLoaderData.mockReturnValue(configHostData)
    const { getByLabelText } = render(<SettingsPage />)
    const input = getByLabelText("Host") as HTMLInputElement
    expect(input.value).toBe("junction.example.com")
  })

  it("shows 'from config' source note when host comes from config", () => {
    mockUseLoaderData.mockReturnValue(configHostData)
    const { getByText } = render(<SettingsPage />)
    expect(getByText("from config")).toBeInTheDocument()
  })

  it("shows 'from JUNCTION_MCP_HOST' source note when host comes from env", () => {
    mockUseLoaderData.mockReturnValue(envHostData)
    const { getByText } = render(<SettingsPage />)
    expect(getByText("from JUNCTION_MCP_HOST")).toBeInTheDocument()
  })

  it("renders Clear button when host is set", () => {
    mockUseLoaderData.mockReturnValue(configHostData)
    const { getByRole } = render(<SettingsPage />)
    expect(getByRole("button", { name: /clear/i })).toBeInTheDocument()
  })

  // ── Save flow ───────────────────────────────────────────────────────────────

  it("Save calls setMcpHostFn with the input value and invalidates router on success", async () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    mockSetMcpHostFn.mockResolvedValue({ ok: true })

    const { getByLabelText, getByRole } = render(<SettingsPage />)
    const input = getByLabelText("Host") as HTMLInputElement
    fireEvent.change(input, { target: { value: "my.host.com" } })
    fireEvent.click(getByRole("button", { name: /save/i }))

    await waitFor(() => expect(mockSetMcpHostFn).toHaveBeenCalledTimes(1))
    expect(mockSetMcpHostFn).toHaveBeenCalledWith({ data: { host: "my.host.com" } })
    await waitFor(() => expect(mockInvalidate).toHaveBeenCalled())
  })

  it("Save does NOT call mutation when input contains a scheme (client validation)", async () => {
    mockUseLoaderData.mockReturnValue(noHostData)

    const { getByLabelText, getByRole, findByRole } = render(<SettingsPage />)
    const input = getByLabelText("Host") as HTMLInputElement
    fireEvent.change(input, { target: { value: "https://bad.host.com" } })
    fireEvent.click(getByRole("button", { name: /save/i }))

    // Client-side validation error should appear in the field's alert (not the
    // static description, which also mentions "no scheme").
    const alert = await findByRole("alert")
    expect(alert.textContent ?? "").toMatch(/no scheme/i)
    expect(mockSetMcpHostFn).not.toHaveBeenCalled()
  })

  it("Clear calls setMcpHostFn with empty host and invalidates router", async () => {
    mockUseLoaderData.mockReturnValue(configHostData)
    mockSetMcpHostFn.mockResolvedValue({ ok: true })

    const { getByRole } = render(<SettingsPage />)
    fireEvent.click(getByRole("button", { name: /clear/i }))

    await waitFor(() => expect(mockSetMcpHostFn).toHaveBeenCalledTimes(1))
    expect(mockSetMcpHostFn).toHaveBeenCalledWith({ data: { host: "" } })
    await waitFor(() => expect(mockInvalidate).toHaveBeenCalled())
  })

  // ── OAuth designs section (increment 44, R1 — READ-ONLY) ────────────────────

  it("renders the OAuth designs section heading", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByRole } = render(<SettingsPage />)
    expect(getByRole("heading", { name: /oauth designs/i })).toBeInTheDocument()
  })

  it("lists each built-in design by display name and id", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByRole, getByText } = render(<SettingsPage />)
    expect(getByRole("heading", { name: "GitHub" })).toBeInTheDocument()
    expect(getByRole("heading", { name: "Generic OAuth2" })).toBeInTheDocument()
    // ids shown as mono chips
    expect(getByText("github")).toBeInTheDocument()
    expect(getByText("generic")).toBeInTheDocument()
  })

  it("shows a design's public endpoints (authorization + token URLs)", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByText } = render(<SettingsPage />)
    expect(getByText("https://github.com/login/oauth/authorize")).toBeInTheDocument()
    expect(getByText("https://github.com/login/oauth/access_token")).toBeInTheDocument()
  })

  it("flags the generic design as a Template", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByText } = render(<SettingsPage />)
    expect(getByText("Template")).toBeInTheDocument()
  })

  it("shows which platform(s) reference a design, and 'none yet' when unreferenced", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { getByText } = render(<SettingsPage />)
    // github is referenced by gh-work
    expect(getByText("gh-work")).toBeInTheDocument()
    expect(getByText(/Referenced by 1 platform/i)).toBeInTheDocument()
    // generic is unreferenced
    expect(getByText(/No platforms reference this design yet/i)).toBeInTheDocument()
  })

  it("renders no secret/client material — only public catalog data", () => {
    mockUseLoaderData.mockReturnValue(noHostData)
    const { container } = render(<SettingsPage />)
    const text = container.textContent ?? ""
    // The designs surface is metadata-only: no client secret / credential value
    // ever reaches it (the fixtures carry none, and the type has no such
    // field). NOTE: the provider's public token ENDPOINT url legitimately
    // contains the path segment "access_token" (github's token endpoint is
    // .../oauth/access_token) — that's a public catalog URL, not a secret, so
    // we assert on actual secret material (client secret / secretRef), never on
    // the endpoint URL.
    expect(text).not.toMatch(/client[_-]?secret/i)
    expect(text).not.toMatch(/secretRef/i)
  })
})
