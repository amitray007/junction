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
          "transition-opacity duration-[var(--motion-fast)]",
          "data-[state=delayed-open]:opacity-100 data-[state=closed]:opacity-0",
          className,
        )}
        style={{
          backgroundColor: "var(--gray-1000)",
          color: "var(--bg-100)",
          fontSize: "var(--text-caption)",
          boxShadow: "var(--shadow-md)",
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
