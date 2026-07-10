// SPDX-License-Identifier: AGPL-3.0-only
// Tests for CliSandboxExplainer (increment 36, Component 2) — asserts install
// commands render as copy-paste, the honest sandbox paragraph always renders,
// verifyCmd + minVersion render, and the caveat notes slot renders. Also an
// adversarial check: the sandbox paragraph never claims live verifyCmd
// execution (v1 is copy-paste only).

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { AppHelp } from "../server/data.functions.js"
import { CliSandboxExplainer } from "./cli-sandbox-explainer.js"

afterEach(() => cleanup())

const githubInstall: AppHelp["install"] = {
  commands: {
    brew: "brew install gh",
    apt: "apt install gh",
    winget: "winget install --id GitHub.cli",
  },
  verifyCmd: "gh --version",
  minVersion: "2.0.0",
}

describe("CliSandboxExplainer", () => {
  it("renders every install command as copy-paste mono text", () => {
    const { getByText } = render(<CliSandboxExplainer install={githubInstall} />)
    expect(getByText("brew install gh")).toBeInTheDocument()
    expect(getByText("apt install gh")).toBeInTheDocument()
    expect(getByText("winget install --id GitHub.cli")).toBeInTheDocument()
  })

  it("renders the honest sandbox paragraph", () => {
    const { getByText } = render(<CliSandboxExplainer install={githubInstall} />)
    expect(getByText(/sandboxed and isolated from your filesystem/)).toBeInTheDocument()
    expect(getByText(/one environment variable/)).toBeInTheDocument()
    expect(getByText(/never.*the CLI's own saved login/)).toBeInTheDocument()
  })

  it("renders verifyCmd as a copy-paste line with minVersion", () => {
    const { getByText } = render(<CliSandboxExplainer install={githubInstall} />)
    expect(getByText("gh --version")).toBeInTheDocument()
    expect(getByText(/2\.0\.0/)).toBeInTheDocument()
  })

  it("renders honest caveat notes when provided", () => {
    const notes = [
      'credentialEnvVar is "GH_PAT" (not gh\'s real "GH_TOKEN") — CliConnectionSchema rejects any *_TOKEN/_SECRET/_KEY suffix.',
    ]
    const { getByText } = render(<CliSandboxExplainer install={githubInstall} notes={notes} />)
    expect(getByText(/CliConnectionSchema rejects/)).toBeInTheDocument()
  })

  it("never claims junction installs the binary or runs verifyCmd live", () => {
    const { container } = render(<CliSandboxExplainer install={githubInstall} />)
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/junction (will )?install/i)
    expect(text).not.toMatch(/running verify|checking now|check now/i)
  })

  it("renders the sandbox paragraph even when install is entirely absent", () => {
    const { getByText, queryByText } = render(<CliSandboxExplainer install={undefined} />)
    expect(getByText(/sandboxed and isolated/)).toBeInTheDocument()
    expect(queryByText(/Check it's installed/)).not.toBeInTheDocument()
  })
})
