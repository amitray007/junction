// SPDX-License-Identifier: AGPL-3.0-only
// Badge / status pill — implements the DESIGN.md §Status taxonomy.
// Status = color dot + text (WCAG AA; never color-only).
// Tokens: --status-*-fg named pairs from app.css.
// Variants: configured / ok / no-auth / warning / error / off.

import { cva, type VariantProps } from "class-variance-authority"
import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5",
    "px-2 py-0.5",
    "rounded-[var(--radius-full)]",
    "text-[var(--text-caption)] font-medium",
    "leading-none whitespace-nowrap",
  ],
  {
    variants: {
      variant: {
        // configured: stored, not live-probed (inc 23–27 default)
        configured: ["bg-[var(--gray-100)] text-[var(--status-configured-fg)]"],
        // ok / connected: live (reserved, probe inc 28+)
        ok: ["bg-[var(--status-ok-fg)]/10 text-[var(--status-ok-fg)]"],
        // no-auth: public source, blue signal
        noauth: ["bg-[var(--blue-bg)] text-[var(--status-noauth-fg)]"],
        // warning / expiring
        warning: ["bg-[var(--status-warning-fg)]/10 text-[var(--status-warning-fg)]"],
        // error / auth-failed
        error: ["bg-[var(--status-error-fg)]/10 text-[var(--status-error-fg)]"],
        // off / disabled: route toggled off
        off: ["bg-[var(--gray-100)] text-[var(--status-off-fg)]"],
      },
    },
    defaultVariants: {
      variant: "configured",
    },
  },
)

// Dot color keyed by variant — reads named status token.
const dotColors: Record<string, string> = {
  configured: "var(--status-configured-fg)",
  ok: "var(--status-ok-fg)",
  noauth: "var(--status-noauth-fg)",
  warning: "var(--status-warning-fg)",
  error: "var(--status-error-fg)",
  off: "var(--status-off-fg)",
}

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  readonly children: React.ReactNode
}

export function Badge({ className, variant = "configured", children, ...props }: BadgeProps) {
  const dotColor = dotColors[variant ?? "configured"] ?? dotColors.configured
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {/* Color dot — a11y: paired with text label, never color-only */}
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "var(--status-dot)",
          height: "var(--status-dot)",
          borderRadius: "var(--radius-full)",
          backgroundColor: dotColor,
          flexShrink: 0,
        }}
      />
      {children}
    </span>
  )
}

// ─── StatusBadge taxonomy (DESIGN.md §Status mapping) ────────────────────

// "configured" = credential stored but no live health probe yet (probe lands inc 28).
// "connected" is reserved for when we can assert credential valid + source live.
// "disabled" / "off" = profile source toggled off · route disabled.
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
    "no-auth": { variant: "noauth" as const, label: "No Auth" },
    expiring: { variant: "warning" as const, label: "Expiring" },
    "auth-failed": { variant: "error" as const, label: "Auth Failed" },
    disabled: { variant: "off" as const, label: "Disabled" },
  } as const

  const { variant, label } = map[status]
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  )
}
