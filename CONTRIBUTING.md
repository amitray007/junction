# Contributing to junction

Thanks for your interest. Junction is in active foundation development — contributions are
welcome once the core increments stabilize, and the process below applies now so everything
is governed from the start.

---

## Workflow

Junction uses a **method-file workflow**: every increment has a method file
(`docs/methods/NN-<name>.md`) that contains both the spec and the step-by-step
implementation. See [`docs/workflow.md`](docs/workflow.md) for the full 8-step loop
(research → plan → method file → build → QA → review → user test → ship).

Before opening a PR, read the relevant method file for the increment you are working on.

---

## Dev setup

**Requirements:** Node 22 (floor 20), pnpm.

```sh
pnpm install
pnpm verify      # typecheck + lint + tests — must pass before any commit
```

---

## The verify gate

**Every change must pass `pnpm verify` before committing.** This runs:

- `tsc -b` — full type-check across the monorepo
- `biome check` — lint + format
- `vitest run` — unit tests

lefthook enforces this as a pre-commit hook; a broken commit is blocked. If `pnpm verify`
fails, root-cause it — do not skip or disable the gate.

---

## Changesets (user-facing changes)

If your change is user-facing (affects a package's released behavior), run:

```sh
pnpm changeset
```

Select the affected packages, pick a semver bump, and write a concise summary. Commit the
generated changeset file alongside your code change. Changes that are purely internal
(docs, tooling, tests) do not need a changeset.

---

## Rules and principles

Read these before writing any code:

- [`docs/rules/`](docs/rules/) — enforceable guardrails (TypeScript, testing, performance,
  security, data). The `pnpm verify` gate and pre-commit hooks enforce the mechanical subset;
  review agents audit the rest.
- [`docs/principles/`](docs/principles/) — modularity (where code lives, one-way dependency
  graph, no `utils` packages) and DRY (factor primitives eagerly, keep policies duplicated
  until the rule of three).

The prime directives from `docs/rules/README.md`:

- **Core is pure; edges are thin.** Logic in `@junction/core`; `cli`/`web`/`mcp/*` only
  translate.
- **Dependency direction is one-way.** `core` ← others, never the reverse. No HTTP/daemon
  in `core`.
- **Credentials never leave the process.** Plaintext only in memory during a tool call.
- **Every change is QA-able.** Ships with a behavior test and passes `pnpm verify`.

---

## Commits and PRs

- Use a clear, descriptive PR title and description. There is no enforced commit-message
  format at the commit level (only the PR gate matters).
- Fill out the pull request template checklist before requesting review.

---

## Licensing — no CLA

**No CLA. Inbound = outbound AGPL-3.0-only.**

By contributing to junction, you agree that your contribution is licensed under the same
[AGPL-3.0-only](LICENSE) license as the project. No CLA signature, DCO sign-off, or
`Signed-off-by` trailer is required or expected.

AGPL-3.0 is copyleft with a §13 network-use clause: anyone who runs a modified junction
over a network must offer the Corresponding Source to users of that service.
