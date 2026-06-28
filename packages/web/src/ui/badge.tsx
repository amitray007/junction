// SPDX-License-Identifier: AGPL-3.0-only
// Badge / status pill — implements the DESIGN.md badge taxonomy exactly.
// Status = color + dot + text (WCAG AA; never color-only).
// Variants map to six canonical states: ok, info, warning, error, disabled, configured.

import { cva, type VariantProps } from "class-variance-authority"
import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5",
    "px-2 py-0.5",
    "rounded-[var(--radius-sm)]",
    "text-[var(--text-eyebrow)] font-medium uppercase tracking-[0.08em]",
    "border",
    "leading-none whitespace-nowrap",
  ],
  {
    variants: {
      variant: {
        ok: [
          "bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)]",
          "border-[var(--status-ok-fg)]/20",
        ],
        info: [
          "bg-[var(--status-info-bg)] text-[var(--status-info-fg)]",
          "border-[var(--status-info-fg)]/20",
        ],
        warning: [
          "bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)]",
          "border-[var(--status-warning-fg)]/20",
        ],
        error: [
          "bg-[var(--status-error-bg)] text-[var(--status-error-fg)]",
          "border-[var(--status-error-fg)]/20",
        ],
        disabled: [
          "bg-[var(--surface-2)] text-[var(--status-disabled-fg)]",
          "border-[var(--border)]",
        ],
        // configured: neutral — credential stored but not live-probed (probe lands inc 28).
        // Uses --muted text on --surface-2 bg to signal "present, not validated."
        configured: ["bg-[var(--surface-2)] text-[var(--muted)]", "border-[var(--border)]"],
      },
    },
    defaultVariants: {
      variant: "ok",
    },
  },
)

// Dot colors keyed by variant — same token source.
const dotColors: Record<string, string> = {
  ok: "var(--status-ok-fg)",
  info: "var(--status-info-fg)",
  warning: "var(--status-warning-fg)",
  error: "var(--status-error-fg)",
  disabled: "var(--status-disabled-fg)",
  configured: "var(--muted)",
}

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Badge label text rendered as a slot; also used for aria if no aria-label given. */
  readonly children: React.ReactNode
}

export function Badge({ className, variant = "ok", children, ...props }: BadgeProps) {
  const dotColor = dotColors[variant ?? "ok"] ?? dotColors.ok
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {/* Color dot — a11y: paired with text below, never color-only */}
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "var(--space-dot)",
          height: "var(--space-dot)",
          borderRadius: "9999px",
          backgroundColor: dotColor,
          flexShrink: 0,
        }}
      />
      {children}
    </span>
  )
}

// ─── Status badge taxonomy (DESIGN.md mapping) ────────────────────────────

// "configured" = credential stored but no live health probe yet (probe lands inc 28).
// "connected" is reserved for when we can assert credential valid + source live.
// "disabled" = profile source toggled off · credential unused.
// "no-auth", "expiring", "auth-failed" stay for future live-probe results.
export function StatusBadge({
  status,
  className,
}: {
  readonly status: "connected" | "configured" | "no-auth" | "expiring" | "auth-failed" | "disabled"
  readonly className?: string
}) {
  const map = {
    connected: { variant: "ok" as const, label: "Connected" },
    configured: { variant: "configured" as const, label: "Configured" },
    "no-auth": { variant: "info" as const, label: "No Auth" },
    expiring: { variant: "warning" as const, label: "Expiring" },
    "auth-failed": { variant: "error" as const, label: "Auth Failed" },
    disabled: { variant: "disabled" as const, label: "Disabled" },
  } as const

  const { variant, label } = map[status]
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  )
}
