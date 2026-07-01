// SPDX-License-Identifier: AGPL-3.0-only
// Dialog — Radix Dialog with token-driven styles.
// shadow-md for popover/modal elevation (DESIGN.md §Elevation).
// No backdrop-blur — solid scrim, no glassmorphism (anti-slop rule).

import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import type { ComponentPropsWithoutRef } from "react"
import { Button } from "./button.js"
import { cn } from "./cn.js"

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

// True when the event target is inside a Radix popper/select portal (rendered OUTSIDE the
// dialog DOM). Used to stop a Select-option click from being treated as an outside-click
// that closes the dialog. Exported for unit testing the guard logic.
export function isInsideRadixPopper(target: Element | null): boolean {
  return Boolean(
    target?.closest("[data-radix-popper-content-wrapper]") ||
      target?.closest("[role='listbox']") ||
      target?.closest("[data-radix-select-content]"),
  )
}

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
  onPointerDownOutside,
  onInteractOutside,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          "w-full max-w-lg",
          // Bounded height + internal scroll: a tall form (e.g. the CLI guided form
          // with several tool cards) must not grow past the viewport — an
          // unbounded DialogContent pushes its top above y=0, and a control near
          // the bottom then sits outside the dialog's actual clickable/visible
          // area (a real click there can land on the overlay behind it and close
          // the dialog). max-h-[85vh] + overflow-y-auto keeps the whole dialog,
          // including its footer, reachable regardless of content length.
          "max-h-[85vh] overflow-y-auto",
          "rounded-[var(--radius-12)] border border-[var(--alpha-400)]",
          "bg-[var(--bg-100)]",
          "p-6",
          // Fade + subtle scale-in. A modal is NOT anchored to a trigger, so it keeps
          // center origin (the -translate-1/2 centering composes with the zoom utility).
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        style={{ boxShadow: "var(--shadow-md)" }}
        onPointerDownOutside={(e) => {
          // Radix Select portals its listbox outside the dialog DOM — clicking a Select
          // option fires this and would wrongly close the dialog. Keep it open for clicks
          // inside a Radix popper/select portal; genuine outside clicks (scrim) still close.
          if (isInsideRadixPopper(e.target as Element | null)) {
            e.preventDefault()
            return
          }
          onPointerDownOutside?.(e)
        }}
        onInteractOutside={(e) => {
          if (isInsideRadixPopper(e.target as Element | null)) {
            e.preventDefault()
            return
          }
          onInteractOutside?.(e)
        }}
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

/**
 * The standard form-dialog footer: a secondary Cancel + a primary submit button whose
 * label flips while submitting. Every form dialog (Add Credential, Create Profile,
 * Add Route, …) repeats this; share it so they stay consistent.
 */
export function DialogFormFooter({
  onCancel,
  submitting,
  submitLabel,
  submittingLabel,
  cancelLabel = "Cancel",
}: {
  readonly onCancel: () => void
  readonly submitting: boolean
  readonly submitLabel: string
  readonly submittingLabel: string
  readonly cancelLabel?: string
}) {
  return (
    <DialogFooter>
      <Button type="button" variant="secondary" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting ? submittingLabel : submitLabel}
      </Button>
    </DialogFooter>
  )
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
