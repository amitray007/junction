// SPDX-License-Identifier: AGPL-3.0-only
// Separator — hairline 1px divider using alpha-200 (Geist: faint alpha divider).

import * as SeparatorPrimitive from "@radix-ui/react-separator"
import type { ComponentPropsWithoutRef } from "react"
import { cn } from "./cn.js"

type SeparatorProps = ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>

export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        "bg-[var(--alpha-200)] shrink-0",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  )
}
