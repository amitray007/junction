// SPDX-License-Identifier: AGPL-3.0-only
// Button primitive — Geist hierarchy, token-driven, cva variants.
// Primary = solid gray-1000 fill (NOT blue). Blue is reserved for state/links/focus.
// Radix Slot used for asChild pattern (polymorphic rendering).
// React 19: ref is a prop — no forwardRef.

import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import type { ButtonHTMLAttributes } from "react"
import { cn } from "./cn.js"

const buttonVariants = cva(
  // Base: 32px control height, no transition:all, transform/opacity safe
  [
    "inline-flex items-center justify-center gap-2",
    "h-[var(--control-height)] px-3",
    "text-[var(--text-label)] font-medium leading-none whitespace-nowrap",
    "rounded-[var(--radius-6)] border",
    "transition-colors duration-[var(--motion-fast)]",
    // Focus ring: blue, 2px surface gap + 2px outline (DESIGN.md)
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue-700)]",
    "disabled:pointer-events-none disabled:opacity-50",
    "select-none cursor-default",
  ],
  {
    variants: {
      variant: {
        // Primary — solid gray-1000 fill / bg-100 text (Geist: not blue)
        primary: [
          "bg-[var(--gray-1000)] text-[var(--bg-100)] border-transparent",
          "hover:opacity-80 active:opacity-70",
        ],
        // Secondary — bg-100 fill + alpha-400 border
        secondary: [
          "bg-[var(--bg-100)] text-[var(--gray-1000)] border-[var(--alpha-400)]",
          "hover:bg-[var(--gray-100)] active:bg-[var(--gray-100)]",
        ],
        // Ghost / tertiary — transparent, gray-1000 text
        ghost: [
          "bg-transparent text-[var(--gray-1000)] border-transparent",
          "hover:bg-[var(--gray-100)]",
        ],
        // Destructive / error — red fill, requires confirm step in usage
        destructive: [
          "bg-[var(--status-error-fg)]/10 text-[var(--status-error-fg)] border-[var(--status-error-fg)]/20",
          "hover:bg-[var(--status-error-fg)]/20",
        ],
      },
      size: {
        sm: "h-[var(--control-height)] px-2 text-[var(--text-caption)]",
        md: "h-[var(--control-height)] px-3",
        lg: "h-[var(--control-height-lg)] px-4",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
)

export type ButtonVariants = VariantProps<typeof buttonVariants>

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button"
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
