// SPDX-License-Identifier: AGPL-3.0-only
// Locks the LOAD-BEARING arity split for the audit target (inc 31; a doc-review
// blocker). The wire tool name has two arities:
//   unprefixed (single-profile / stdio): <namespace>__<tool>
//   prefixed   (multi-profile / global): <profile>__<namespace>__<tool>
// parseWireName must recover {profile, namespace, tool} correctly for both,
// including a tool name that itself contains "__" (split on the FIRST "__").

import { describe, expect, it } from "vitest"
import { parseWireName } from "./providers.js"

describe("parseWireName — arity-aware audit target split", () => {
  describe("unprefixed (single-profile / stdio)", () => {
    it("splits <namespace>__<tool>, profile = the single served profile", () => {
      expect(parseWireName("gh__list_issues", false, "work")).toEqual({
        profile: "work",
        namespace: "gh",
        tool: "list_issues",
      })
    })
    it("a tool name containing __ splits on the FIRST __ only", () => {
      expect(parseWireName("gh__bad__tool", false, "work")).toEqual({
        profile: "work",
        namespace: "gh",
        tool: "bad__tool",
      })
    })
    it("no __ at all → empty namespace, whole name is the tool", () => {
      expect(parseWireName("lonely", false, "work")).toEqual({
        profile: "work",
        namespace: "",
        tool: "lonely",
      })
    })
  })

  describe("prefixed (multi-profile / global key)", () => {
    it("peels <profile>__ first, THEN splits <namespace>__<tool> — NOT profile-as-namespace", () => {
      expect(parseWireName("work__gh__list_issues", true, "")).toEqual({
        profile: "work",
        namespace: "gh",
        tool: "list_issues",
      })
    })
    it("a tool name containing __ in a prefixed name still resolves correctly", () => {
      expect(parseWireName("work__gh__bad__tool", true, "")).toEqual({
        profile: "work",
        namespace: "gh",
        tool: "bad__tool",
      })
    })
    it("fail-safe: a prefixed name with no separator does not throw", () => {
      expect(parseWireName("nope", true, "")).toEqual({
        profile: "",
        namespace: "",
        tool: "nope",
      })
    })
  })
})
