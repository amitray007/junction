// SPDX-License-Identifier: AGPL-3.0-only
// Tooltip — Radix Tooltip with token-driven styles.
// shadow-md for popover elevation (DESIGN.md §Elevation).

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
          "rounded-[var(--radius-6)]",
          "px-2.5 py-1.5",
          // Subtle origin-aware zoom + fade (scales from the trigger, not center).
          "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        style={{
          // Dedicated tooltip tokens — a dark chip in BOTH themes (does NOT invert to a
          // bright/white chip in dark mode, which read as too bright — feedback).
          backgroundColor: "var(--tooltip-bg)",
          color: "var(--tooltip-fg)",
          fontSize: "var(--text-caption)",
          boxShadow: "var(--shadow-md)",
          transformOrigin: "var(--radix-tooltip-content-transform-origin)",
        }}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}

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
