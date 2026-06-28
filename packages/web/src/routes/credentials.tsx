// SPDX-License-Identifier: AGPL-3.0-only
// Credentials route — add / rotate / delete credentials from the browser.
// Mutation pattern: POST server-fn → router.invalidate() → toast feedback.
// No @junction/core import. Secret is input-only; never rendered or returned.

import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Plus, RefreshCw, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import type { CredentialMeta } from "../server/data.functions.js"
import { getCredentials, getPlatforms } from "../server/data.functions.js"
import {
  addCredentialFn,
  removeCredentialFn,
  rotateCredentialFn,
} from "../server/mutations.functions.js"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenuContent,
  DropdownMenuItem,
  Field,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Table,
  TableActionsCell,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from "../ui/index.js"
import { EmptyState } from "../ui/states.js"

export const Route = createFileRoute("/credentials")({
  loader: async () => {
    const [credentials, platforms] = await Promise.all([getCredentials(), getPlatforms()])
    return { credentials, platforms }
  },
  pendingComponent: CredentialsPending,
  component: CredentialsPage,
})

// Map credential kind to a badge status.
// All stored credential kinds mean the credential was added successfully.
// Show "Configured" — neutral, no liveness claim — until inc 28 adds live probing.
function kindToStatus(_kind: string): "configured" {
  return "configured"
}

function CredentialsPending() {
  return (
    <div>
      <PageHeader title="Credentials" />
      <TableSkeleton
        rows={4}
        columns={[
          { width: "w-40" },
          { width: "w-32" },
          { flex: true },
          { width: "w-24" },
          { width: "w-20" },
          { width: "w-8" },
        ]}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// MonoCode — inline code element using the design-token monospace style.
// Used wherever a credential id, platformId, or account is displayed inline.
// ---------------------------------------------------------------------------

function MonoCode({ children }: { children: React.ReactNode }) {
  return (
    <code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)" }}>{children}</code>
  )
}

// ---------------------------------------------------------------------------
// Shared password field — wraps a masked Input inside a Field.
// Used by AddCredentialDialog ("Secret") and RotateCredentialDialog ("New secret").
// ---------------------------------------------------------------------------

interface SecretFieldProps {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  placeholder?: string
}

function SecretField({ id, label, value, onChange, error, placeholder }: SecretFieldProps) {
  return (
    <Field id={id} label={label} error={error}>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        hasError={!!error}
        aria-required="true"
        placeholder={placeholder}
      />
    </Field>
  )
}

// ---------------------------------------------------------------------------
// Add credential dialog
// ---------------------------------------------------------------------------

interface AddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  platforms: Array<{ id: string; displayName: string }>
  onSuccess: () => void
}

function AddCredentialDialog({ open, onOpenChange, platforms, onSuccess }: AddDialogProps) {
  const [platformId, setPlatformId] = useState("")
  const [account, setAccount] = useState("")
  const [secret, setSecret] = useState("")
  const [errors, setErrors] = useState<{ platformId?: string; account?: string; secret?: string }>(
    {},
  )
  const [submitting, setSubmitting] = useState(false)

  function reset() {
    setPlatformId("")
    setAccount("")
    setSecret("")
    setErrors({})
    setSubmitting(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Client-side validate required fields.
    const newErrors: typeof errors = {}
    if (!platformId) newErrors.platformId = "Platform is required"
    if (!account.trim()) newErrors.account = "Account is required"
    if (!secret) newErrors.secret = "Secret is required"
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    setSubmitting(true)
    try {
      const result = await addCredentialFn({
        data: { platformId, account: account.trim(), kind: "bearer", secret },
      })
      if (!result.ok) {
        toast.error(`Failed to add credential: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Credential added")
      onOpenChange(false)
      reset()
      onSuccess()
    } catch {
      toast.error("Failed to add credential")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>
            Add a bearer credential for a platform. The secret is never stored in plaintext.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <Field id="add-platform" label="Platform" error={errors.platformId}>
              <Select value={platformId} onValueChange={setPlatformId}>
                <SelectTrigger id="add-platform" aria-required="true">
                  <SelectValue placeholder="Select a platform" />
                </SelectTrigger>
                <SelectContent>
                  {platforms.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="add-account" label="Account" error={errors.account}>
              <Input
                id="add-account"
                placeholder="e.g. work, personal"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                hasError={!!errors.account}
                aria-required="true"
              />
            </Field>
            <Field
              id="add-kind"
              label="Kind"
              description="Only bearer credentials are supported in this release."
            >
              <Input id="add-kind" value="bearer" disabled aria-disabled="true" />
            </Field>
            <SecretField
              id="add-secret"
              label="Secret"
              value={secret}
              onChange={setSecret}
              error={errors.secret}
              placeholder="Paste your secret here"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Adding…" : "Add credential"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rotate credential dialog
// ---------------------------------------------------------------------------

interface RotateDialogProps {
  credential: CredentialMeta | null
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

function RotateCredentialDialog({ credential, onOpenChange, onSuccess }: RotateDialogProps) {
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
    if (!credential) return
    setSubmitting(true)
    try {
      const result = await rotateCredentialFn({
        data: { credentialId: credential.id, newSecret },
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
    <Dialog open={credential !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate credential</DialogTitle>
          <DialogDescription>
            Enter a new secret for <MonoCode>{credential?.account}</MonoCode> on{" "}
            <MonoCode>{credential?.platformId}</MonoCode>. The old secret is deleted from the store
            on success.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex flex-col gap-4">
            <SecretField
              id="rotate-secret"
              label="New secret"
              value={newSecret}
              onChange={setNewSecret}
              error={error}
              placeholder="Paste new secret here"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Rotating…" : "Rotate secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog
// ---------------------------------------------------------------------------

interface DeleteDialogProps {
  credential: CredentialMeta | null
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

function DeleteCredentialDialog({ credential, onOpenChange, onSuccess }: DeleteDialogProps) {
  const [submitting, setSubmitting] = useState(false)

  function handleOpenChange(next: boolean) {
    if (!next) setSubmitting(false)
    onOpenChange(next)
  }

  async function handleDelete() {
    if (!credential) return
    setSubmitting(true)
    try {
      const result = await removeCredentialFn({ data: { credentialId: credential.id } })
      if (!result.ok) {
        toast.error(`Failed to delete credential: ${result.error}`)
        setSubmitting(false)
        return
      }
      toast.success("Credential deleted")
      handleOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to delete credential")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={credential !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete credential</DialogTitle>
          <DialogDescription>
            Delete credential <MonoCode>{credential?.account}</MonoCode> on{" "}
            <MonoCode>{credential?.platformId}</MonoCode>? This removes the secret from the store
            and cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={submitting} onClick={handleDelete}>
            {submitting ? "Deleting…" : "Delete credential"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

function CredentialsPage() {
  const { credentials, platforms } = Route.useLoaderData()
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [rotatingCred, setRotatingCred] = useState<CredentialMeta | null>(null)
  const [deletingCred, setDeletingCred] = useState<CredentialMeta | null>(null)

  async function invalidate() {
    await router.invalidate()
  }

  return (
    <div>
      <PageHeader
        title="Credentials"
        count={credentials.length > 0 ? credentials.length : undefined}
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add credential
          </Button>
        }
      />

      {credentials.length === 0 ? (
        <EmptyState
          label="No credentials yet."
          hint={
            <span>
              Run <MonoCode>junction credential add</MonoCode> to add one via CLI, or click{" "}
              <strong>Add credential</strong> above.
            </span>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableActionsHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {credentials.map((c: CredentialMeta) => (
              <TableRow key={c.id}>
                <TableCell>
                  <MonoCode>{c.id}</MonoCode>
                </TableCell>
                <TableCell>
                  <MonoCode>{c.platformId}</MonoCode>
                </TableCell>
                <TableCell>{c.account}</TableCell>
                <TableCell style={{ color: "var(--muted)" }}>{c.kind}</TableCell>
                <TableCell>
                  <StatusBadge status={kindToStatus(c.kind)} />
                </TableCell>
                <TableActionsCell
                  menu={
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRotatingCred(c)}>
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        Rotate secret
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setDeletingCred(c)}
                        style={{ color: "var(--status-error-fg)" }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  }
                />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AddCredentialDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        platforms={platforms}
        onSuccess={invalidate}
      />
      <RotateCredentialDialog
        credential={rotatingCred}
        onOpenChange={(open) => {
          if (!open) setRotatingCred(null)
        }}
        onSuccess={invalidate}
      />
      <DeleteCredentialDialog
        credential={deletingCred}
        onOpenChange={(open) => {
          if (!open) setDeletingCred(null)
        }}
        onSuccess={invalidate}
      />
    </div>
  )
}
