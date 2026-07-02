// SPDX-License-Identifier: AGPL-3.0-only
// Badge / status pill — implements the DESIGN.md §Status taxonomy.
// B4: tinted bg (color-mix 12%), 1px border (color-mix 30%), fixed ~20px height,
// baseline-centered dot+label. Never color-only (WCAG AA).
// Tokens: --status-*-fg named pairs from app.css. color-mix already used in states.tsx.
// Variants: configured / ok / noauth / warning / error / off (status badges)
//           neutral (count chip next to page title — distinct from status signal).

import { cva, type VariantProps } from "class-variance-authority"
import type { HTMLAttributes } from "react"
import { cn } from "./cn.js"

const badgeVariants = cva(
  // Geometry + type match the design-system reference exactly (preview.html .badge):
  // 20px tall, 0 8px padding, 5px gap, small radius (chip, not a full pill), Geist Mono
  // 11px with .03em tracking, 1px border. Mapped to OUR status tokens.
  [
    "inline-flex items-center gap-[5px]",
    "h-5 px-2",
    "rounded-[var(--radius-6)]",
    "font-mono text-[11px] tracking-[0.03em]",
    "leading-none whitespace-nowrap",
    "border border-transparent",
  ],
  {
    variants: {
      // Each status variant: text = the status fg, bg = a 12% tint of it, border = a 30%
      // tint (reference .b-* pattern: color/background/border-color from one hue).
      variant: {
        // configured: stored, not live-probed (inc 23–27 default)
        configured: [
          "text-[var(--status-configured-fg)]",
          "[background-color:color-mix(in_srgb,var(--status-configured-fg)_12%,transparent)]",
          "[border-color:color-mix(in_srgb,var(--status-configured-fg)_30%,transparent)]",
        ],
        // ok / connected: live (reserved, probe inc 28+)
        ok: [
          "text-[var(--status-ok-fg)]",
          "[background-color:color-mix(in_srgb,var(--status-ok-fg)_12%,transparent)]",
          "[border-color:color-mix(in_srgb,var(--status-ok-fg)_30%,transparent)]",
        ],
        // no-auth: public source, blue signal
        noauth: [
          "text-[var(--status-noauth-fg)]",
          "[background-color:color-mix(in_srgb,var(--status-noauth-fg)_12%,transparent)]",
          "[border-color:color-mix(in_srgb,var(--status-noauth-fg)_30%,transparent)]",
        ],
        // warning / expiring
        warning: [
          "text-[var(--status-warning-fg)]",
          "[background-color:color-mix(in_srgb,var(--status-warning-fg)_12%,transparent)]",
          "[border-color:color-mix(in_srgb,var(--status-warning-fg)_30%,transparent)]",
        ],
        // error / auth-failed
        error: [
          "text-[var(--status-error-fg)]",
          "[background-color:color-mix(in_srgb,var(--status-error-fg)_12%,transparent)]",
          "[border-color:color-mix(in_srgb,var(--status-error-fg)_30%,transparent)]",
        ],
        // off / disabled: route toggled off — reference .b-dis: transparent bg + a plain
        // neutral border (no tint), so it visibly reads as "inactive".
        off: ["text-[var(--status-off-fg)]", "bg-transparent", "border-[var(--alpha-400)]"],
        // neutral: count chip next to page title — quiet gray, NOT a status signal.
        neutral: ["text-[var(--gray-700)]", "bg-[var(--gray-100)]", "border-[var(--alpha-400)]"],
      },
    },
    defaultVariants: {
      variant: "configured",
    },
  },
)

// Dot color keyed by variant — reads named status token.
// neutral variant has no status dot (it's a count, not a state signal).
const dotColors: Record<string, string | null> = {
  configured: "var(--status-configured-fg)",
  ok: "var(--status-ok-fg)",
  noauth: "var(--status-noauth-fg)",
  warning: "var(--status-warning-fg)",
  error: "var(--status-error-fg)",
  off: "var(--status-off-fg)",
  neutral: null,
}

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  readonly children: React.ReactNode
}

export function Badge({ className, variant = "configured", children, ...props }: BadgeProps) {
  const dotColor = dotColors[variant ?? "configured"] ?? null
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {/* Color dot — a11y: paired with text label, never color-only. Omitted for neutral (count chip). */}
      {dotColor !== null && (
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
      )}
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
  readonly status:
    | "connected"
    | "configured"
    | "no-auth"
    | "expiring"
    | "auth-failed"
    | "disabled"
    | "active"
    | "revoked"
  readonly className?: string
}) {
  const map = {
    connected: { variant: "ok" as const, label: "Connected" },
    configured: { variant: "configured" as const, label: "Configured" },
    "no-auth": { variant: "noauth" as const, label: "No Auth" },
    expiring: { variant: "warning" as const, label: "Expiring" },
    "auth-failed": { variant: "error" as const, label: "Auth Failed" },
    disabled: { variant: "off" as const, label: "Disabled" },
    // API-key lifecycle (inc 27) — an active key is NOT liveness-probed, so it
    // gets its own honest label rather than reusing "Connected".
    active: { variant: "ok" as const, label: "Active" },
    revoked: { variant: "off" as const, label: "Revoked" },
  } as const

  const { variant, label } = map[status]
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  )
}
