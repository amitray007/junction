# Futures — junction's forward-looking register

This directory is junction's **durable memory of decisions that point at the future**: dependencies we knowingly depend on that are deprecated or at end-of-life risk, decisions we deliberately deferred (with the trigger that should make us revisit them), and known fragilities worth future vigilance.

It exists because these notes were previously scattered across method files, commit messages, and the design spec — easy to lose. A single scannable register means future-us (and any contributor or agent) can answer "what are we knowingly carrying, and when does it come due?" in one place.

## Files

| File | What it holds |
|---|---|
| [`deprecations.md`](./deprecations.md) | Tools / APIs we **depend on today** that are deprecated or EOL-risk, with the **forward path** for each. |
| [`revisit-when.md`](./revisit-when.md) | Decisions we **deferred on purpose**, each with an explicit **trigger** that should make us reconsider. |
| [`gotchas.md`](./gotchas.md) | Known **fragilities / sharp edges** already hit and worked around — so we don't re-learn them the hard way. |

## How this relates to the other docs

- The **design spec** (`docs/specs/…`) stays the source of truth for *what we're building*. This register captures the *forward-looking caveats* of those decisions.
- **Method files** (`docs/methods/`) record an increment's decisions inline; when one of those decisions is a deprecation we accept, a deferral with a trigger, or a fragility, it gets **promoted here** so it's not buried in a per-increment doc.
- **Rules** (`docs/rules/`) are enforceable *now*; this register is about *later*.

## Maintenance convention (see CLAUDE.md)

Record an entry here whenever you:
1. **adopt a dependency that is deprecated / EOL-risk but necessary** → `deprecations.md` (with the forward path);
2. **defer a decision** with a "we'll do X when Y" shape → `revisit-when.md` (with the trigger);
3. **work around a non-obvious fragility** that could bite again → `gotchas.md` (with the symptom + the fix).

Each entry: one short paragraph, the increment/date it was raised, and — for deprecations/deferrals — the **trigger or forward path**. Keep it terse and scannable; this is a register, not an essay. When a trigger fires (or a deprecation is finally migrated off), update or strike the entry and note the increment that resolved it.
