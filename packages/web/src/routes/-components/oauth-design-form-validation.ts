// SPDX-License-Identifier: AGPL-3.0-only
// Client-side inline validation for the custom OAuth-design create form
// (increment 45, Slice D). Lives in its own module (client-component path,
// no .server.ts) so it cannot import @junction/core — mirrors
// cli-form/credential-env-var.ts's discipline: the SLUG_RE here is duplicated
// from core's CUSTOM_OAUTH_DESIGN_ID_PATTERN (designs-store.ts), not
// imported, to keep this module out of the server-only-core boundary. Keep
// in lock-step.
//
// Inline errors here catch a bad slug/URL BEFORE submit — otherwise
// addCustomDesignFn's "invalid-design" error reaches the UI only as a single
// generic string, which the inc-43 credentialNameError lesson says reads as
// a misleading toast rather than a field-anchored fix. This is the SAME
// lesson applied to the design-authoring form.

/** Mirrors core's CUSTOM_OAUTH_DESIGN_ID_PATTERN slug half (the part after `custom:`). */
const DESIGN_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/** Validate the design SLUG (the part after `custom:`) — empty is not flagged (handled at submit). */
export function designSlugError(slug: string): string | undefined {
  if (slug === "") return undefined
  if (!DESIGN_SLUG_RE.test(slug)) {
    return "A lowercase slug — letters, digits, hyphens; must start with a letter or digit (e.g. acme-oauth)"
  }
  return undefined
}

/** Validate a required URL field — empty is not flagged (handled at submit); else must parse as a URL. */
export function designUrlError(value: string): string | undefined {
  if (value === "") return undefined
  try {
    new URL(value)
    return undefined
  } catch {
    return "Must be a full URL, e.g. https://acme.example.com/oauth/authorize"
  }
}

/** Validate the issuer URL field for OIDC discovery — same rule as designUrlError, distinct copy for the field's own context. */
export function issuerUrlError(value: string): string | undefined {
  if (value === "") return undefined
  try {
    new URL(value)
    return undefined
  } catch {
    return "Must be a full URL, e.g. https://accounts.example.com"
  }
}
