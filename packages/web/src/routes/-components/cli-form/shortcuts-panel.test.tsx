// SPDX-License-Identifier: AGPL-3.0-only
// ShortcutsPanel tests (increment 41.5) — the "Shortcuts (saved commands)"
// editing surface for a Full CLI access platform: renders the exact Q6 label,
// reuses the declared-tool card verbatim, and allows shrinking to zero (unlike
// the declared-mode tool list, which requires at least one).

import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { ShortcutsPanel } from "./shortcuts-panel.js"
import type { CliToolFormState } from "./types.js"
import { emptyTool } from "./types.js"

afterEach(cleanup)

describe("ShortcutsPanel", () => {
  it("renders the exact Fable Q6 label", () => {
    const { getByText } = render(<ShortcutsPanel shortcuts={[]} onChange={() => {}} />)
    expect(getByText("Shortcuts (saved commands)")).toBeInTheDocument()
  })

  it("with zero shortcuts, shows the empty-state note and an Add Shortcut button (no tool card)", () => {
    const { getByText, queryByPlaceholderText } = render(
      <ShortcutsPanel shortcuts={[]} onChange={() => {}} />,
    )
    expect(getByText(/No shortcuts yet/)).toBeInTheDocument()
    expect(getByText("Add Shortcut")).toBeInTheDocument()
    // No tool card rendered — the guided command-builder input isn't present.
    expect(queryByPlaceholderText("/opt/homebrew/bin/rg --json $pattern")).not.toBeInTheDocument()
  })

  it("renders one tool card per existing shortcut, reusing the declared ToolCard verbatim", () => {
    const shortcut: CliToolFormState = {
      ...emptyTool(),
      name: "pr_list",
      commandLine: "/usr/bin/gh pr list",
    }
    const { getAllByText, getByPlaceholderText } = render(
      <ShortcutsPanel shortcuts={[shortcut]} onChange={() => {}} />,
    )
    expect(getAllByText("pr_list").length).toBeGreaterThan(0)
    expect(getByPlaceholderText("/opt/homebrew/bin/rg --json $pattern")).toBeInTheDocument()
  })

  it("adding a shortcut appends a new tool card via the shared ToolCardList", () => {
    function Wrapper() {
      const [shortcuts, setShortcuts] = useState<CliToolFormState[]>([])
      return <ShortcutsPanel shortcuts={shortcuts} onChange={setShortcuts} />
    }
    const { getByText, getAllByText, queryByText } = render(<Wrapper />)
    expect(queryByText(/No shortcuts yet/)).toBeInTheDocument()

    fireEvent.click(getByText("Add Shortcut"))

    expect(queryByText(/No shortcuts yet/)).not.toBeInTheDocument()
    expect(getAllByText("Tool 1").length).toBeGreaterThan(0)
  })

  it("removing the LAST shortcut is allowed (minItems=0 — unlike declared mode's minimum of one)", () => {
    function Wrapper() {
      const [shortcuts, setShortcuts] = useState<CliToolFormState[]>([
        { ...emptyTool(), name: "only_one" },
      ])
      return <ShortcutsPanel shortcuts={shortcuts} onChange={setShortcuts} />
    }
    const { getByText, queryByText } = render(<Wrapper />)
    // The tool card auto-expands (single item), showing "Remove Tool".
    const removeButton = getByText("Remove Tool") as HTMLButtonElement
    expect(removeButton.disabled).toBe(false)
    fireEvent.click(removeButton)
    expect(queryByText(/No shortcuts yet/)).toBeInTheDocument()
  })
})
