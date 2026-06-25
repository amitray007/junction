# Deprecations we knowingly depend on

Dependencies / OS APIs junction uses **today** that are deprecated or at end-of-life risk, each with the **forward path** we'll take when it comes due. We accept these consciously — the entry exists so the acceptance is *recorded and revisitable*, not silent.

---

## macOS Seatbelt — `sandbox-exec` (in use since increment 8)

**What:** the macOS command-line sandbox backend (`/usr/bin/sandbox-exec` + SBPL `(version 1)` profiles) used by `Sandbox.runCommand` to confine native CLIs at the kernel MAC layer.

**Deprecation:** Apple marks `sandbox-exec` **DEPRECATED** in its own man page. Critically, Apple offers **no supported replacement for confining an arbitrary child process** — the blessed alternative (App Sandbox via the `com.apple.security.app-sandbox` entitlement) only sandboxes *your own signed app bundle*, not an on-the-fly CLI. This is why the reference implementations (Claude Code, Codex, Chromium) all still use `sandbox-exec` despite the deprecation — nothing better exists on macOS without kernel extensions. There is an open, unanswered request on Apple's own `containerization` repo asking for a replacement + timeline.

**Why we accept it:** it is the only working way to confine native binaries on macOS today, and it's what the entire ecosystem ships. The deprecation is documented honestly in `docs/rules/security.md`, not hidden.

**Forward path:** **microVMs.** Apple's **Containerization framework** (`Virtualization.framework`, a micro-kernel per workload, WWDC 2025) on macOS, and cross-platform **libkrun / microsandbox** (`Hypervisor.framework` on Apple Silicon, KVM on Linux). junction's `Sandbox` interface is deliberately shaped so a **microVM backend drops in behind the same `runCommand` / `runScript`** — first as the escalation tier (hostile code), then as the Seatbelt replacement if Apple ever removes `sandbox-exec`. The Linux side (`bubblewrap`) has no equivalent deprecation pressure.

---

## isolated-vm — maintenance mode (avoided; not in use)

**What:** a V8-isolate JS sandbox sometimes used for in-process untrusted-code execution.

**Status:** maintenance-mode upstream. junction does **not** use it — JS/TS isolation goes through the **Deno subprocess** capability boundary instead (cross-platform, actively maintained, not deprecated). isolated-vm is listed in the spec's banned/last-resort set: avoid unless Deno + bubblewrap ever become impractical. Recorded here so the "why not isolated-vm" answer is durable.

---

## Reference: permanently banned (dead / insecure — never adopt)

Not "deprecations we depend on", but recorded so they're never reconsidered: `node:vm` / `vm2` (CVSS-10 RCEs — never a security boundary), `keytar` (unmaintained → `@napi-rs/keyring`), `ts-prune` (→ knip), `tsup`/legacy bundlers in favor of `tsdown`, `Million.js`/Lint (→ React Compiler), legacy `inquirer` (→ `@clack/prompts`), Jest (→ Vitest), `oclif` (→ citty), Lucia (→ better-auth, web-login only), `conf` as a primary store, Effect-TS as the error model (→ neverthrow; see `revisit-when.md` for the narrow exception). just-bash is allowed **only** as a convenience VFS, **never** as an isolation boundary.
