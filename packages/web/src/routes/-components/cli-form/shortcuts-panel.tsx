// SPDX-License-Identifier: AGPL-3.0-only
// ShortcutsPanel — "Shortcuts (saved commands)" editing surface for a Full CLI
// access platform (increment 41.5). docs/specs/2026-07-16-cli-exploratory-mode.md
// §5 Q6 — exact label wording. REUSES the existing declared-tool ToolCard +
// ToolCardList verbatim (same CliTool shape, same guided command builder) —
// the only difference from declared mode is these persist into
// connection.shortcuts[] (optional, may be empty) instead of connection.tools[]
// (mandatory, at least one) — hence `minItems={0}` on the shared list.

import { ToolCardList } from "../tool-card-list.js"
import { ToolCard } from "./tool-card.js"
import type { CliToolFormState } from "./types.js"
import { emptyTool } from "./types.js"

interface ShortcutsPanelProps {
  readonly shortcuts: CliToolFormState[]
  readonly onChange: (shortcuts: CliToolFormState[]) => void
  readonly toolErrors?: Record<number, Record<string, string>>
}

export function ShortcutsPanel({ shortcuts, onChange, toolErrors }: ShortcutsPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span style={{ fontSize: "var(--text-label)", fontWeight: 500, color: "var(--gray-1000)" }}>
          Shortcuts (saved commands)
        </span>
        <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
          Optional named commands agents can call directly, alongside execute/help. Pin one for a
          command you want locked down to a fixed argv template.
        </p>
      </div>

      {shortcuts.length === 0 && (
        <p style={{ fontSize: "var(--text-caption)", color: "var(--gray-600)" }}>
          No shortcuts yet — agents can still use execute/help to run any command.
        </p>
      )}

      <ToolCardList
        tools={shortcuts}
        onChange={onChange}
        toolErrors={toolErrors}
        makeTool={emptyTool}
        addLabel="Add Shortcut"
        minItems={0}
        renderCard={(props) => <ToolCard key={props.tool.key} {...props} />}
      />
    </div>
  )
}
