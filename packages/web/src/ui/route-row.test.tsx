// SPDX-License-Identifier: AGPL-3.0-only
// Tests for RouteRow — the signature element of inc 24.5.
// Verifies: platform · credentialAccount · namespace chip · filter · enabled/disabled badge.
// Edge cases: credentialAccount "(none)" → "No Auth" badge; toolFilter object → compact render.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceMeta } from "../server/data.functions.js"
import { RouteRow } from "./route-row.js"

afterEach(() => cleanup())

// namespace and platform are distinct fields — use different values so tests can
// assert each independently without ambiguous multi-match errors.
const baseSource: SourceMeta = {
  namespace: "gh",
  platform: "github",
  credentialAccount: "alice",
  enabled: true,
}

describe("RouteRow", () => {
  it("renders as a <li> element (semantic list item)", () => {
    const { container } = render(
      <ul>
        <RouteRow source={baseSource} />
      </ul>,
    )
    const li = container.querySelector("li")
    expect(li).toBeInTheDocument()
  })

  it("renders the platform name", () => {
    const { getByText } = render(
      <ul>
        <RouteRow source={baseSource} />
      </ul>,
    )
    expect(getByText("github")).toBeInTheDocument()
  })

  it("renders the credential account when not '(none)'", () => {
    const { getByText } = render(
      <ul>
        <RouteRow source={baseSource} />
      </ul>,
    )
    expect(getByText("alice")).toBeInTheDocument()
  })

  it("renders namespace chip", () => {
    const { getByText } = render(
      <ul>
        <RouteRow source={baseSource} />
      </ul>,
    )
    expect(getByText("gh")).toBeInTheDocument()
  })

  it("shows 'Configured' badge for enabled source", () => {
    const { getByText } = render(
      <ul>
        <RouteRow source={baseSource} />
      </ul>,
    )
    expect(getByText("Configured")).toBeInTheDocument()
  })

  it("shows 'Disabled' badge for disabled source", () => {
    const disabled: SourceMeta = { ...baseSource, enabled: false }
    const { getByText } = render(
      <ul>
        <RouteRow source={disabled} />
      </ul>,
    )
    expect(getByText("Disabled")).toBeInTheDocument()
  })

  it("renders 'No Auth' badge when credentialAccount is '(none)'", () => {
    const noAuth: SourceMeta = { ...baseSource, credentialAccount: "(none)" }
    const { getByText, queryByText } = render(
      <ul>
        <RouteRow source={noAuth} />
      </ul>,
    )
    // "No Auth" badge should appear; literal string "(none)" must NOT
    expect(getByText("No Auth")).toBeInTheDocument()
    expect(queryByText("(none)")).not.toBeInTheDocument()
  })

  it("renders 'All tools' when toolFilter is undefined", () => {
    const { getByText } = render(
      <ul>
        <RouteRow source={baseSource} />
      </ul>,
    )
    expect(getByText("All tools")).toBeInTheDocument()
  })

  it("renders allow count when toolFilter has allow list", () => {
    const withFilter: SourceMeta = {
      ...baseSource,
      toolFilter: { allow: ["list_issues", "create_issue", "update_issue"] },
    }
    const { getByText } = render(
      <ul>
        <RouteRow source={withFilter} />
      </ul>,
    )
    expect(getByText("+3 allow")).toBeInTheDocument()
  })

  it("renders deny count when toolFilter has deny list", () => {
    const withDeny: SourceMeta = {
      ...baseSource,
      toolFilter: { deny: ["delete_repo", "create_repo"] },
    }
    const { getByText } = render(
      <ul>
        <RouteRow source={withDeny} />
      </ul>,
    )
    expect(getByText("−2 deny")).toBeInTheDocument()
  })

  it("renders both allow and deny counts with · separator", () => {
    const withBoth: SourceMeta = {
      ...baseSource,
      toolFilter: { allow: ["a", "b"], deny: ["c"] },
    }
    const { getByText } = render(
      <ul>
        <RouteRow source={withBoth} />
      </ul>,
    )
    expect(getByText("+2 allow · −1 deny")).toBeInTheDocument()
  })

  it("renders 'All tools' when toolFilter is empty object (no allow/deny)", () => {
    const empty: SourceMeta = { ...baseSource, toolFilter: {} }
    const { getByText } = render(
      <ul>
        <RouteRow source={empty} />
      </ul>,
    )
    expect(getByText("All tools")).toBeInTheDocument()
  })

  it("renders '(unknown)' as literal text when credentialAccount is '(unknown)'", () => {
    // "(unknown)" is a real string label — it must render as-is, not as a badge.
    const unknown: SourceMeta = { ...baseSource, credentialAccount: "(unknown)" }
    const { getByText } = render(
      <ul>
        <RouteRow source={unknown} />
      </ul>,
    )
    expect(getByText("(unknown)")).toBeInTheDocument()
  })

  it("never renders '[object Object]' for toolFilter", () => {
    const withFilter: SourceMeta = {
      ...baseSource,
      toolFilter: { allow: ["a"] },
    }
    const { queryByText } = render(
      <ul>
        <RouteRow source={withFilter} />
      </ul>,
    )
    expect(queryByText("[object Object]")).not.toBeInTheDocument()
  })
})
