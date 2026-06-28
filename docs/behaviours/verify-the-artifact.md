# Verify the artifact — a green gate is not a working product

**A passing gate proves the gate passed. It does not prove the thing works.** Before
claiming any user-facing change is done, drive the **real, built, running artifact** and
observe the actual behaviour — don't infer "it works" from green types, green unit tests,
or a successful build.

This is the most expensive lesson of the web increments: the same failure shape — *"green
but blind"* — recurred 5+ times. Each time, a gate passed while the real artifact was
broken, and only driving the built thing caught it:

- `vite build` succeeded and unit tests passed, but `junction web` served a **completely
  unstyled page** (the server wasn't serving `/assets/*`). Caught by loading the page.
- `pnpm verify` was green, but the production **build was failing** — because `verify`
  didn't run `vite build`. The branch was non-building while reported "ready".
- Build + 107 tests + a screenshot all passed, but the SSR cookie read was **non-functional**
  (a fabricated global hidden by `as any`; an attribute no CSS consumed). Caught by `curl`ing
  the running server.
- A layout looked fine in a screenshot of an *empty* page, but had a **192px dead gap** in
  the real state. Caught by *measuring* the offset, not eyeballing.
- `quality` + `web-build` passed locally but **failed CI** (a build-ordering / threshold gap).

The throughline: unit tests and type-checks validate *pieces*; the defects lived in the
**gap between "pieces are correct" and "the assembled, running thing behaves correctly."**

## What this means in practice

1. **Close the gap in the cheap gate.** When a class of bug escapes to manual QA or CI, the
   fix is not "remember to check next time" — it's to make the local gate catch it. (Hence
   `pnpm verify:web` builds the web client + runs the smoke test, and the leak-check is a
   shared script CI and local both call, so they cannot diverge. `verify:web` runs for every
   web change and is the CI `web-build` job's contract — kept separate from the matrix
   `verify` only because the core build uses tsdown, which is broken on Node 20.)
2. **"Done" for a user-facing change requires driving the real artifact.** For web: build,
   serve, and assert against the running server (the `web:smoke` script) + the
   `junction-web-verify` skill for visual/interaction QA (theme, collapse-persistence,
   no-shake, reduced-motion) via `agent-browser`. Not `pnpm verify` alone.
3. **The orchestrator independently verifies — never trusts a builder's "verify green".**
   Builders this session repeatedly reported "ready" against a bar (`pnpm verify`) that
   structurally couldn't see the failure. The orchestrator's job is to run the real artifact
   itself and reconcile the result against the builder's claim.
4. **Beware gates that pass vacuously.** A `grep` over a missing directory, a test that
   seeds client state and never exercises the SSR path, an `as any` that blinds the
   type-checker — all "pass" while checking nothing. Add a **positive control** (assert a
   known-present marker IS found) so an empty result means "scanned and clean", never
   "scanned nothing".
5. **Measure, don't eyeball.** A screenshot of a forgiving state (empty list, default theme)
   hides defects. Assert concrete values (status codes, computed offsets, rendered
   attributes), and test the *unforgiving* states (populated, collapsed, dark, reduced-motion).

This behaviour is why each increment ends with a **reflection** (see the `junction-handover`
skill, step 9): the recurring traps get promoted into gates, skills, and docs so the system
gets harder to fool over time — that compounding is the point.
