// SPDX-License-Identifier: AGPL-3.0-only
// Dialog — Radix Dialog with token-driven styles. Used for desktop modals.
// On narrow/mobile use vaul drawer instead (deferred to a future increment).
// inc-24 scaffolding: no live consumer yet — wired for mutation forms in inc 24+.

import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import type { ComponentPropsWithoutRef } from "react"
import { cn } from "./cn.js"

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

export function DialogOverlay({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        // Solid scrim — no backdrop-blur. DESIGN.md: depth = 1px borders, not blur/shadows.
        "fixed inset-0 z-50 bg-black/50",
        "transition-opacity duration-[var(--motion-short)]",
        "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
        className,
      )}
      {...props}
    />
  )
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          "w-full max-w-lg",
          "rounded-[var(--radius-lg)] border border-[var(--border)]",
          "bg-[var(--surface)]",
          "p-6",
          "transition-opacity duration-[var(--motion-medium)]",
          "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className={cn(
            "absolute right-4 top-4",
            "rounded-[var(--radius-sm)] p-1",
            "text-[var(--muted)] hover:text-[var(--fg)]",
            "transition-colors duration-[var(--motion-micro)]",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          )}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 mb-4", className)} {...props} />
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex justify-end gap-2 mt-6", className)} {...props} />
}

export function DialogTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-[var(--text-section)] font-semibold text-[var(--fg)]", className)}
      {...props}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-[var(--text-body)] text-[var(--muted)]", className)}
      {...props}
    />
  )
}
