// SPDX-License-Identifier: AGPL-3.0-only
// ToolCardList — renders a keyed list of tool cards + an "Add" button, wiring
// each card's expand/update/remove callbacks against the parent's array via
// use-keyed-list's pure helpers. Shared by cli-form's CliConnectionForm and
// http-form's HttpConnectionForm: both render a list of `{key, ...}` tool
// items through a card component with the identical
// {tool,index,expanded,onToggle,onChange,onRemove,canRemove,errors} contract —
// the list-wiring is genuinely identical; only the card component and the
// empty-item factory differ per caller.

import { Plus } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "../../ui/index.js"
import type { KeyedItem } from "./use-keyed-list.js"
import { removeKeyed, updateKeyed, useAccordionExpansion } from "./use-keyed-list.js"

export interface ToolCardComponentProps<T> {
  readonly tool: T
  readonly index: number
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onChange: (tool: T) => void
  readonly onRemove: () => void
  readonly canRemove: boolean
  readonly errors?: Record<string, string>
}

export interface ToolCardListProps<T extends KeyedItem> {
  readonly tools: T[]
  readonly onChange: (tools: T[]) => void
  readonly toolErrors?: Record<number, Record<string, string>>
  readonly makeTool: () => T
  readonly addLabel: string
  readonly renderCard: (props: ToolCardComponentProps<T>) => ReactNode
}

export function ToolCardList<T extends KeyedItem>({
  tools,
  onChange,
  toolErrors,
  makeTool,
  addLabel,
  renderCard,
}: ToolCardListProps<T>) {
  const accordion = useAccordionExpansion(tools[0]?.key)

  function addTool() {
    const tool = makeTool()
    onChange([...tools, tool])
    accordion.expand(tool.key)
  }

  return (
    <>
      {tools.map((tool, i) =>
        renderCard({
          tool,
          index: i,
          expanded: accordion.expandedKey === tool.key,
          onToggle: () => accordion.toggle(tool.key),
          onChange: (next) => onChange(updateKeyed(tools, tool.key, next)),
          onRemove: () => onChange(removeKeyed(tools, tool.key)),
          canRemove: tools.length > 1,
          errors: toolErrors?.[i],
        }),
      )}

      <Button type="button" variant="secondary" size="sm" className="self-start" onClick={addTool}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {addLabel}
      </Button>
    </>
  )
}
