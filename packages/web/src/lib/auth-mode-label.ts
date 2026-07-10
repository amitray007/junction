// SPDX-License-Identifier: AGPL-3.0-only
// auth-mode → human label + the canonical mode ordering. Extracted (inc 36)
// from a two-copy duplication between app.$id.tsx and connect-panel.tsx — a
// pure presentational primitive (docs/principles/: factor these eagerly, and
// this is exactly the copy the later app slices 37–39 would clone a third
// time). Keep this the single source so the surface chip, the empty-state CTA,
// and the connect dialog can never disagree on a mode's wording.

export type AuthMode = "oauth2" | "token" | "byo" | "none"

/** Canonical display order — fast/guided Select options iterate this. */
export const AUTH_MODE_ORDER = ["oauth2", "token", "byo", "none"] as const

export function authModeLabel(mode: AuthMode): string {
  switch (mode) {
    case "oauth2":
      return "Connect via OAuth"
    case "token":
      return "Paste a token"
    case "byo":
      return "Bring your own connection details"
    case "none":
      return "No credential required"
    default: {
      const _: never = mode
      return _
    }
  }
}
