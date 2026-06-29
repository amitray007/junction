// SPDX-License-Identifier: AGPL-3.0-only
// Empty / loading / error states — first-class shared components.
// Empty = one plain line + the first action (DESIGN.md §Components).

import { AlertCircle, Inbox, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "./cn.js"

// ─── Empty state ─────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  readonly icon?: ReactNode
  readonly label: string
  readonly hint?: ReactNode
  readonly className?: string
}

export function EmptyState({ icon, label, hint, className }: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-start gap-2 py-8", className)}
      role="status"
      aria-label={label}
    >
      <span style={{ color: "var(--gray-600)" }} aria-hidden="true">
        {icon ?? <Inbox className="h-5 w-5" />}
      </span>
      <p style={{ fontSize: "var(--text-body)", color: "var(--gray-900)", margin: 0 }}>{label}</p>
      {hint && (
        <p style={{ fontSize: "var(--text-body)", color: "var(--gray-700)", margin: 0 }}>{hint}</p>
      )}
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
      className={cn("flex items-center gap-2 py-8", className)}
      role="status"
      aria-label={label}
      style={{ color: "var(--gray-700)" }}
    >
      <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
      <span style={{ fontSize: "var(--text-body)" }}>{label}</span>
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
        "rounded-[var(--radius-6)] border",
        "px-4 py-3",
        className,
      )}
      style={{
        borderColor: "color-mix(in srgb, var(--status-error-fg) 30%, transparent)",
        backgroundColor: "color-mix(in srgb, var(--status-error-fg) 8%, transparent)",
        color: "var(--status-error-fg)",
        fontSize: "var(--text-body)",
      }}
      role="alert"
    >
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}
