# Security Policy

Junction handles user credentials. Security reports are treated as high priority.

---

## Reporting a vulnerability

**Use [GitHub Private Security Advisories](https://github.com/amitray007/junction/security/advisories/new)
as the primary channel.** Private advisories keep the report confidential while it is being
investigated and patched — do not open a public issue for a security vulnerability.

If you cannot use GitHub advisories, contact **hey@amitray.dev** as a fallback. Include
enough detail to reproduce the issue. For sensitive reproduction details, **ask for an
encrypted channel (PGP key / age recipient) before sending** — don't send credential-exposure
repro steps over cleartext email.

> Private Security Advisories require the repository to be public; once junction is public,
> the advisory link above is the primary channel. While the repo is private, use the email
> fallback.

**CRITICAL — never paste real credentials, tokens, or secrets:**
When writing a report (in an advisory, an issue, a PR, or any other channel), **redact all
real credentials, tokens, API keys, and secrets before submitting.** Use placeholders like
`<REDACTED>` or `MY_SECRET_HERE`. Junction's whole purpose is credential handling — a
credential accidentally pasted into a public or semi-public venue is itself a security
incident.

---

## Scope

**In scope:**

- The junction broker process and its configuration handling
- The credential layer (storage, encryption, keyring integration, memory handling)
- The sandbox (Deno subprocess, bubblewrap/Seatbelt isolation)
- MCP server endpoints and per-profile routing
- Anything that could allow credential plaintext to escape the process or reach disk/logs

**Out of scope:**

- Third-party MCP servers that junction connects to (report those to their maintainers)
- Vulnerabilities in the host OS, Node.js runtime, or hardware
- Social engineering or phishing

---

## Supported versions

Pre-1.0: only the `main` branch is supported. There are no patched back-ports to older
commits during the foundation phase.

---

## Response expectations

- Acknowledgement within **5 business days** of receipt.
- Coordinated disclosure: we will work with you on a patch and agree on a disclosure
  timeline before any public announcement. We ask that you do the same — do not disclose
  publicly until a fix is available and we have agreed on a date.
- Credit in the release notes if you want it.
