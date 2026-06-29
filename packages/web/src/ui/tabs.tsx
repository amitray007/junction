// SPDX-License-Identifier: AGPL-3.0-only
// Tabs — Radix Tabs with token-driven styles.
// Used by AgentConfig for the tabbed config illustration.

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
        "inline-flex items-center gap-0.5",
        "rounded-[var(--radius-6)] bg-[var(--gray-100)]",
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
        "rounded-[var(--radius-6)] px-3 py-1",
        "font-medium",
        "transition-colors duration-[var(--motion-fast)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue-700)]",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[state=active]:bg-[var(--bg-100)] data-[state=active]:text-[var(--gray-1000)]",
        "data-[state=inactive]:text-[var(--gray-700)]",
        className,
      )}
      style={{ fontSize: "var(--text-label)" }}
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
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue-700)]",
        className,
      )}
      {...props}
    />
  )
}
