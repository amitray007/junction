// SPDX-License-Identifier: AGPL-3.0-only
// StatusRail — the 4px vertical rail down the far-left edge. The signature element.
// Each connected source = one colored segment whose color encodes its state.
// Inc 23: static (no live pulse). Pulse wired in inc 26+ once live-event source exists.
// Reduced-motion: no transforms (already satisfied — it's a static div layout).

import { cn } from "./cn.js"

export type RailSegmentState = "ok" | "warning" | "error" | "info" | "disabled"

export interface RailSegment {
  readonly id: string
  readonly state: RailSegmentState
  /** Short label for screen readers. */
  readonly label: string
}

interface StatusRailProps {
  readonly segments: RailSegment[]
  readonly className?: string
}

const segmentColors: Record<RailSegmentState, string> = {
  ok: "var(--status-ok-fg)",
  info: "var(--status-info-fg)",
  warning: "var(--status-warning-fg)",
  error: "var(--status-error-fg)",
  disabled: "var(--border)",
}

export function StatusRail({ segments, className }: StatusRailProps) {
  return (
    // 4px wide, full height. Position handled by the shell (sticky left edge).
    <ul
      aria-label="Source status rail"
      className={cn("flex flex-col w-1 gap-px list-none m-0 p-0", className)}
    >
      {segments.length === 0 ? (
        // Empty rail — show a single muted segment placeholder
        <li
          aria-hidden="true"
          className="flex-1 min-h-8 rounded-full"
          style={{ backgroundColor: "var(--border)" }}
        />
      ) : (
        segments.map((seg) => (
          <li
            key={seg.id}
            aria-label={`${seg.label}: ${seg.state}`}
            title={`${seg.label}: ${seg.state}`}
            className="flex-1 min-h-4 rounded-full"
            style={{ backgroundColor: segmentColors[seg.state] }}
          />
        ))
      )}
    </ul>
  )
}
