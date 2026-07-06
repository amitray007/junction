#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// docs:check — gate the cross-session memory (docs/STATE.md).
//
// Wired into `pnpm verify` (pre-commit + pre-push + CI). Enforces that STATE.md
// stays well-formed AND fresh relative to the increment map: an increment cannot be
// marked `done` in docs/methods/README.md without a matching entry in STATE.md's
// session log. This gives the handover memory teeth — docs alone are advisory; this
// fails the build if an agent skips the "update STATE.md" step (junction-handover skill).
//
// It enforces STRUCTURE + FRESHNESS (mechanizable). It cannot judge the QUALITY of an
// entry — that stays the agent's discipline (the junction-handover checklist).

import { readFileSync } from "node:fs"

function fail(msgs) {
  console.error(
    "\ndocs:check FAILED — docs/STATE.md is malformed or stale:\n" +
      msgs.map((m) => `  ✗ ${m}`).join("\n") +
      "\n\nFix it via the junction-handover skill: update §1 (Snapshot) and add a §7 (Session log) entry.\n",
  )
  process.exit(1)
}

let state
let map
try {
  state = readFileSync("docs/STATE.md", "utf8")
} catch {
  fail(["docs/STATE.md is missing (it is the project memory / handover — required)"])
}
try {
  map = readFileSync("docs/methods/README.md", "utf8")
} catch {
  fail(["docs/methods/README.md is missing"])
}

const errors = []

// 1. STRUCTURE — the sections a resuming session relies on must exist.
const requiredSections = [
  "## 1. Snapshot",
  "## 3. Session-critical traps",
  "## 6. Resume checklist",
  "## 7. Session log",
]
for (const s of requiredSections) {
  if (!state.includes(s)) errors.push(`missing required section header: "${s}"`)
}
if (!/_Last updated:/.test(state)) errors.push('missing the "_Last updated:" line')

// 2. FRESHNESS — the `STATE-done-through` marker must equal the highest increment
//    marked `done` in the map. A machine-readable marker (not prose) so a "next:
//    increment N" pointer can't false-pass. Done-flip without bumping the marker = stale.
//
//    Increments are `major.minor` (e.g. `30.10`). Compare them as a (major, minor)
//    TUPLE, never a float — `Number.parseFloat("30.10")` is `30.1`, which would sort
//    BELOW `30.9` and silently break every two-digit-minor increment (30.10, 30.11, …).
const parseVer = (s) => {
  const [maj, min = "0"] = String(s).split(".")
  return [Number.parseInt(maj, 10), Number.parseInt(min, 10)]
}
const cmpVer = (a, b) => a[0] - b[0] || a[1] - b[1]
const verStr = (v) => (v[1] === 0 ? `${v[0]}` : `${v[0]}.${v[1]}`)
const doneVers = [...map.matchAll(/^\|\s*(\d+(?:\.\d+)?)\s*\|.*\|\s*done\s*\|\s*$/gm)].map((m) =>
  parseVer(m[1]),
)
const markerMatch = state.match(/<!--\s*STATE-done-through:\s*(\d+(?:\.\d+)?)\s*-->/)
if (!markerMatch) {
  errors.push("missing the `<!-- STATE-done-through: N -->` freshness marker")
} else if (doneVers.length > 0) {
  const highest = doneVers.reduce((a, b) => (cmpVer(a, b) >= 0 ? a : b))
  const marker = parseVer(markerMatch[1])
  const highestStr = verStr(highest)
  if (cmpVer(marker, highest) !== 0) {
    errors.push(
      `stale: STATE-done-through marker is ${verStr(marker)} but the increment map's highest \`done\` is ${highestStr}. ` +
        `Bump the marker to ${highestStr} and add a §7 (Session log) entry for it.`,
    )
  }
  // Soft nudge: a §7 entry should mention the increment (advisory, not gating prose).
  const logIdx = state.indexOf("## 7. Session log")
  const log = logIdx >= 0 ? state.slice(logIdx) : ""
  if (!new RegExp(`\\b${highestStr.replace(".", "\\.")}\\b`).test(log)) {
    errors.push(`STATE.md §7 (Session log) has no entry mentioning increment ${highestStr}.`)
  }
}

if (errors.length > 0) fail(errors)

const through =
  doneVers.length > 0 ? verStr(doneVers.reduce((a, b) => (cmpVer(a, b) >= 0 ? a : b))) : "?"
console.log(`docs:check OK — STATE.md well-formed and fresh through increment ${through}.`)
