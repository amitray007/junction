// SPDX-License-Identifier: AGPL-3.0-only
// Switch — Radix UI Switch wrapped in tokens.
// Focus ring: blue. Checked: gray-1000 track.

import * as SwitchPrimitive from "@radix-ui/react-switch"
import type { ComponentPropsWithoutRef } from "react"
import { cn } from "./cn.js"

export function Switch({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center",
        "rounded-full border-2 border-transparent",
        "transition-colors duration-[var(--motion-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-700)] focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-[var(--gray-1000)]",
        "data-[state=unchecked]:bg-[var(--gray-400)]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full",
          "transition-transform duration-[var(--motion-fast)]",
          "data-[state=checked]:translate-x-4",
          "data-[state=unchecked]:translate-x-0",
        )}
        style={{ backgroundColor: "var(--bg-100)", boxShadow: "var(--shadow-sm)" }}
      />
    </SwitchPrimitive.Root>
  )
}
