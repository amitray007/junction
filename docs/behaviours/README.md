# Behaviours — how we make decisions and carry the work

`docs/rules/` says *what the code must be*. `docs/principles/` says *where code lives*.
**`docs/behaviours/` says how we decide and act** — the disposition every agent (and human)
brings to the work, independent of any one language or module.

These are not style preferences. They are load-bearing: they decide whether we ship a
quick patch that hides a critical flaw, or stop and do it right. Read them before
planning an increment, before accepting a builder's "done", and before recommending any
solution.

- **`decision-making.md`** — correctness/security over speed; architecture over expedience;
  hold decisions loosely (recommend, don't mandate).

When a behaviour is violated and it bites, record the lesson in `docs/futures/gotchas.md`
and, if the behaviour itself needs sharpening, update the relevant file here.
