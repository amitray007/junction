# Waves — parallel increment planning

> **Why this file exists.** Junction's default planning lens is **"how can this be done in parallel?"** (see `CLAUDE.md` → *Plan for parallelism by default*). A **wave** is a set of increment slices that can be built **at the same time** because none of them blocks another and none of them edit the same files. This file is the convention + the living wave plan.
>
> Parallelism is the **default, not a mandate.** A tight dependency chain stays serial — say so plainly; don't manufacture fake independent slices to look parallel.

---

## 1. The slicing move (do this when you plan)

When an increment is more than a one-file change, try to split it into:

- **One blocking core/shared slice** — the `core` type / interface / op / migration that the others need. Small, lands **first and alone** as its own fast PR.
- **N independent leaf slices** — the consumers (`cli`, `web`, `mcp/server`, `mcp/client`, tests/docs) that, once the core slice is merged, **don't depend on each other** and can fan out simultaneously.

A serial chain `core → web → cli` becomes a fork: land `core`, then `web` ∥ `cli`. Anything genuinely dependent gets broken out to land **later**, behind the slice it needs (record it with `depends_on`).

If it can't be split — it's a real chain — keep it as one method file and note `parallel_group: serial` so the wave planner leaves it alone.

## 2. Frontmatter (every method file carries this)

```yaml
---
increment: 27                  # the NN of this slice
title: mcp/server per-profile endpoint
depends_on: [26]               # HARD deps — needs that increment's MERGED code. Empty = ready now.
soft_after: [24]               # nicer-if-done-first, NON-blocking (ordering preference only)
touches: [core, mcp/server]    # packages/paths this slice MUTATES (see vocab below)
parallel_group: B              # label; slices in different groups may run together. "serial" = never parallelize.
---
```

**`touches` vocabulary** (keep it coarse but honest — it's the collision check):
`core` · `cli` · `web` · `mcp/server` · `mcp/client` · `docs` · `ci` · or a specific path when finer granularity matters (e.g. `core/credential-store`).

**The collision rule (mechanical, not vibes):**
> Two slices may run in the same wave **iff** `depends_on` is satisfied for both **and** their `touches` sets do not both mutate the same entry — most critically **`core`**, which everything imports. Two slices that both write `core` do **not** go in the same wave (split the `core` change into its own earlier slice instead).

## 3. Building a wave

1. Take all method files whose `depends_on` are already **merged**.
2. Greedily pack them into a wave, dropping any that collide (`touches` overlap) with one already in the wave — those go to the next wave.
3. Order **within** the wave doesn't matter for *building* (they're independent). Order **for merging** does — see §5.
4. Present the wave to the user for **one approval** (the wave, not each slice). Then fan out.

## 4. Fan-out (build)

- One **Sonnet builder per slice**, each in its **own `git` worktree + branch** (Agent tool `isolation: "worktree"`). No file collisions by construction.
- Each builder works from its self-contained method file (the normal builder brief — see `docs/workflow.md`).
- Builders run **concurrently in the background**; the orchestrator keeps planning the next wave / QA'ing finished ones.

## 5. Merge (the deliberate serial choke point — protects correctness-over-speed)

Fan-out is cheap; **merge is serialized on purpose.**

1. Reviews run **per-worktree in parallel** (CE + junction reviewers) — cheap, no human gate yet.
2. Merge in **DAG order**: any `core`/shared slice **first**, then the leaves.
3. **After each merge, the next worktree rebases on the new `main` and re-runs `pnpm verify`** before its own merge. This is the only thing that catches **semantic conflicts** — changes git merges cleanly but that break `tsc`/Vitest (the "green in isolation, red together" class).
4. Stacked-PR hazards still apply (see `docs/futures/gotchas.md` / `STATE.md` §3): merge commits not squash; retarget children before merging a parent.

## 6. Honest caveats (when NOT to parallelize)

- **Real chains stay serial.** If slice B needs B-on-A's *runtime behaviour* (not just its types), it's `depends_on`, full stop.
- **`core` churn serializes.** If several increments all need to evolve the same `core` module, that's a signal to **do the `core` evolution as one earlier increment**, then fan out — not to run them in parallel and fight merges.
- **User bandwidth at the test gate is finite.** The machine work fans out freely; the *human* test/approve gate is still where judgment happens. Batch-review is fine because every PR arrives already-green and already-agent-reviewed — but don't fan out so wide that the user can't hold the wave in their head at test time.
- **Worktrees cost setup.** Use them when slices genuinely run at once; a lone slice doesn't need one.

---

## 7. Wave plan (living — keep current)

> The canonical increment **list** stays in `README.md` (the map). This section records how upcoming increments are **grouped into waves** + their dependency edges, once we start planning in waves. Until then it's empty by design.

_(no waves planned yet — populate when the next multi-slice increment is planned)_
