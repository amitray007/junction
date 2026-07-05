// SPDX-License-Identifier: AGPL-3.0-only
// ToolCardShell — the accordion card chrome shared by cli-form's ToolCard and
// http-form's HttpToolCard: a header (chevron + name + mono summary) that
// toggles an expanded body, whose body always opens with a "Tool N / Remove
// Tool" row before the kind-specific fields. Two consumers, identical shell,
// differing only in the fields inside the body and the disabled-remove tooltip
// copy — rule-of-three-honest extraction of the chrome, not the content.

import { ChevronDown, ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { Card } from "../../ui/index.js"

export interface ToolCardShellProps {
  readonly name: string
  readonly index: number
  readonly summary: ReactNode
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onRemove: () => void
  readonly canRemove: boolean
  /** Tooltip shown on the disabled Remove button — names the platform kind's minimum-tools rule. */
  readonly removeDisabledTitle: string
  readonly children: ReactNode
}

export function ToolCardShell({
  name,
  index,
  summary,
  expanded,
  onToggle,
  onRemove,
  canRemove,
  removeDisabledTitle,
  children,
}: ToolCardShellProps) {
  return (
    <Card className="p-0">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown
              className="h-4 w-4"
              aria-hidden="true"
              style={{ color: "var(--gray-700)" }}
            />
          ) : (
            <ChevronRight
              className="h-4 w-4"
              aria-hidden="true"
              style={{ color: "var(--gray-700)" }}
            />
          )}
          <span style={{ fontSize: "var(--text-h3)", fontWeight: 600, color: "var(--gray-1000)" }}>
            {name.trim() || `Tool ${index + 1}`}
          </span>
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-mono)",
            color: "var(--gray-700)",
          }}
        >
          {summary}
        </span>
      </button>

      {expanded && (
        <div
          className="flex flex-col gap-4 border-t px-4 py-4"
          style={{ borderColor: "var(--alpha-200)" }}
        >
          <div className="flex items-center justify-between">
            <span style={{ fontSize: "var(--text-caption)", color: "var(--gray-700)" }}>
              Tool {index + 1}
            </span>
            <button
              type="button"
              disabled={!canRemove}
              onClick={onRemove}
              title={canRemove ? "Remove this tool" : removeDisabledTitle}
              style={{
                fontSize: "var(--text-caption)",
                color: canRemove ? "var(--status-error-fg)" : "var(--gray-700)",
                opacity: canRemove ? 1 : 0.5,
              }}
            >
              Remove Tool
            </button>
          </div>

          {children}
        </div>
      )}
    </Card>
  )
}
