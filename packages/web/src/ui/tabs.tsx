// SPDX-License-Identifier: AGPL-3.0-only
// Tabs — Radix Tabs with token-driven styles and View Transition-ready structure.
// inc-24 scaffolding: no live consumer yet — wired for detail panels in inc 24+.

import * as TabsPrimitive from "@radix-ui/react-tabs"
import type { ComponentPropsWithoutRef } from "react"
import { cn } from "./cn.js"

export const Tabs = TabsPrimitive.Root

export function TabsList({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex items-center gap-1",
        "rounded-[var(--radius-md)] bg-[var(--surface-2)]",
        "p-1",
        className,
      )}
      {...props}
    />
  )
}

export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex items-center justify-center",
        "rounded-[var(--radius-sm)] px-3 py-1",
        "text-[var(--text-body)] font-medium text-[var(--muted)]",
        "transition-all duration-[var(--motion-micro)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        "disabled:pointer-events-none disabled:opacity-50",
        // Active tab: surface card + fg text
        "data-[state=active]:bg-[var(--surface)] data-[state=active]:text-[var(--fg)]",
        "data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn(
        "mt-2",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        className,
      )}
      {...props}
    />
  )
}
