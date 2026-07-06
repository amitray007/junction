// SPDX-License-Identifier: AGPL-3.0-only
// Pure mapping functions: integrations.sh `/api/{domain}/surface` payload ->
// a DRAFT junction AppCatalogEntry (increment 30.9). No fetch, no fs — every
// function here is a plain data transform so it is table-testable against
// the committed fixtures in __fixtures__/integrations-sh/ with zero network.
//
// See docs/methods/30.9-integrations-importer.md §2 for the mapping spec this
// file implements 1:1. Comments below cite the section they encode so the
// mapping stays traceable to its authority.

// ---------------------------------------------------------------------------
// §2a — app identity
// ---------------------------------------------------------------------------

/** domain -> a proposed fs-safe id. Reviewer-confirmable, never final. */
export function proposeAppId(domain) {
  const base = domain.replace(/^www\./, "").replace(/\.(com|io|dev|sh|org|net|co)$/, "")
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
}

/** A title-cased display name proposal from the payload's `name`/`domain`. */
export function proposeDisplayName(payload) {
  const source = payload.domain.replace(/^www\./, "").replace(/\.(com|io|dev|sh|org|net|co)$/, "")
  return source
    .split(/[-.]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

// ---------------------------------------------------------------------------
// §2b — credential type -> junction AppAuth.mode
// ---------------------------------------------------------------------------

/**
 * integrations.sh credential `type` -> junction CredentialKindForBuildSchema
 * (§2c "Map credential type->CredentialKind"). Distinct from credentialTypeToAppAuth
 * (AppAuth.mode) — this is the BUILD-recipe credential kind.
 */
export function credentialTypeToBuildKind(type) {
  switch (type) {
    case "oauth2":
      return "oauth2"
    case "bearer":
    case "jwt":
      return "bearer"
    case "api_key":
      return "api-key"
    default:
      return undefined
  }
}

/**
 * The FIRST resolved AppAuth mode -> a `build.credential.kind`, EXHAUSTIVELY
 * branched on `modes[0].mode` (fixes a no-fabrication bug a review caught:
 * a non-exhaustive `mode==="oauth2"?"oauth2":"bearer"` ternary silently
 * fabricated `{kind:"bearer"}` for a `"none"`-mode surface — i.e. a surface
 * with ZERO resolvable auth got a build recipe claiming a bearer credential
 * is required. `"none"` -> no build.credential at all (undefined); the
 * caller omits the field rather than invent one. `"byo"`/`"token"` -> bearer
 * (today's only non-oauth2 credential kind the importer maps — see
 * credentialTypeToAppAuth).
 */
export function firstAuthModeToBuildCredentialKind(mode) {
  switch (mode) {
    case "oauth2":
      return "oauth2"
    case "token":
    case "byo":
      return "bearer"
    case "none":
      return undefined
    default:
      return undefined
  }
}

/**
 * integrations.sh credential `type` -> junction AppAuth (§2b table). oauth2
 * ALWAYS emits the REVIEW placeholder — never a guessed providerId (the
 * inc-30 reverse-coverage guard depends on a correct providerId; a wrong one
 * dead-links the connect CTA).
 *
 * NOTE: this bare type->mode form returns the SAME placeholder string for
 * EVERY oauth2 credential — fine for a single-credential lookup, but NEVER
 * feed two DIFFERENT oauth2 credentials through this and then dedup the
 * results (dedupAppAuth would collapse them, exactly the M2 bug a review
 * caught — see credentialToAppAuth below, which is credential-ID-aware and
 * is what the surface/app-level auth-list builders actually use).
 */
export function credentialTypeToAppAuth(type) {
  switch (type) {
    case "oauth2":
      return { mode: "oauth2", providerId: "REVIEW:providerId" }
    case "bearer":
    case "api_key":
    case "jwt":
      return { mode: "token" }
    default:
      return undefined
  }
}

/**
 * credentialId + credential -> junction AppAuth, DISTINGUISHABLE per distinct
 * oauth2 credential (fixes a HIGH a review caught: `credentialTypeToAppAuth`
 * alone returns the IDENTICAL "REVIEW:providerId" placeholder for every
 * oauth2 credential, so `dedupAppAuth`'s (mode,providerId) key collapses TWO
 * real, distinct oauth2 credentials — e.g. github's OAuth-app + GitHub-App —
 * into one, silently losing a provider. That's the exact bug §2g-M2 exists to
 * prevent; the mode-alone dedup guard was never the whole fix without this).
 * The placeholder becomes `"REVIEW:providerId:<credentialId>"` — still a
 * REVIEW: sentinel (schema-valid string, reviewer-resolved), but now unique
 * per source credential, so dedup preserves one distinct entry per oauth2
 * credential instead of collapsing them.
 */
export function credentialToAppAuth(credentialId, credential) {
  if (credential.type === "oauth2") {
    return { mode: "oauth2", providerId: `REVIEW:providerId:${credentialId}` }
  }
  return credentialTypeToAppAuth(credential.type)
}

/**
 * Dedup a list of AppAuth by (mode, providerId) — NOT by mode alone (§2g M2).
 * github ships TWO oauth2 credentials (personal OAuth app + GitHub App); a
 * mode-only dedup would collapse them and silently drop a provider. This is
 * only NON-vacuous when its inputs already carry distinguishable providerIds
 * per distinct credential — see credentialToAppAuth above, which is what
 * feeds this in practice.
 */
export function dedupAppAuth(authList) {
  const seen = new Set()
  const out = []
  for (const auth of authList) {
    const key = auth.mode === "oauth2" ? `oauth2:${auth.providerId}` : auth.mode
    if (seen.has(key)) continue
    seen.add(key)
    out.push(auth)
  }
  return out
}

// ---------------------------------------------------------------------------
// §2f — the GH_PAT-class env-name transform (a hand-applied CONVENTION, not a
// schema gate — AppSurfaceConnectionSchema.cli has no denylist refine; the
// denylist lives on the different CliConnectionSchema and only bites at
// connect time, 30.11). The importer suggests the rename; it never writes a
// denied name into the load-bearing field, and never auto-writes the
// suggested rename either — both go through review.
// ---------------------------------------------------------------------------

const DENIED_ENV_SUFFIX = /_TOKEN$|_SECRET$|_KEY$/

/**
 * envName -> { mapped, denied, suggested } where:
 * - denied: true if envName matches the *_TOKEN/_SECRET/_KEY convention.
 * - suggested: a rename proposal (denied only) — e.g. GH_TOKEN -> GH_PAT.
 *   Only recognizes the GH_TOKEN case by name (the one precedent, 30.8); any
 *   other denied name gets a generic `<PREFIX>_CRED` suggestion — still just
 *   a suggestion, never auto-applied.
 */
export function transformCliEnvVar(envName) {
  const denied = DENIED_ENV_SUFFIX.test(envName)
  if (!denied) return { mapped: envName, denied: false, suggested: undefined }
  const suggested = envName === "GH_TOKEN" ? "GH_PAT" : envName.replace(DENIED_ENV_SUFFIX, "_CRED")
  return { mapped: envName, denied: true, suggested }
}

// ---------------------------------------------------------------------------
// §1b/§2c — mechanics tagged union (branch on `source`) + basis tagged union
// (branch on `via`) — trust tagging (§3a "facts" list entries).
// ---------------------------------------------------------------------------

/** mechanics (tagged on `source`) -> a short human-readable summary + trust facts. */
export function describeMechanics(mechanics) {
  switch (mechanics.source) {
    case "http":
      return {
        source: "http",
        in: mechanics.in,
        headerName: mechanics.headerName,
        scheme: mechanics.scheme,
      }
    case "cli":
      return { source: "cli", command: mechanics.command, env: mechanics.env }
    case "well-known":
      return { source: "well-known" }
    default:
      return { source: mechanics.source }
  }
}

/**
 * basis (tagged on `via`) -> a trust-tagged fact record for the review
 * artifact (§3a). `detected` = machine-verified (signal+verifiedAt);
 * `discovered` = LLM-guessed (evidence[] of source URLs).
 *
 * A missing `basis` (integrations.sh is a live third-party payload, not a
 * schema-checked one — a future response shape change could omit it) is
 * reported as an ATTRIBUTED fact rather than let `basis.via` throw a raw,
 * path-less TypeError: the review artifact still names which path is
 * untrustworthy, instead of crashing the whole import for one bad surface.
 */
export function basisToFact(path, basis) {
  if (!basis) {
    return {
      path,
      via: "discovered",
      evidence: [],
      note: "basis missing from payload — treated as untrusted",
    }
  }
  if (basis.via === "detected") {
    return { path, via: "detected", signal: basis.signal, verifiedAt: basis.verifiedAt }
  }
  return { path, via: "discovered", evidence: basis.evidence ?? [] }
}

// ---------------------------------------------------------------------------
// §2c — surfaces[].type -> junction AppSurface{kind, connection} (the crux)
// ---------------------------------------------------------------------------

/**
 * Maps one integrations.sh surface -> a junction AppSurface DRAFT, or a
 * `{skip: reason}` marker for a surface the importer cannot/should not map
 * (unrecognized type, or an mcp surface with neither url nor command — §2c).
 * Never invents a specUrl (openapi is NEVER emitted here — see mapHttpSurface).
 */
export function mapSurface(surface, credentialsById) {
  switch (surface.type) {
    case "mcp":
      return mapMcpSurface(surface, credentialsById)
    case "graphql":
      return mapGraphqlSurface(surface, credentialsById)
    case "cli":
      return mapCliSurface(surface, credentialsById)
    case "http":
      return mapHttpSurface(surface, credentialsById)
    default:
      return { skip: `unrecognized surface type "${surface.type}"` }
  }
}

function surfaceAuthModes(surface, credentialsById) {
  const modes = []
  const andComposed = []
  // The real header name from the payload's own http-mechanics entry (never
  // guessed) — the FIRST one observed for a token-mode credential, if any.
  let bearerHeaderName
  for (const entry of surface.auth?.entries ?? []) {
    const use = entry.use ?? []
    if (use.length > 1) {
      andComposed.push(use.map((u) => u.id))
    }
    for (const u of use) {
      const cred = credentialsById[u.id]
      if (!cred) continue
      // credentialToAppAuth (not the bare type-only form) — keeps distinct
      // oauth2 credentials distinguishable so dedupAppAuth doesn't collapse
      // two different providers into one (§2g M2, the vacuity a review caught).
      const auth = credentialToAppAuth(u.id, cred)
      if (auth) modes.push(auth)
      if (auth?.mode === "token" && u.mechanics?.source === "http" && !bearerHeaderName) {
        bearerHeaderName = u.mechanics.headerName
      }
    }
  }
  return { modes: dedupAppAuth(modes), andComposed, bearerHeaderName }
}

/**
 * Build the declarative `build` recipe block, EXHAUSTIVELY branching the
 * credential kind off `modes[0].mode` via firstAuthModeToBuildCredentialKind
 * — never a `mode==="oauth2"?"oauth2":"bearer"` ternary (that silently
 * fabricated a bearer credential for a zero-resolvable-auth, `"none"`-mode
 * surface — the bug a review caught). When the resolved kind is undefined
 * (the `"none"` case), `credential` is OMITTED from the recipe entirely
 * rather than defaulted to something the source data doesn't support.
 */
function buildRecipe(platformIdTemplate, via, modes) {
  const kind = firstAuthModeToBuildCredentialKind(modes[0].mode)
  return {
    platformIdTemplate,
    via,
    ...(kind ? { credential: { kind, from: "auth" } } : {}),
  }
}

function mapMcpSurface(surface, credentialsById) {
  const { modes, andComposed, bearerHeaderName } = surfaceAuthModes(surface, credentialsById)
  if (modes.length === 0) modes.push({ mode: "none" })

  // Branch on what the payload carries (doc-review I5) — NOT a degenerate
  // ternary. A url present -> http transport; a command/packages[] with NO
  // url -> stdio transport; neither -> skip + flag.
  let connection
  if (surface.url) {
    // A token-mode credential's real headerName from its own http mechanics
    // (never guessed/hardcoded) becomes the authHeader hint.
    connection = {
      kind: "mcp",
      transport: "http",
      url: surface.url,
      ...(bearerHeaderName ? { authHeader: bearerHeaderName } : {}),
    }
  } else if (surface.command) {
    connection = { kind: "mcp", transport: "stdio", command: surface.command }
  } else if (Array.isArray(surface.packages) && surface.packages.length > 0) {
    // A packages[]-declared MCP server (e.g. npx/docker) with no explicit
    // `command`: it IS a stdio surface, but the exact invocation (runner +
    // args) isn't given — emit a REVIEW-sentinel command derived from the
    // first package's identifier so the reviewer confirms the real command
    // rather than the importer guessing a runner (never fabricate an argv).
    const pkg = surface.packages[0]
    connection = {
      kind: "mcp",
      transport: "stdio",
      command: `REVIEW:command:${pkg.registryType ?? "package"}:${pkg.identifier ?? "unknown"}`,
    }
  } else {
    return {
      skip: "mcp surface has no url, command, or packages[] — cannot build a connection template",
    }
  }

  return {
    surface: {
      kind: "mcp",
      displayName: surface.name,
      connection,
      auth: modes,
      build: buildRecipe("{app}", "flattened", modes),
      verify: { kind: "mcp", listTools: true },
      docs: surface.docs,
    },
    andComposed,
  }
}

function mapGraphqlSurface(surface, credentialsById) {
  const { modes, andComposed } = surfaceAuthModes(surface, credentialsById)
  if (modes.length === 0) modes.push({ mode: "none" })
  // Symmetric with mapMcpSurface's url guard (a review caught the
  // asymmetry): a graphql surface with no url can't build a real
  // `endpoint` — skip + flag instead of emitting a connection with an
  // undefined endpoint that would only surface as a late, unexplained
  // schema error downstream.
  if (!surface.url) {
    return { skip: "graphql surface has no url — cannot build a connection template" }
  }
  return {
    surface: {
      kind: "graphql",
      displayName: surface.name,
      connection: { kind: "graphql", endpoint: surface.url },
      auth: modes,
      build: buildRecipe("{app}", "flattened", modes),
      verify: { kind: "graphql", typenameProbe: true },
      docs: surface.docs,
    },
    andComposed,
  }
}

function mapCliSurface(surface, credentialsById) {
  const { modes, andComposed } = surfaceAuthModes(surface, credentialsById)
  if (modes.length === 0) modes.push({ mode: "none" })

  // Find the first cli-mechanics `env[]` across auth entries (§2e/§2f) — the
  // importer proposes the FIRST env name as the primary credentialEnvVar.
  const notes = []
  let credentialEnvVar
  for (const entry of surface.auth?.entries ?? []) {
    for (const u of entry.use ?? []) {
      if (u.mechanics?.source === "cli" && u.mechanics.env?.length) {
        const [primary, ...rest] = u.mechanics.env
        const { mapped, denied, suggested } = transformCliEnvVar(primary)
        credentialEnvVar = denied ? undefined : mapped
        if (denied) {
          notes.push(
            `[REVIEW] env "${primary}" matches the *_TOKEN/_SECRET/_KEY convention — ` +
              `suggest renaming to "${suggested}" (see catalog/github/catalog.json:84 precedent). ` +
              "Not auto-applied — confirm before setting credentialEnvVar.",
          )
        } else {
          notes.push(`credentialEnvVar "${mapped}" taken from integrations.sh env[0] "${primary}".`)
        }
        if (rest.length > 0) {
          notes.push(`Additional env alias(es) observed, not mapped: ${rest.join(", ")}.`)
        }
        break
      }
    }
    if (credentialEnvVar !== undefined || notes.length > 0) break
  }

  return {
    surface: {
      kind: "cli",
      displayName: surface.name,
      connection: { kind: "cli", ...(credentialEnvVar ? { credentialEnvVar } : {}) },
      auth: modes,
      // Same exhaustive-branch discipline as mcp/graphql/http (buildRecipe) —
      // a cli surface with zero resolvable auth (mode:"none") gets no
      // fabricated credential either. CLI surfaces never carry oauth2 as
      // their build credential (they're PAT/env-based by convention, per the
      // github hand-authored precedent), so token/byo -> bearer as usual.
      build: buildRecipe("{app}", "descriptor", modes),
      verify: { kind: "none" },
      docs: surface.docs,
      notes: notes.length > 0 ? notes : undefined,
    },
    andComposed,
  }
}

/**
 * §2c openapi-vs-http rule: integrations.sh emits REST as type:"http" and has
 * NO reliable specUrl. The importer NEVER invents one — it ALWAYS proposes an
 * empty `http` surface here and flags "openapi spec available? -> upgrade"
 * for the reviewer. Upgrading http->openapi with a REAL spec is reviewer/
 * inc-30.9.5 work (apis.guru top-up), never this function's job.
 */
function mapHttpSurface(surface, credentialsById) {
  const { modes, andComposed } = surfaceAuthModes(surface, credentialsById)
  if (modes.length === 0) modes.push({ mode: "none" })
  // Symmetric with mapMcpSurface/mapGraphqlSurface's url guard: a http
  // surface with no url can't build a real `baseUrl` (AppSurfaceConnectionSchema's
  // http variant requires it) — skip + flag rather than emit an undefined baseUrl.
  if (!surface.url) {
    return { skip: "http surface has no url — cannot build a connection template" }
  }
  return {
    surface: {
      kind: "http",
      displayName: surface.name,
      connection: { kind: "http", baseUrl: surface.url },
      auth: modes,
      build: buildRecipe("{app}-http", "descriptor", modes),
      verify: { kind: "none" },
      docs: surface.docs,
      notes: [
        "[REVIEW] integrations.sh gives no reliable OpenAPI specUrl for this REST surface — " +
          "emitted as a gap-filler `http` surface (empty, no starterTools). If a real OpenAPI " +
          "spec exists for this API, upgrade this surface to `openapi` by hand (or via inc 30.9.5's " +
          "apis.guru top-up) — the importer never invents a specUrl.",
      ],
    },
    andComposed,
  }
}

// ---------------------------------------------------------------------------
// §2d — help.json fields
// ---------------------------------------------------------------------------

const REGISTRY_TO_COMMAND = {
  homebrew: (id) => `brew install ${id}`,
  apt: (id) => `apt install ${id}`,
  npm: (id) => `npm i -g ${id}`,
  yum: (id) => `yum install ${id}`,
}

/** cli surface packages[] -> help.install.commands (§2d). Unknown registryType -> skipped, noted. */
export function mapInstallCommands(cliSurface, appId) {
  const commands = {}
  const unmapped = []
  for (const pkg of cliSurface?.packages ?? []) {
    const fn = REGISTRY_TO_COMMAND[pkg.registryType]
    if (fn) {
      commands[pkg.registryType] = fn(pkg.identifier ?? appId)
    } else {
      unmapped.push(pkg.registryType)
    }
  }
  return { commands, unmapped }
}

/** cli mechanics -> help.authSetup (§2d) — `command` -> interactive, `env[]` -> env. */
export function mapAuthSetup(cliSurface) {
  const authSetup = {}
  for (const entry of cliSurface?.auth?.entries ?? []) {
    for (const u of entry.use ?? []) {
      if (u.mechanics?.source !== "cli") continue
      if (u.mechanics.command && !authSetup.interactive) authSetup.interactive = u.mechanics.command
      if (u.mechanics.env?.length && !authSetup.env) authSetup.env = u.mechanics.env[0]
    }
  }
  return Object.keys(authSetup).length > 0 ? authSetup : undefined
}

// ---------------------------------------------------------------------------
// §2g — edge cases
// ---------------------------------------------------------------------------

/** True if the payload has zero surfaces or zero MAPPED (non-skipped) surfaces. */
export function hasNoMappableSurfaces(mappedResults) {
  return mappedResults.every((r) => r.skip !== undefined)
}
