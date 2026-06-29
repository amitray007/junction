// SPDX-License-Identifier: AGPL-3.0-only
// Dialog — Radix Dialog with token-driven styles.
// shadow-md for popover/modal elevation (DESIGN.md §Elevation).
// No backdrop-blur — solid scrim, no glassmorphism (anti-slop rule).

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
        // Solid scrim — no backdrop-blur (DESIGN.md anti-slop: no glassmorphism)
        "fixed inset-0 z-50 bg-black/50",
        "transition-opacity duration-[var(--motion-fast)]",
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
          "rounded-[var(--radius-12)] border border-[var(--alpha-400)]",
          "bg-[var(--bg-100)]",
          "p-6",
          "transition-opacity duration-[var(--motion-base)]",
          "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
          className,
        )}
        style={{ boxShadow: "var(--shadow-md)" }}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className={cn(
            "absolute right-4 top-4",
            "rounded-[var(--radius-6)] p-1",
            "transition-colors duration-[var(--motion-fast)]",
            "hover:bg-[var(--gray-100)]",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue-700)]",
          )}
          style={{ color: "var(--gray-700)" }}
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
      className={cn("font-semibold leading-none", className)}
      style={{ fontSize: "var(--text-h2)", color: "var(--gray-1000)" }}
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
      className={cn("", className)}
      style={{ fontSize: "var(--text-body)", color: "var(--gray-900)" }}
      {...props}
    />
  )
}
