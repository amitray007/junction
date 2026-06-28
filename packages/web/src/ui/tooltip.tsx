// SPDX-License-Identifier: AGPL-3.0-only
// Tooltip — Radix Tooltip with token-driven styles.

import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { cn } from "./cn.js"

export const TooltipProvider = TooltipPrimitive.Provider

type TooltipContentProps = ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>

export function TooltipContent({ className, sideOffset = 4, ...props }: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden",
          "rounded-[var(--radius-sm)]",
          "bg-[var(--fg)] text-[var(--bg)]",
          "px-2 py-1",
          "text-[var(--text-eyebrow)] leading-snug",
          // Entry/exit opacity — simple CSS transition, no animate-in plugin needed.
          "transition-opacity duration-[var(--motion-short)]",
          "data-[state=delayed-open]:opacity-100 data-[state=closed]:opacity-0",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

// Compound helper for simple text tooltips.
export function Tooltip({
  children,
  content,
  delayDuration = 400,
}: {
  readonly children: ReactNode
  readonly content: ReactNode
  readonly delayDuration?: number
}) {
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipContent>{content}</TooltipContent>
    </TooltipPrimitive.Root>
  )
}
