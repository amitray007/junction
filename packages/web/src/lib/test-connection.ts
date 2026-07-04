// SPDX-License-Identifier: AGPL-3.0-only
// Shared "test connection" flow — extracted from credentials.tsx's
// handleTestConnection and app.$id.tsx's handleTest (inc 30 jscpd dedupe):
// both pages ran the identical testCredentialFn + toast-branching logic
// against a credential id, differing only in how they get that id (a
// CredentialMeta's `id` vs a ConnectionMeta's `credentialId`) and in the
// loading-state/invalidate wiring around the call, which stays owned by
// each page (this helper is deliberately state-free).

import { toast } from "sonner"
import { testCredentialFn } from "../server/mutations.functions.js"

/**
 * Runs testCredentialFn for a credential id and surfaces the result via
 * toast — the exact branching both routes shipped (ok/auth-failed/
 * unreachable/other, plus the try/catch fallback). `onOk` runs ONLY on a
 * successful (`result.ok`) response, awaited inside the same try — matching
 * the original inline handlers, where a failing loader-invalidate after a
 * successful test also lands in the catch. Callers own their own
 * loading-state (set before calling, cleared in a `finally` around this).
 */
export async function testConnection(
  credentialId: string,
  onOk?: () => Promise<void>,
): Promise<void> {
  try {
    const result = await testCredentialFn({ data: { credentialId } })
    if (!result.ok) {
      toast.error(`Failed to test connection: ${result.error}`)
      return
    }
    if (result.status === "ok") {
      toast.success("Connected")
    } else if (result.status === "auth-failed") {
      toast.error("Auth failed — check the token")
    } else if (result.status === "unreachable") {
      toast.warning("Couldn't reach the source")
    } else {
      toast.message(result.detail ?? "Not auto-verifiable for this source")
    }
    await onOk?.()
  } catch {
    toast.error("Failed to test connection")
  }
}
