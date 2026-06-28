---
name: junction-web-verify
description: Drive the real, built, running @junction/web server to verify it actually works — not just that types/tests/build passed. Use at the QA step of any web increment, and before accepting a builder's "done" on web work. Catches the "green but blind" class of bug (unstyled build, dead SSR cookie, leaked secrets, layout desync, theme/motion regressions).
---

# Junction Web Verify

The web increments taught us "green but blind" the hard way (see
`docs/behaviours/verify-the-artifact.md`): `pnpm verify`, unit tests, and even a screenshot
can all pass while the real running app is broken. This skill is the repeatable version of
the manual QA that caught every such defect — run it instead of hand-curling each time.

## Two layers: automated smoke (always) + browser QA (when UI changed)

### 1. Automated smoke — deterministic, no browser

Built into the gate now, but run standalone any time:

```bash
pnpm --filter @junction/core build      # web imports core server-side
pnpm --filter @junction/web build       # the production build (verify alone does NOT do this)
pnpm run web:leakcheck                   # server-only-core boundary: existence + negative + positive control
pnpm run web:smoke                       # boots serve.mjs, asserts the RUNNING server's responses
```

`web:smoke` (`scripts/web-smoke.mjs`) asserts, against the real server: home returns 200 with
a linked stylesheet that itself serves 200 `text/css` (B0 unstyled-build); `Cookie:
junction-sidebar=collapsed` → SSR renders `data-sidebar="collapsed"` (the SSR cookie bug);
no `secretRef`/server-only strings in the SSR HTML; every route renders without a 500. These
are the exact failures that escaped to manual QA in inc 23. **All of this runs inside
`pnpm verify`** now, so a broken artifact fails the local gate — but run it directly when
iterating so you don't wait for the full gate.

### 2. Browser QA — visual + interaction (use `agent-browser`)

For anything the smoke test can't assert from HTML (theme, collapse persistence, no-shake
nav, reduced-motion, populated tables, focus rings). Use the **`agent-browser`** CLI
(`/opt/homebrew/bin/agent-browser`; `agent-browser -h`, and `agent-browser skills get core
--full` for patterns). Seed a throwaway home with realistic data first so you see populated
states, not just empty ones.

```bash
# build + seed (see junction-dev for the seed commands), then serve:
JUNCTION_HOME=/tmp/jtest PORT=4321 node packages/web/serve.mjs &

agent-browser open http://127.0.0.1:4321
agent-browser screenshot /private/tmp/jt-light.png
agent-browser set media dark                 # check dark theme
agent-browser screenshot /private/tmp/jt-dark.png
# sidebar collapse persists across reload (the SSR/cookie no-flash invariant):
agent-browser eval "document.cookie='junction-sidebar=collapsed;path=/'" && agent-browser reload
agent-browser get attr data-sidebar html     # → "collapsed"
# content margin tracks the sidebar (no dead gap):
agent-browser eval "getComputedStyle(document.getElementById('shell-main')).marginLeft"
# reduced-motion respected:
agent-browser set media reduced-motion
agent-browser close
```

**What to verify (the inc-23 checklist):** styled in light AND dark; sidebar collapse via
Cmd/Ctrl+B persists across reload with no flash; content margin moves with the sidebar (no
gap); theme toggle cycles + persists; tables populated (seed data) with `Configured` badges;
no shake navigating between routes; amber focus rings on keyboard nav; and the anti-AI-slop
check (one accent, lucide not emoji, no gradients/glassmorphism — see `docs/design/anti-ai-slop.md`).

## When to run

- The QA step of any web increment, **before** the review gate.
- Before accepting a builder's "done" on web work — the orchestrator verifies independently
  (`docs/behaviours/verify-the-artifact.md`). A builder's "verify green" is not sufficient
  for user-facing web changes.
- After any change to `serve.mjs`, SSR/route files, the design tokens, or the shell.

## Notes

- `pnpm verify` now runs the build + leakcheck + smoke (via `verify:web`), so it is slower
  than before — that is deliberate; the production build break must be caught locally.
- `agent-browser` can also do `diff screenshot --baseline` for visual regression once a
  baseline is captured. Consider that when the UI stabilises.
- This skill grows: add new assertions to `web:smoke` whenever a new "green but blind" class
  is found (that promotion is the point — see the handover reflection step).
