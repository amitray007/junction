// SPDX-License-Identifier: AGPL-3.0-only
// Checkbox — Radix UI Checkbox wrapped in tokens.
// Focus ring: blue (DESIGN.md). Checked fill: gray-1000.

import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check } from "lucide-react"
import type { ComponentPropsWithoutRef } from "react"
import { cn } from "./cn.js"

export function Checkbox({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer h-4 w-4 shrink-0",
        "rounded-[var(--radius-6)] border border-[var(--alpha-400)]",
        "transition-colors duration-[var(--motion-fast)]",
        "outline-none transition-shadow duration-[var(--motion-fast)]",
        "focus-visible:shadow-[0_0_0_3px_var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-[var(--gray-1000)] data-[state=checked]:border-[var(--gray-1000)]",
        "data-[state=unchecked]:bg-[var(--bg-100)]",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check
          className="h-3 w-3"
          aria-hidden="true"
          style={{ color: "var(--bg-100)", strokeWidth: 3 }}
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
