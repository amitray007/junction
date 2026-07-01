# Waves — parallel increment planning

> **Why this file exists.** Junction's default planning lens is **"how can this be done in parallel?"** (see `CLAUDE.md` → *Plan for parallelism by default*). A **wave** is a set of **slices of one increment** that can be built **at the same time** because none of them blocks another and none of them edit the same files (this is **mode A** — see §0). "Wave" always means slices-within-an-increment; running *whole* increments in parallel is a different thing (**mode B**, §8), and to avoid overloading the word we call that a **batch**, never a wave. This file is the convention + the living wave plan.
>
> Parallelism is the **default, not a mandate.** A tight dependency chain stays serial — say so plainly; don't manufacture fake independent slices to look parallel.

---

## 0. Two modes — don't confuse them

There are **two** kinds of parallelism, and they use **different tools**. Keep them separate.

| | **A. Within-increment fan-out (waves)** | **B. Cross-increment batches** |
|---|---|---|
| **What runs in parallel** | slices of *one* increment (core slice + leaf slices) | *whole* independent increments |
| **Status** | **ACTIVE** — use it now for wide increments | **DEFERRED** — not until `core` stabilizes (see §8) |
| **Isolation tool** | **parallel Sonnet subagents** in the one tree; integrate serially | **`git` worktrees** (`isolation: "worktree"`), one per increment |
| **Why that tool** | serial integration means nothing writes the tree at once → worktrees are needless cost | whole increments write divergent branches simultaneously → physical isolation is required |
| **"Merge"** | orchestrator applies slices in order in one tree, `pnpm verify` between each | real git merges, DAG order, rebase-and-verify between each |

**Rule of thumb:** *within* one increment → subagents (§4–5 below). *Across* increments → worktrees, and only once §8's trigger fires. Everything in §1–7 below is written for **mode A** unless it says otherwise.

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

## 4. Fan-out (build) — mode A, subagents

- One **Sonnet builder *subagent* per slice** (the Agent tool, **no** `isolation`) — **not** a worktree. Each works from its self-contained method-file slice (the normal builder brief — see `docs/workflow.md`).
- The blocking **core/shared slice goes first**; once it's applied + verified, the independent leaf slices fan out as **parallel subagents** (dispatch them in one shot so they run concurrently).
- The orchestrator keeps planning / QA'ing while builders run. Subagents return diffs/reports; the tree isn't written by more than one at a time (see §5).

## 5. Integrate (the deliberate serial choke point — protects correctness-over-speed)

Fan-out is cheap; **integration is serialized on purpose.** With subagents there is no branch-merge dance — the orchestrator applies slices **in order in the one working tree**:

1. Reviews run **per-slice in parallel** (CE + junction reviewers) — cheap, no human gate yet.
2. Apply in **DAG order**: the `core`/shared slice **first**, then the leaves.
3. **After each slice is applied, run `pnpm verify`** before applying the next. This is the only thing that catches **semantic conflicts** — slices that typecheck in isolation but break together (the "green alone, red together" class).
4. Then drive the **real built artifact** (per `docs/workflow.md` verification discipline) — semantic breaks often pass `verify` but fail at runtime.

> **Note (mode B only):** when whole increments run in worktrees, step 2–3 become *git* merges with rebase-and-verify between each, and the stacked-PR hazards apply (merge commits not squash; retarget children before merging a parent — `STATE.md` §3). That's deferred (§8).

## 6. Honest caveats (when NOT to parallelize)

- **Real chains stay serial.** If slice B needs B-on-A's *runtime behaviour* (not just its types), it's `depends_on`, full stop.
- **Narrow increments don't fan out.** The common case is one builder in one pass. Only fan into parallel subagents when an increment has **genuinely independent, non-trivial slices** — otherwise the fan-out + serial-integration overhead exceeds the benefit.
- **`core` churn serializes.** Its slice always lands first, alone. If *several increments* all need to evolve the same `core` module, that's a mode-B (cross-increment) problem — deferred (§8).
- **User bandwidth at the test gate is finite.** The machine work fans out freely; the *human* test/approve gate is still where judgment happens — don't fan out so wide that the user can't hold the result in their head at test time.

---

## 7. Wave plan (living — keep current)

> The canonical increment **list** stays in `README.md` (the map). This section records how upcoming increments are **grouped into waves** + their dependency edges, once we start planning in waves. Until then it's empty by design.

_(no waves planned yet. **Mode B (cross-increment) is deferred — see §8**, so this stays empty. Mode A within-increment fan-out is per-increment and lives in that increment's method file, not here.)_

---

## 8. Cross-increment parallelism (mode B) — DEFERRED

Running **whole increments** in parallel (worktrees, one per increment) is **not adopted yet.** Early-stage, `core` is still being poured (nearly every increment touches it), the roadmap is a dependency *chain* not a *fan*, and the real bottleneck is the per-increment **design conversation** (inherently serial) — not build throughput. So the increments themselves stay **sequential** for now; only *within* an increment do we fan out (mode A).

**Adopt mode B when all three hold:**

1. **`core` has stabilized** — changes to it are rare and small, not every-increment.
2. **The roadmap has ≥2 genuinely independent surface areas** with little/no shared-`core` overlap (e.g. a web track and an audit track that don't touch the same files).
3. **Single-stream throughput — not the design conversation — is the bottleneck.**

When that trigger fires: revisit this file, promote worktrees + the batch-grouping/`touches`-collision machinery from "advisory" to "active," and record the first cross-increment batch in §7. (Cross-referenced in `docs/futures/revisit-when.md`.)
