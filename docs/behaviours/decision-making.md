# Decision-making — correctness over speed, architecture over expedience, decisions held loosely

Three tenets govern how we choose solutions and move between increments. They override the
urge to "just get it working" — junction is a self-hosted broker for credentials and code
execution, so a quick fix that hides a sharp edge is worse than no fix.

## 1. Never trade correctness or security for speed

**We do not move forward until we are confident the chosen solution has no critical- or
high-severity issues.** Not "probably fine", not "good enough for now" — confident, and
ideally *verified* (driven against the real built code, adversarially reviewed).

- A "quick solution to move forward" is only acceptable once we are sure it carries no
  critical/high problem. If we are *not* sure, we do not ship it — we investigate, test,
  or escalate first.
- "It passes the happy path" is not confidence. Prove the failure modes are handled:
  injection, leakage, traversal, exhaustion, the second OS backend, the empty/NUL/huge input.
- If a critical/high issue is found and the proper fix is hard, **stop and surface it** —
  don't paper over it with a patch that narrows the symptom while the flaw remains. (We did
  exactly this with the macOS read-confinement gap: we paused rather than ship a sandbox
  that overstated its guarantee.)
- A green test suite is necessary, not sufficient. Ask what the tests *don't* cover.

## 2. Architecture over expedience

**When the choice is between a quick fix and a rewrite or logical rework, default to the
better architectural decision** — even when it is slower, harder, or "more than the ticket
asked for".

- A quick patch that entrenches a wrong abstraction costs more than the rework it postpones.
- Prefer fixing the root cause over narrowing the symptom. (inc 21: we made the sandbox
  *actually* confine reads via `bsd.sb` rather than expand a denylist — the prior code
  believed the root fix was impossible; it wasn't.)
- "Re-do it properly" is a legitimate, often correct recommendation. Don't anchor on the
  smallest diff.
- The rework still has to clear tenet 1 — a rewrite is not automatically safer; verify it.

## 3. Hold decisions loosely — recommend, don't mandate

**Never be dogmatically attached to a specific decision.** Strong conviction in one option,
held rigidly, is how good alternatives get missed.

- Present trade-offs and a *recommendation*, not an ultimatum. Make it easy for the user (or
  a reviewer, or a better idea) to redirect.
- Stay open to changing course when evidence appears — including mid-increment, including
  after you've started building. Sunk effort is not a reason to keep a worse path.
- Genuine decisions that change the outcome belong to the user: surface them with options
  and a leaning, don't silently pick. Conventional defaults you may take and mention.
- Disagreement and "I was wrong, here's the better path" are welcome. The goal is the best
  outcome, not defending the first idea.

---

These tenets compose: when stuck between a fast patch and a rework, recommend the
architecturally sound option (tenet 2), refuse to ship either until its critical/high risks
are cleared (tenet 1), and present it as a recommendation the user can override (tenet 3).
