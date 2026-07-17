// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for deriveCredentialName / slugifyPart (inc 42). Pins the slug
// contract that BOTH the app create-paths and migration 0011's backfill rely
// on: the returned name is ALWAYS a valid CredentialNameSchema slug, and
// collisions against the caller's existing-names set get a -2/-3 suffix.

import { describe, expect, it } from "vitest"
import { deriveCredentialName } from "./derive-name.js"

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

describe("deriveCredentialName", () => {
  it("derives <platform>-<account> for plain slug inputs", () => {
    expect(deriveCredentialName("github", "work", new Set())).toBe("github-work")
  })

  it("lowercases and hyphenates non-slug characters (never returns a non-slug)", () => {
    expect(deriveCredentialName("openapi:acme", "prod", new Set())).toBe("openapi-acme-prod")
    expect(deriveCredentialName("gh", "Work_Account", new Set())).toBe("gh-work-account")
    expect(deriveCredentialName("gh", "my prod key", new Set())).toBe("gh-my-prod-key")
  })

  it("collapses runs of invalid chars to a single hyphen and trims edges", () => {
    // "***" → "" per part; leading/trailing/collapsed hyphens removed.
    const name = deriveCredentialName("gh", "a***b", new Set())
    expect(name).toBe("gh-a-b")
    expect(name).toMatch(SLUG_RE)
  })

  it("falls back to a valid literal when BOTH parts slugify to nothing (empty-slug guard)", () => {
    const name = deriveCredentialName("*", "*", new Set())
    // Must NOT be "" (which would fail CredentialNameSchema at the DB boundary).
    expect(name).toMatch(SLUG_RE)
    expect(name).toBe("credential")
  })

  it("suffixes -2/-3 on collision against the existing-names set", () => {
    const existing = new Set(["github-work"])
    expect(deriveCredentialName("github", "work", existing)).toBe("github-work-2")
    existing.add("github-work-2")
    expect(deriveCredentialName("github", "work", existing)).toBe("github-work-3")
  })

  it("the empty-slug fallback also uniquifies via the collision loop", () => {
    const existing = new Set(["credential"])
    expect(deriveCredentialName("*", "*", existing)).toBe("credential-2")
  })

  it("every output across adversarial inputs is a valid slug", () => {
    const inputs: Array<[string, string]> = [
      ["a", "b"],
      ["A-B", "C_D"],
      ["openapi:x", "y.z"],
      ["  spaced  ", "  label  "],
      ["***", "***"],
      ["café", "naïve"],
      ["emoji😀", "tab\tsep"],
    ]
    for (const [p, a] of inputs) {
      expect(deriveCredentialName(p, a, new Set())).toMatch(SLUG_RE)
    }
  })
})
