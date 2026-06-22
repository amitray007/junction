# Testing Rules

Junction must be **easy to QA on every change** so we never ship broken code.

## The QA-able rule

- **Every change ships with at least one behavior test** and **passes `pnpm verify`** (typecheck + Biome + Vitest). No "I'll test it later."
- `pnpm verify` is the gate. A change that doesn't pass it is not done.

## Conventions

- **Vitest.** Tests colocated as `*.test.ts` next to the code, or in a `__tests__/` dir.
- **Assert behavior, not implementation.** Test observable outcomes (return values, persisted state, emitted errors), not which internal functions were called. Avoid mocks that couple the test to internal structure; prefer real collaborators or injected interfaces.
- **Result-returning code:** assert on both the `ok` and `err` branches. A function that can fail needs a test that exercises the failure.

## Isolation

- **MUST** set `JUNCTION_HOME=<tmpdir>` in any test that touches the config home or filesystem state. Never let tests read/write the real `~/.junction`.
- Clean up temp dirs after the test.

## Security-sensitive paths

- Credential/secret code **MUST** have negative tests: e.g. "plaintext is never written to disk", "secret never appears in logs or error output".

## Performance

- **MAY** add `vitest bench` for genuinely hot paths (credential encrypt/decrypt, MCP tool dispatch, sandbox spawn). Do **not** write speculative benchmarks.
