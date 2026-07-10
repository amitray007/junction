// SPDX-License-Identifier: AGPL-3.0-only
// Tests for AppHelpPanel (increment 36, Component 3) — pure render of
// AppDetail.app.help. Asserts links/chips/prose render, external links are
// rel=noopener, and the panel no-ops (renders nothing) when help is absent
// or empty. Metadata-only sweep: help never carries a secret, so there is
// nothing to assert-absent here beyond the shape itself.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { AppHelp } from "../server/data.functions.js"
import { AppHelpPanel } from "./app-help-panel.js"

afterEach(() => cleanup())

const fullHelp: AppHelp = {
  category: ["dev-tools", "git-hosting"],
  homepage: "https://github.com",
  statusPage: "https://www.githubstatus.com",
  description: "Git hosting, issues, pull requests, and CI/CD (Actions) for software projects.",
  agentGuidance: "Covers repos, issues, PRs, and Actions.",
  oauthApp: {
    registerUrl: "https://github.com/settings/applications/new",
    callbackPath: "/oauth/callback/github",
  },
  install: {
    commands: { brew: "brew install gh" },
    verifyCmd: "gh --version",
    minVersion: "2.0.0",
  },
  authSetup: {
    interactive: "gh auth login",
    env: "GH_TOKEN",
    configPath: "~/.config/gh/hosts.yml",
  },
}

describe("AppHelpPanel", () => {
  it("renders nothing when help is undefined", () => {
    const { container } = render(<AppHelpPanel help={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when help is an empty object", () => {
    const { container } = render(<AppHelpPanel help={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders category chips", () => {
    const { getByText } = render(<AppHelpPanel help={fullHelp} />)
    expect(getByText("dev-tools")).toBeInTheDocument()
    expect(getByText("git-hosting")).toBeInTheDocument()
  })

  it("renders description and agent guidance as prose", () => {
    const { getByText } = render(<AppHelpPanel help={fullHelp} />)
    expect(
      getByText("Git hosting, issues, pull requests, and CI/CD (Actions) for software projects."),
    ).toBeInTheDocument()
    expect(getByText(/Covers repos, issues, PRs, and Actions\./)).toBeInTheDocument()
  })

  it("renders homepage/statusPage as external links with rel=noopener", () => {
    const { getByRole } = render(<AppHelpPanel help={fullHelp} />)
    const homepage = getByRole("link", { name: /Homepage/ })
    expect(homepage).toHaveAttribute("href", "https://github.com")
    expect(homepage).toHaveAttribute("target", "_blank")
    expect(homepage.getAttribute("rel")).toContain("noopener")

    const status = getByRole("link", { name: /Status page/ })
    expect(status).toHaveAttribute("href", "https://www.githubstatus.com")
    expect(status.getAttribute("rel")).toContain("noopener")
  })

  it("renders the oauthApp register link as an external, rel=noopener link", () => {
    const { getByRole } = render(<AppHelpPanel help={fullHelp} />)
    const registerLink = getByRole("link", { name: /Register your OAuth app/ })
    expect(registerLink).toHaveAttribute("href", "https://github.com/settings/applications/new")
    expect(registerLink.getAttribute("rel")).toContain("noopener")
  })

  it("renders the authSetup block (interactive/env/configPath) as labeled rows", () => {
    const { getByText } = render(<AppHelpPanel help={fullHelp} />)
    expect(getByText("gh auth login")).toBeInTheDocument()
    expect(getByText("GH_TOKEN")).toBeInTheDocument()
    expect(getByText("~/.config/gh/hosts.yml")).toBeInTheDocument()
  })

  it("never renders install.commands or verifyCmd (that's Component 2's job, not the help panel)", () => {
    const { queryByText } = render(<AppHelpPanel help={fullHelp} />)
    expect(queryByText("brew install gh")).not.toBeInTheDocument()
    expect(queryByText("gh --version")).not.toBeInTheDocument()
  })
})
