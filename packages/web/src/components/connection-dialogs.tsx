// SPDX-License-Identifier: AGPL-3.0-only
// Shared credential-lifecycle dialogs (rotate secret / edit account label /
// disconnect) — extracted from credentials.tsx and app.$id.tsx (inc 30), which
// had near-identical copies (rule of three: both routes render the same
// rotate/rename/disconnect flow against a credential, just addressed by a
// CredentialMeta vs a ConnectionMeta). Both call sites map their own record
// to the minimal `ConnectionTarget` shape these dialogs need.
//
// No @junction/core import. Only the *.functions.js mutation fns + ui
// primitives — same server-only boundary as the routes that use them.

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  removeCredentialFn,
  renameCredentialFn,
  rotateCredentialFn,
} from "../server/mutations.functions.js"
import { MonoCode } from "../ui/code.js"
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFormFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "../ui/index.js"

// ---------------------------------------------------------------------------
// Shared target shape — the minimal fields any of these dialogs need,
// regardless of whether the caller holds a CredentialMeta or a ConnectionMeta.
// ---------------------------------------------------------------------------

export interface ConnectionTarget {
  readonly credentialId: string
  readonly account: string
  /**
   * Optional platform id — credentials.tsx has platform context to show
   * (`<MonoCode>{platformId}</MonoCode>` in the original copy); app.$id.tsx
   * is already scoped to one app, so it never sets this and the dialogs fall
   * back to platform-agnostic wording. Purely a display detail — never sent
   * to a mutation fn.
   */
  readonly platformId?: string
}

interface ConnectionDialogProps {
  readonly target: ConnectionTarget | null
  readonly onOpenChange: (open: boolean) => void
  readonly onSuccess: () => void
}

// ---------------------------------------------------------------------------
// Rotate secret dialog (non-OAuth credentials only).
// ---------------------------------------------------------------------------

export function RotateSecretDialog({ target, onOpenChange, onSuccess }: ConnectionDialogProps) {
  const [newSecret, setNewSecret] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setNewSecret("")
    setError(undefined)
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!newSecret) {
      setError("New secret is required")
      return
    }
    if (!target) return
    setSubmitting(true)
    try {
      const result = await rotateCredentialFn({
        data: { credentialId: target.credentialId, newSecret },
      })
      if (!result.ok) {
        toast.error(`Failed to rotate credential: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Credential rotated")
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to rotate credential")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate Credential</DialogTitle>
          <DialogDescription>
            Enter a new secret for <MonoCode>{target?.account}</MonoCode>
            {target?.platformId !== undefined && (
              <>
                {" "}
                on <MonoCode>{target.platformId}</MonoCode>
              </>
            )}
            . The old secret is deleted from the store on success.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="rotate-secret" label="New secret" error={error}>
              <Input
                id="rotate-secret"
                type="password"
                autoComplete="new-password"
                value={newSecret}
                onChange={(e) => setNewSecret(e.target.value)}
                hasError={!!error}
                aria-required="true"
                placeholder="Paste new secret here"
              />
            </Field>
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Rotate Secret"
            submittingLabel="Rotating…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Edit account label dialog — rename the account LABEL in place. The ONLY
// editable metadata: the secret stays rotate-only, and client_id is a
// reconnect concern. Pre-fills the current account; submits the trimmed new
// label.
// ---------------------------------------------------------------------------

export function EditAccountLabelDialog({ target, onOpenChange, onSuccess }: ConnectionDialogProps) {
  const [account, setAccount] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  // Pre-fill with the current account when the dialog opens for a target.
  // Keyed off the credential ID (not the object) so a same-id re-render with a
  // fresh object reference can't clobber an in-progress edit.
  const editingId = target?.credentialId
  const editingAccount = target?.account
  useEffect(() => {
    if (editingId !== undefined) {
      setAccount(editingAccount ?? "")
      setError(undefined)
      setSubmitting(false)
    }
  }, [editingId, editingAccount])

  function handleOpenChange(next: boolean) {
    if (!next) {
      setAccount("")
      setError(undefined)
      setSubmitting(false)
    }
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!account.trim()) {
      setError("Account label is required")
      return
    }
    if (!target) return
    setSubmitting(true)
    try {
      const result = await renameCredentialFn({
        data: { credentialId: target.credentialId, account: account.trim() },
      })
      if (!result.ok) {
        toast.error(`Failed to rename: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Account label updated")
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to rename")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit account label</DialogTitle>
          <DialogDescription>
            {target?.platformId !== undefined ? (
              <>
                Rename the account label for this credential on{" "}
                <MonoCode>{target.platformId}</MonoCode>.{" "}
              </>
            ) : (
              "Rename the account label for this connection. "
            )}
            This is a display label only — the secret and connection are unchanged.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="edit-account" label="Account label" error={error}>
              <Input
                id="edit-account"
                autoComplete="off"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                hasError={!!error}
                aria-required="true"
              />
            </Field>
          </div>
          <DialogFormFooter
            onCancel={() => handleOpenChange(false)}
            submitting={submitting}
            submitLabel="Save"
            submittingLabel="Saving…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Disconnect / delete confirmation dialog — uses shared ConfirmDialog.
//
// `copy` picks the exact wording each route already shipped: credentials.tsx
// ("delete", the reviewed original — mentions the platform) vs app.$id.tsx
// ("disconnect", the default — already scoped to one app, no platform
// context needed). Same mutation (removeCredentialFn) either way; only the
// user-facing strings differ, so this is the parametrization rather than
// forcing one route's copy onto the other.
// ---------------------------------------------------------------------------

interface DisconnectDialogProps extends ConnectionDialogProps {
  readonly copy?: "disconnect" | "delete"
}

export function DisconnectDialog({
  target,
  onOpenChange,
  onSuccess,
  copy = "disconnect",
}: DisconnectDialogProps) {
  const isDelete = copy === "delete"

  async function handleConfirm(): Promise<boolean> {
    if (!target) return false
    try {
      const result = await removeCredentialFn({ data: { credentialId: target.credentialId } })
      if (!result.ok) {
        toast.error(
          isDelete
            ? `Failed to delete credential: ${result.error}`
            : `Failed to disconnect: ${result.error}`,
        )
        return false
      }
      toast.success(isDelete ? "Credential deleted" : "Disconnected")
      onSuccess()
      return true
    } catch {
      toast.error(isDelete ? "Failed to delete credential" : "Failed to disconnect")
      return false
    }
  }

  return (
    <ConfirmDialog
      open={target !== null}
      title={isDelete ? "Delete Credential" : "Disconnect"}
      description={
        isDelete ? (
          <>
            Delete credential <MonoCode>{target?.account}</MonoCode>
            {target?.platformId !== undefined && (
              <>
                {" "}
                on <MonoCode>{target.platformId}</MonoCode>
              </>
            )}
            ? This removes the secret from the store and cannot be undone.
          </>
        ) : (
          <>
            Disconnect <MonoCode>{target?.account}</MonoCode>? This removes the credential from the
            store and cannot be undone.
          </>
        )
      }
      confirmLabel={isDelete ? "Delete Credential" : "Disconnect"}
      confirmingLabel={isDelete ? "Deleting…" : "Disconnecting…"}
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
    />
  )
}
