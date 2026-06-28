// SPDX-License-Identifier: AGPL-3.0-only
// Checkbox — Radix UI Checkbox wrapped in tokens.
// Built inc 23; NOT wired to write paths (inc 24+).
// Radix handles keyboard (Space to toggle), focus management, ARIA role="checkbox".

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
        "rounded-[var(--radius-sm)] border border-[var(--border)]",
        "transition-colors duration-[var(--motion-micro)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-[var(--accent-fill)] data-[state=checked]:border-[var(--accent-fill)]",
        "data-[state=unchecked]:bg-[var(--bg)]",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check
          className="h-3 w-3"
          aria-hidden="true"
          style={{ color: "var(--accent-fg)", strokeWidth: 3 }}
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
