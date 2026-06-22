# DRY Principles

DRY done right: eliminate duplication of **meaning**, not duplication of **shape**. The wrong abstraction costs more than the duplication it replaced.

## 1. Duplication is cheaper than the wrong abstraction

> "Duplication is far cheaper than the wrong abstraction." — Sandi Metz

The failure mode: an abstraction grows a boolean/parameter for every almost-fitting new case until it's an unreadable knot nobody dares change. The recovery is telling — you **inline the abstraction back into every caller** and let the real seams reappear. That asymmetry (easy to inline, hard to untangle) is why we wait before abstracting.

## 2. Rule of Three — for policies and workflows

Tolerate duplication **twice**. On the **third** real occurrence — and only if the three cases mean the *same thing* — extract. Two look-alikes representing different concepts are *accidental* duplication; leave them.

## 3. Factor-on-first-use — for stable primitives

Stable, single-meaning **primitives** are factored immediately, because their "duplication" is never the accidental kind:
- Domain error kinds (`CredentialError`, `StorageError`, …) → `core/src/errors/`
- Result helpers (neverthrow wrappers, exhaustive match) → `core/src/result/`
- ID generation (ULID) → `core/src/ids/`
- Path resolution (`~/.junction`, `JUNCTION_HOME`) → `core/src/paths/`
- Logger config → `core/src/logging/`
- Branded-ID + `<namespace>__<tool>` Zod refinements → `core/src/schema/`

**The line: DRY the primitives eagerly; make policies/workflows wait for three.**

## 4. Accidental vs real duplication — keep these duplicated

Same-looking, different-meaning code stays duplicated until proven otherwise:
- **Per-entity repositories** (`profiles.create` vs `credentials.create`) — they diverge (credentials touch `CredentialStore`, profiles touch `source_refs`). A premature generic `Repository<T>` is the classic wrong abstraction.
- **CLI command scaffolding** — argv→core→print similarity is coincidental; don't force every command through a parameter-laden base.
- **MCP tool handlers** — surface-shaped similarity, different meaning.
- **Per-boundary entity schemas** — share *primitives* (branded ID), not whole entity schemas across unrelated boundaries.

## 5. Share through `core`

When something *is* genuinely shared, it lives as a `core` module reachable by all edges (see `modularity.md`) — not copied between packages, and not in a `utils` grab-bag.

---

Signal for "a rule-of-three moment arrived": `jscpd` copy-paste reports (inc 1.5, CI-only) — a prompt to investigate, not an auto-fail.
