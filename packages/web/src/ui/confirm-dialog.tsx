// SPDX-License-Identifier: AGPL-3.0-only
// Shared presentational ConfirmDialog — owns the submitting state, open/close reset,
// and the footer (Cancel + destructive button). The caller supplies onConfirm which
// performs the mutation and returns true on success (so the dialog closes) or false
// on failure (so it stays open; the caller is responsible for showing a toast).
// Policy (what happens after success) stays in the route — do NOT fold it here.

import { useState } from "react"
import { Button } from "./button.js"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog.js"

export interface ConfirmDialogProps {
  readonly open: boolean
  readonly title: string
  readonly description: React.ReactNode
  readonly confirmLabel: string
  readonly confirmingLabel: string
  readonly variant?: "destructive" | "primary"
  /** Perform the mutation. Return true on success (dialog closes); false to stay open. */
  readonly onConfirm: () => Promise<boolean>
  readonly onOpenChange: (open: boolean) => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmingLabel,
  variant = "destructive",
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false)

  function handleOpenChange(next: boolean) {
    if (!next) setSubmitting(false)
    onOpenChange(next)
  }

  async function handleConfirm() {
    setSubmitting(true)
    const success = await onConfirm()
    if (!success) {
      setSubmitting(false)
      return
    }
    // onConfirm returned true → close the dialog (the caller handles toast/invalidate).
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant={variant} disabled={submitting} onClick={handleConfirm}>
            {submitting ? confirmingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
