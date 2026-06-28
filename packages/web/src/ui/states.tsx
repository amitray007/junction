// SPDX-License-Identifier: AGPL-3.0-only
// Empty / loading / error states — first-class shared components.
// Every route uses these to avoid bespoke one-off states.

import { AlertCircle, Inbox, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "./cn.js"

// ─── Empty state ─────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  readonly icon?: ReactNode
  /** Short label for the empty thing. */
  readonly label: string
  /** Hint text — e.g. CLI command to run. */
  readonly hint?: ReactNode
  readonly className?: string
}

export function EmptyState({ icon, label, hint, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3",
        "py-12 text-center",
        className,
      )}
      role="status"
      aria-label={label}
    >
      <span className="text-[var(--muted)] opacity-40" aria-hidden="true">
        {icon ?? <Inbox className="h-8 w-8" />}
      </span>
      <p className="text-[var(--text-body)] text-[var(--muted)]">{label}</p>
      {hint && <p className="text-[var(--text-eyebrow)] text-[var(--muted)] font-mono">{hint}</p>}
    </div>
  )
}

// ─── Loading state ───────────────────────────────────────────────────────────

export function LoadingState({
  label = "Loading…",
  className,
}: {
  readonly label?: string
  readonly className?: string
}) {
  return (
    <div
      className={cn("flex items-center justify-center gap-2 py-8 text-[var(--muted)]", className)}
      role="status"
      aria-label={label}
    >
      <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
      <span className="text-[var(--text-body)]">{label}</span>
    </div>
  )
}

// ─── Error state ─────────────────────────────────────────────────────────────

export interface ErrorStateProps {
  readonly message?: string
  readonly className?: string
}

export function ErrorState({ message = "Something went wrong.", className }: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        "rounded-[var(--radius-md)] border border-[var(--status-error-fg)]/30",
        "bg-[var(--status-error-bg)] px-4 py-3",
        "text-[var(--text-body)] text-[var(--status-error-fg)]",
        className,
      )}
      role="alert"
    >
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}
