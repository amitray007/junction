// SPDX-License-Identifier: AGPL-3.0-only
// Button primitive — token-driven, cva variants.
// Radix Slot used for asChild pattern (polymorphic rendering).

import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import type { ButtonHTMLAttributes } from "react"
import { cn } from "./cn.js"

const buttonVariants = cva(
  // Base: 32px control height, transitions gated on motion-micro
  [
    "inline-flex items-center justify-center gap-2",
    "h-[var(--control-height)] px-3",
    "text-[var(--text-body)] font-medium leading-none whitespace-nowrap",
    "rounded-[var(--radius-md)] border",
    "transition-colors duration-[var(--motion-micro)]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
    "disabled:pointer-events-none disabled:opacity-50",
    "select-none cursor-default",
  ],
  {
    variants: {
      variant: {
        // Primary — amber fill (the one accent action)
        primary: [
          "bg-[var(--accent-fill)] text-[var(--accent-fg)] border-transparent",
          "hover:bg-[var(--accent)] active:bg-[var(--accent)]",
        ],
        // Secondary — surface with border
        secondary: [
          "bg-[var(--surface)] text-[var(--fg)] border-[var(--border)]",
          "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]",
        ],
        // Ghost — no fill, no border until hover
        ghost: [
          "bg-transparent text-[var(--muted)] border-transparent",
          "hover:bg-[var(--surface-2)] hover:text-[var(--fg)]",
        ],
        // Destructive — red tint
        destructive: [
          "bg-[var(--status-error-bg)] text-[var(--status-error-fg)] border-[var(--border)]",
          "hover:border-[var(--status-error-fg)]",
        ],
      },
      size: {
        sm: "h-7 px-2 text-[var(--text-eyebrow)]",
        md: "h-[var(--control-height)] px-3",
        lg: "h-9 px-4",
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
