// SPDX-License-Identifier: AGPL-3.0-only
// Switch — Radix UI Switch wrapped in tokens.
// Built inc 23; NOT wired to write paths (inc 24+).
// Radix handles keyboard (Space to toggle), focus management, ARIA role="switch".

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
        "transition-colors duration-[var(--motion-short)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-[var(--accent-fill)]",
        "data-[state=unchecked]:bg-[var(--surface-2)]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full shadow-sm",
          "transition-transform duration-[var(--motion-short)]",
          "data-[state=checked]:translate-x-4",
          "data-[state=unchecked]:translate-x-0",
        )}
        style={{ backgroundColor: "var(--accent-fg)" }}
      />
    </SwitchPrimitive.Root>
  )
}
