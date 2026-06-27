---
name: junction-handover
description: Maintain junction's cross-session memory and hand off cleanly between Claude Code sessions. Use at the END of an increment (to log progress), when CONTEXT is getting heavy (to decide continue-vs-new-session), or at the START of a new session (to resume). Keeps docs/STATE.md current so any future agent can pick up with full context.
---

# Junction Handover — cross-session memory

`docs/STATE.md` is junction's living project memory: where we are, how we work, the
recurring traps, the plan, and a session log. This skill keeps it accurate so a brand-new
Claude Code session can resume with zero loss of context. Three moments to use it.

## A. End of an increment — LOG IT (do this every time)

This is the final step of the per-increment loop, alongside the end-of-increment report.
After an increment is merged:

1. **Update `docs/STATE.md`:**
   - **§1 Snapshot** — bump "last merged" PR, the increment count, and the **immediate next**.
   - **§7 Session log** — prepend a terse entry: `YYYY-MM-DD — increment NN (name).` + what shipped, any notable review fix, and "Next: NN+1." Keep it to a few lines.
   - **§3 Traps** — if a NEW recurring trap bit this increment, add it (and to `docs/futures/gotchas.md`).
   - **§4 Plan** — if the route/slicing changed, reconcile with `docs/methods/README.md`.
2. **Keep the registers current** (already part of the loop): `docs/futures/{gotchas,revisit-when,deprecations}.md`.
3. **Mark the increment `done`** in `docs/methods/README.md`.
4. Commit these doc updates (with the increment, or as a small follow-up).

Keep it terse — this is a running memory, not prose. The git log + the method files hold the detail; STATE.md holds the *orientation*.

## B. Increment boundary — DECIDE: continue or new session

Before starting the next increment, judge context load:
- **Default — continue here** if context is light/moderate.
- **Recommend a new session** if context is heavy: a long session, several increments already done this session, or the harness has summarized context. Then:
  1. Finish/merge the current increment cleanly (don't hand off mid-increment).
  2. Run step **A** (update `docs/STATE.md`).
  3. Tell the user: *"Context is getting large — I'd start increment NN in a fresh session. `docs/STATE.md` is the handoff; the new session should read it first."*
  4. The user decides. If they continue, proceed; if they open a new session, that session uses §C.

The agent can't read its exact token count, but **err toward recommending a fresh session at an increment boundary once the conversation is clearly long** — increment boundaries are the clean cut points, and STATE.md makes the handoff lossless.

## C. Start of a new session — RESUME

Follow `docs/STATE.md` §6 (Resume checklist):
1. Read `CLAUDE.md` + `docs/STATE.md` + `docs/methods/README.md`; skim `docs/behaviours/` + `docs/futures/gotchas.md`.
2. `git checkout main && git pull`; `gh pr list` (confirm no surprise open PRs).
3. Pick the next increment from STATE.md §4 / the map and run the per-increment loop.

## Where memory lives (don't duplicate)

- `CLAUDE.md` — **stable** rules / architecture / operating model. (Rarely changes.)
- `docs/STATE.md` — **volatile** current state + resume + session log. (Changes every increment.)
- `docs/methods/README.md` — the increment map / plan (status column).
- `docs/methods/NN-*.md` — per-increment specs.
- `docs/futures/` — deferred decisions (revisit-when), known gotchas, deprecations.
- `docs/behaviours/` — how we decide.

STATE.md is the **index + pointer + must-know traps**, not a copy of the others.
