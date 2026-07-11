// SPDX-License-Identifier: AGPL-3.0-only
// Tests for the sovereignty-note primitives (increment 36, §1a signal) —
// asserts the exact honesty claims render and that neither ever renders a
// secret-shaped value (they take no props carrying data, so this is really a
// "the copy says what it says" pin).

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { CredentialSovereigntyNote, SandboxBoundaryNote } from "./sovereignty-note.js"

afterEach(() => cleanup())

describe("CredentialSovereigntyNote", () => {
  it("states the credential is stored encrypted locally and never leaves the process", () => {
    const { getByText } = render(<CredentialSovereigntyNote />)
    expect(
      getByText(
        "This credential is stored encrypted on this machine and never leaves the process.",
      ),
    ).toBeInTheDocument()
  })
})

describe("SandboxBoundaryNote", () => {
  it("states the sandbox isolation + env-var-credential + no-ambient-login facts", () => {
    const { getByText } = render(<SandboxBoundaryNote />)
    expect(getByText(/sandboxed and isolated from your filesystem/)).toBeInTheDocument()
    expect(getByText(/one environment variable/)).toBeInTheDocument()
    expect(getByText(/never.*the CLI's own saved login/)).toBeInTheDocument()
  })
})
