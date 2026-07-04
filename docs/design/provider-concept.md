# Provider as a first-class concept (deferred rethink)

**Status:** captured for revisit, NOT decided. Raised by the user mid-inc-29 (2026-07-03) while dogfooding the OAuth connect flow. Revisit after the inc-29 follow-up batch, before or alongside inc 30.

## The observation that prompted it

While connecting GitHub then Google via OAuth, the user noticed the model mixes two ideas that arguably shouldn't be mixed:

- **Credentials** are meant to be a *generic* auth mechanism — "here is a secret / token / OAuth grant," with **no pre-defined service knowledge**.
- But inc-29's OAuth work put a **pre-defined provider catalog** (google/github/slack/microsoft/notion/atlassian/…) *inside* the credential/OAuth layer (`packages/core/src/oauth/catalog.ts`). So "create an OAuth credential" is entangled with "which pre-defined service is this."

The user's framing: *"I think we shouldn't have added pre-defined providers into Credentials. We could build a separate concept — **Providers** — that acts like a plugin system: you plug in a Provider (google, github, slack, …), it sets up a few things (which platform kind, the client-id/secret details), and done. Credentials should stay generic, with no pre-defined services baked in."*

## The idea, sharpened

A **Provider** is a first-class, plugin-shaped entity that bundles the *pre-defined knowledge* about a service:

- **What it is** — google, github, slack, etc. (the catalog entry: authorize/token/userinfo URLs, PKCE, scope separator, refresh support, device support, the divergence-as-data quirks).
- **How you set it up** — "plug it in": pick the target **platform kind** (MCP / OpenAPI / GraphQL / CLI — the OAuth token is protocol-agnostic; see below), enter your **BYO client_id / client_secret**, choose scopes. Done.
- **What it yields** — connecting a Provider *produces* a generic **Credential** (the oauth2 kind, with its refs) attached to a **Platform**. The Credential stays generic; the Provider is the thing that knew how to mint it.

This cleanly separates:
- **Provider** = pre-defined service plugin (catalog knowledge + guided setup). A finite, curated (+ user-extensible "generic") set.
- **Credential** = the generic auth artifact it produces (no service knowledge; just refs + kind).
- **Platform** = the source junction speaks to (the protocol: MCP/OpenAPI/GraphQL/CLI).

## Why it's more than cosmetic — the orthogonality it would surface

Inc-29 already established (and the user worked out live) that **credential kind and platform kind are orthogonal**:

- **credential kind** (oauth2 / bearer / api-key / env / file) = *how you authenticate*.
- **platform kind** (mcp / openapi / graphql / cli) = *the protocol junction speaks*.

An OAuth token is **not** MCP-bound — the same token works across MCP / OpenAPI / GraphQL (HTTP bearer) and CLI (env-var). The current UI can make it *look* like "OAuth ⇒ MCP platform," which is wrong. A first-class Provider concept would make the orthogonality legible: *"connect the google Provider, choose which Platform (protocol) it feeds."*

## Open questions to resolve before building

1. **Is it worth a new top-level entity + nav surface**, or is it better expressed as a *view/mode* over the existing Platform+Credential model (a "Connect a service" flow that's really guided Platform-add + OAuth-connect)? The plugin framing is attractive but the entity might be a UI concept, not a new DB table.
2. **Plugin extensibility** — how far does "plugin" go? Just the curated catalog + a generic escape hatch (today), or user-authored provider definitions (a real plugin loader)? The latter is a much bigger commitment (trust, validation, loading).
3. **Migration** — the catalog already lives in `core/oauth/catalog.ts` and works. Does promoting Provider to first-class require moving it, or just re-presenting it? Prefer re-presenting (no churn to a shipped, dogfooded layer) unless the entity earns a table.
4. **Naming collision risk** — "Provider" is already used loosely in code (`ToolProvider`, `buildProvider`, `getProvider` for the OAuth catalog). A first-class user-facing "Provider" concept needs a disambiguation pass.

## Recommendation (for when this is revisited)

Lean toward expressing Provider as a **guided "Connect a service" flow + a clearer information architecture** that makes the credential-kind ⊥ platform-kind orthogonality legible — **before** committing to a new first-class DB entity or a plugin loader. The catalog is the Provider knowledge; it already exists and is proven. Promote the *concept* in the UX first; only add the *entity* if a concrete need (user-authored providers, cross-platform Provider reuse) makes the table earn its cost. Hold the decision loosely — this is a genuine architecture call to make with the user, with trade-offs, not a foregone conclusion.

*(Trigger + one-line pointer also recorded in `docs/futures/revisit-when.md`.)*
