# Licensing Rules

## SPDX header policy

Every source file in the junction codebase **must** carry an SPDX license identifier as its
first meaningful line:

```
// SPDX-License-Identifier: AGPL-3.0-only
```

Rules:

- One line, no block comment, no boilerplate header beyond the SPDX line.
- `AGPL-3.0-only` — the specific version. Not `AGPL-3.0-or-later`, not `GPL`, not unversioned.
- Applies to all `.ts`, `.js`, `.mjs`, `.cjs`, and `.tsx` source files in `packages/`.
  Config files and generated files are exempt.

**Enforcement is deferred** to the security increment via
[`fsfe/reuse-action`](https://github.com/fsfe/reuse-action). Bulk insertion will be done
by tooling at that increment, not by hand. Do not block PRs on missing headers before
enforcement is wired — but do add the header to new files you author from now on.

---

## AGPL §13 product requirement

AGPL-3.0 §13 extends the copyleft obligation to network use: if a modified junction is run
as a service that users interact with over a network, the operator must offer the
Corresponding Source to those users.

**This is a product requirement for the broker increment:**

- The running broker must embed its git commit hash or version string at build time.
- It must surface a source link to network users — in `--version` output, the MCP
  `server-info` response, or a startup log line.
- Example (startup log): `junction broker v0.1.0 (commit abc1234) — source: https://github.com/amitray007/junction`

This requirement is recorded here so it is not forgotten when the broker increment is
designed. The broker method file must include it as a proof-of-done item.

---

## Cross-references

- [`docs/rules/security.md`](./security.md) — credential plaintext rules (the other
  non-negotiable compliance layer alongside license headers).
- [`docs/rules/README.md`](./README.md) — how all rules are enforced (hook → verify → review).
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — the no-CLA / inbound=outbound AGPL stance.
- [`LICENSE`](../../LICENSE) — the AGPL-3.0-only license text.
