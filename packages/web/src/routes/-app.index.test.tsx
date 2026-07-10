// SPDX-License-Identifier: AGPL-3.0-only
// Route test for /app (index) — the Apps browse-catalog page (increment 30,
// search/filter/sort added increment 30.5 slice 2).
// Strategy: mock createFileRoute so Route.useLoaderData() returns test fixtures,
// then import the module and render Route.options.component. Mirrors
// -platforms.test.tsx's mocking pattern.
//
// Facet filters (Status/Method): happy-dom can't drive the Radix Select portal
// open (see -platforms.test.tsx / -credentials.test.tsx for the same
// limitation) — these tests assert the triggers are present, labeled, and
// default to "All …"; the compose-as-AND filtering behavior itself is exercised
// via useTableView's predicate (generically covered by use-table-view.test.tsx)
// and functionally proven here via search (which drives the identical
// filtered→sorted pipeline). The open→choose→filter UI path is covered by the
// junction-web-verify browser pass.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppGroupMeta, AppMeta } from "../server/data.functions.js"

// ---- Fixtures ---------------------------------------------------------------

// Ordered so a naive "catalog order" test would fail if connected-first sort
// isn't applied: GitLab (unconnected, alphabetically before GitHub) sits
// before GitHub (connected) in the catalog array.
const catalog: AppMeta[] = [
  {
    id: "gitlab",
    displayName: "GitLab",
    supportedKinds: ["cli", "openapi", "graphql"],
    auth: [{ mode: "oauth2", providerId: "gitlab" }, { mode: "token" }],
    aliases: ["glab"],
    iconSlug: "gitlab",
    // Multi-category app — must match the Category facet under EACH category.
    category: ["Developer", "Productivity"],
  },
  {
    id: "github",
    displayName: "GitHub",
    supportedKinds: ["mcp", "cli", "openapi", "graphql"],
    auth: [{ mode: "oauth2", providerId: "github" }, { mode: "token" }],
    aliases: ["gh"],
    iconSlug: "github",
    category: ["Developer"],
  },
  {
    // Deliberately NO category — the Uncategorized bucket's fixture.
    id: "spotify",
    displayName: "Spotify",
    supportedKinds: [],
    auth: [{ mode: "oauth2", providerId: "spotify" }],
  },
]

const emptyLoaderData = { catalog: [] as AppMeta[], groups: [] as AppGroupMeta[] }

const populatedLoaderData = {
  catalog,
  groups: [
    {
      appId: "github",
      connections: [
        {
          credentialId: "cred-1",
          account: "work",
          platformId: "github",
          platformDisplayName: "GitHub",
          kind: "openapi",
        },
      ],
    },
  ] as AppGroupMeta[],
}

const withOtherLoaderData = {
  catalog,
  groups: [
    ...populatedLoaderData.groups,
    {
      appId: "other",
      connections: [
        {
          credentialId: "cred-2",
          account: "solo",
          platformId: "mystery-thing",
          platformDisplayName: "Mystery Thing",
          kind: "cli",
        },
      ],
    },
  ] as AppGroupMeta[],
}

// ---- Mocks ------------------------------------------------------------------

const mockUseLoaderData = vi.fn().mockReturnValue(emptyLoaderData)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (_path: string) => (options: { component: React.FC }) => ({
    useLoaderData: mockUseLoaderData,
    options,
  }),
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string
    params?: Record<string, string>
    children: React.ReactNode
  }) => {
    const href = params ? to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? "") : to
    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  },
}))

vi.mock("../server/data.functions.js", () => ({
  getApps: vi.fn(),
}))

const { Route, matchesCategory } = await import("./app.index.js")
// biome-ignore lint/suspicious/noExplicitAny: test utility — internal options shape
const AppsIndexPage = (Route as any).options.component as React.FC

afterEach(() => {
  cleanup()
  mockUseLoaderData.mockReset()
})

describe("AppsIndexPage", () => {
  it("renders the page heading as <h1> (route landmark)", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByRole("heading", { level: 1, name: "Apps" })).toBeInTheDocument()
  })

  it("shows an empty state when the catalog has no apps", () => {
    mockUseLoaderData.mockReturnValue(emptyLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByText(/no apps in the catalog yet/i)).toBeInTheDocument()
  })

  it("renders every catalog app, including unconnected ones", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.getByText("Spotify")).toBeInTheDocument()
  })

  it("shows a connected count for an app with connections, and Available for one with none", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByText("1 connected")).toBeInTheDocument()
    expect(screen.getAllByText("Available").length).toBeGreaterThan(0)
  })

  it("links each app card to /app/:id", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    const githubLink = screen.getByText("GitHub").closest("a")
    expect(githubLink).toHaveAttribute("href", "/app/github")
  })

  it("renders a synthetic Other card only when a connection attributes to 'other'", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    const { rerender } = render(<AppsIndexPage />)
    expect(screen.queryByText("Other")).not.toBeInTheDocument()

    mockUseLoaderData.mockReturnValue(withOtherLoaderData)
    rerender(<AppsIndexPage />)
    expect(screen.getByText("Other")).toBeInTheDocument()
    const otherLink = screen.getByText("Other").closest("a")
    expect(otherLink).toHaveAttribute("href", "/app/other")
  })

  it("renders an oauth badge (not the old sentence) for an app with no supportedKinds", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    expect(screen.queryByText(/oauth-only/i)).not.toBeInTheDocument()
    const spotifyCard = screen.getByText("Spotify").closest("a")
    expect(spotifyCard).toHaveTextContent("oauth")
  })

  it("renders a brand glyph for an app with a known iconSlug, and a letter tile for one without", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    // The glyph is decorative (aria-hidden, name is visible) — assert on the DOM.
    // GitHub has iconSlug: "github" -> a real <path> glyph, not a blank.
    const githubCard = screen.getByText("GitHub").closest("a")
    expect(githubCard?.querySelector("path")).toBeInTheDocument()
    // Spotify has no iconSlug in this fixture -> letter tile fallback (no <path>), never blank.
    const spotifyCard = screen.getByText("Spotify").closest("a")
    expect(spotifyCard?.querySelector("path")).not.toBeInTheDocument()
    expect(spotifyCard).toHaveTextContent("S")
  })

  // ── Search ──────────────────────────────────────────────────────────────────

  it("search input is present and labeled", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    expect(screen.getByRole("searchbox", { name: /search apps/i })).toBeInTheDocument()
  })

  it("narrows the grid via search (typing 'git' shows only GitHub/GitLab)", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    fireEvent.change(screen.getByRole("searchbox", { name: /search apps/i }), {
      target: { value: "git" },
    })
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.getByText("GitLab")).toBeInTheDocument()
    expect(screen.queryByText("Spotify")).not.toBeInTheDocument()
  })

  it("searches by alias (typing 'gh' matches GitHub via its alias)", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    fireEvent.change(screen.getByRole("searchbox", { name: /search apps/i }), {
      target: { value: "gh" },
    })
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.queryByText("Spotify")).not.toBeInTheDocument()
  })

  it("search with no match shows the 'no apps match your filters' empty state", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    fireEvent.change(screen.getByRole("searchbox", { name: /search apps/i }), {
      target: { value: "nonexistent-app-xyz" },
    })
    expect(screen.getByText(/no apps match your filters/i)).toBeInTheDocument()
  })

  // ── Facet filters (Status / Method) ────────────────────────────────────────
  // See the file-level comment: the Radix Select portal can't be driven open
  // in happy-dom, so these assert presence/labels/defaults only.

  it("Status and Method filter dropdowns are present, labeled, default to 'All …'", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)

    const statusTrigger = screen.getByRole("combobox", { name: /filter by status/i })
    expect(statusTrigger).toBeInTheDocument()
    expect(statusTrigger.textContent).toMatch(/all statuses/i)

    const methodTrigger = screen.getByRole("combobox", { name: /filter by method/i })
    expect(methodTrigger).toBeInTheDocument()
    expect(methodTrigger.textContent).toMatch(/all methods/i)
  })

  it("Category filter dropdown is present, labeled, defaults to 'All categories'", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)

    const categoryTrigger = screen.getByRole("combobox", { name: /filter by category/i })
    expect(categoryTrigger).toBeInTheDocument()
    expect(categoryTrigger.textContent).toMatch(/all categories/i)
  })

  // ── Sort toggle ─────────────────────────────────────────────────────────────

  it("defaults to connected-first ordering (GitHub before GitLab/Spotify despite catalog order)", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)
    const cards = screen.getAllByRole("link")
    const names = cards.map((c) => c.textContent ?? "")
    const githubIdx = names.findIndex((t) => t.includes("GitHub"))
    const gitlabIdx = names.findIndex((t) => t.includes("GitLab"))
    const spotifyIdx = names.findIndex((t) => t.includes("Spotify"))

    expect(githubIdx).toBeGreaterThanOrEqual(0)
    expect(gitlabIdx).toBeGreaterThanOrEqual(0)
    expect(spotifyIdx).toBeGreaterThanOrEqual(0)

    // Connected-first is the primary key: GitHub (connected) precedes both
    // unconnected apps. This is non-vacuous below (with the A-Z toggle
    // flipped) where GitLab/Spotify's relative order reverses but GitHub still
    // leads — proving connected-first, not plain alphabetical order, wins.
    expect(githubIdx).toBeLessThan(gitlabIdx)
    expect(githubIdx).toBeLessThan(spotifyIdx)
    expect(gitlabIdx).toBeLessThan(spotifyIdx)
  })

  it("A-Z sort toggle button is present and flips to Z-A on click, keeping connected-first", () => {
    mockUseLoaderData.mockReturnValue(populatedLoaderData)
    render(<AppsIndexPage />)

    const toggle = screen.getByRole("button", { name: /sort a to z/i })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveTextContent("A–Z")

    fireEvent.click(toggle)
    expect(screen.getByRole("button", { name: /sort z to a/i })).toHaveTextContent("Z–A")

    // Connected-first is preserved: GitHub (connected) still precedes the
    // unconnected apps even after reversing alphabetical direction.
    const names = screen.getAllByRole("link").map((c) => c.textContent ?? "")
    const githubIdx = names.findIndex((t) => t.includes("GitHub"))
    const gitlabIdx = names.findIndex((t) => t.includes("GitLab"))
    const spotifyIdx = names.findIndex((t) => t.includes("Spotify"))
    expect(githubIdx).toBeLessThan(gitlabIdx)
    expect(githubIdx).toBeLessThan(spotifyIdx)
    // Among the unconnected apps, order should now be reversed: Spotify before GitLab.
    expect(spotifyIdx).toBeLessThan(gitlabIdx)
  })
})

// ── Category predicate (pure) ────────────────────────────────────────────────
// The open→choose→filter UI path can't be driven in happy-dom (Radix Select
// portal — see the file-level comment), so the facet's filtering rule is
// unit-tested directly against the exported pure predicate.

describe("matchesCategory", () => {
  it("'all' matches every app, categorized or not", () => {
    expect(matchesCategory({ category: ["Developer"] }, "all")).toBe(true)
    expect(matchesCategory({}, "all")).toBe(true)
  })

  it("matches a multi-category app under each of its categories", () => {
    const app = { category: ["Developer", "Productivity"] }
    expect(matchesCategory(app, "Developer")).toBe(true)
    expect(matchesCategory(app, "Productivity")).toBe(true)
  })

  it("does not match an app lacking the selected category", () => {
    expect(matchesCategory({ category: ["Developer"] }, "Communication")).toBe(false)
    expect(matchesCategory({}, "Developer")).toBe(false)
  })

  it("'uncategorized' matches only apps with no or empty category", () => {
    expect(matchesCategory({}, "uncategorized")).toBe(true)
    expect(matchesCategory({ category: [] }, "uncategorized")).toBe(true)
    expect(matchesCategory({ category: ["Developer"] }, "uncategorized")).toBe(false)
  })
})
