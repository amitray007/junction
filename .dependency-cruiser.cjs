/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "This dependency is part of a circular relationship between packages. " +
        "Revise the design (dependency inversion, single responsibility).",
      severity: "error",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      // Increment 7 (structural app-vs-lib model — closes the enumeration gaps the
      // inc-7 boundary review found). The topology:
      //   APPS (composition roots): cli (package name "junction"), web. May import any
      //     lib; must not import each other; nothing may import an app.
      //   LIBS: every package that is NOT an app — core, mcp/server, mcp/client, AND any
      //     package added later. A lib may import ONLY core (+ its own files).
      //
      // This rule is STRUCTURAL, not an enumeration: `from` = "any non-app package"
      // (so a future package is automatically a governed lib), `to` = "any in-repo
      // package except core and except the importer's own package". Therefore:
      //   - core → anything-in-repo (incl. a new package): BLOCKED (core is a lib whose
      //     only allowed target is core itself ⇒ core imports nothing in-repo).
      //   - mcp/server → mcp/client (and reverse), mcp/* → cli/web: BLOCKED (peer lib / app).
      //   - new-pkg → cli/web/mcp/*: BLOCKED (a new lib may only reach core).
      //   - any-lib → core, any-lib → its own internal files: ALLOWED.
      //   - apps (cli/web) are exempt as importers (from.pathNot) — they may import any lib.
      // The cli is reached by name "junction" via tsconfig.depcruise.json paths, so its
      // PATH packages/cli/ is what the regexes match.
      name: "libs-import-only-core",
      comment:
        "A lib (any package that is not an app: core, mcp/server, mcp/client, or any " +
        "future package) may import ONLY core and its own files — never an app (cli/web), " +
        "never a peer lib. Apps are exempt as importers (they are composition roots).",
      severity: "error",
      from: {
        // Capture the importer's package dir ($1), including nested mcp/<sub>.
        path: "^packages/(mcp/[^/]+|[^/]+)/",
        // Apps are NOT libs — exempt them as importers.
        pathNot: "^packages/(cli|web)/",
      },
      to: {
        path: "^packages/",
        // Allow importing core and the importer's own package; block everything else.
        pathNot: "^packages/core/|^packages/$1/",
      },
    },
    {
      // Apps (cli, web) are composition roots — they may import any lib but NOT each
      // other. One rule covers both directions: $1 captures the importing app, and
      // to.pathNot excludes only the importer's own package, so cli→web and web→cli
      // are both blocked while cli→cli / web→web (intra) stay allowed.
      name: "apps-dont-import-apps",
      comment:
        "Apps (cli, web) are composition roots — they may import any lib but must not " +
        "import each other.",
      severity: "error",
      from: {
        path: "^packages/(cli|web)/",
      },
      to: {
        path: "^packages/(cli|web)/",
        pathNot: "^packages/$1/",
      },
    },
    {
      // Fix #3: the original rule used ^packages/([^/]+)/src/ for both from and to,
      // which failed to match nested packages like packages/mcp/server/src/ because
      // [^/]+ stops at the first slash (capturing only "mcp", not "mcp/server").
      // The updated pattern (mcp/[^/]+|[^/]+) matches both nested mcp sub-packages
      // and top-level flat packages, so deep imports into mcp/server or mcp/client
      // internals are now caught.
      //
      // The pathNot uses alternation to exclude three cases:
      //   - ^packages/$1/src/ : intra-package imports (same package, always OK)
      //   - /src/index\\.ts$  : imports to another package's top-level entry point
      //     (e.g. packages/core/src/index.ts reached via "@junction/core" tsconfig paths)
      //     These are legitimate; direction enforcement is handled by the boundary rules above.
      //   - /src/testing/index\\.ts$ : the ONE sanctioned subpath export convention
      //     (e.g. packages/core/src/testing/index.ts via "@junction/core/testing";
      //     docs/principles/modularity.md §5 — test helpers ship on a ./testing subpath).
      // NOTE: this deliberately does NOT allow /src/<any-module>/index.ts — importing
      // an internal module like core/src/config/index.ts must stay BLOCKED so consumers
      // use the curated public barrel, not internals. If a package adds a NEW public
      // subpath export, add it here explicitly (mirroring its package.json "exports").
      name: "no-deep-src-imports",
      comment:
        "Do not deep-import into another package's src/ internals — use the package entry point.",
      severity: "error",
      from: {
        path: "^packages/(mcp/[^/]+|[^/]+)/",
      },
      to: {
        path: "^packages/(mcp/[^/]+|[^/]+)/src/",
        pathNot: "^packages/$1/src/|/src/index\\.ts$|/src/testing/index\\.ts$",
      },
    },
    {
      name: "no-orphans",
      comment: "This module is not referenced by anything. Either use it or remove it.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$|\\.d\\.(c|m)?ts$|(^|/)tsconfig\\.json$",
      },
      to: {},
    },
  ],

  options: {
    // Which modules NOT to follow when encountered
    doNotFollow: {
      path: "(node_modules|dist|build)",
    },

    // Exclude paths from being scanned
    exclude: {
      path: "(node_modules|dist|build|\\.d\\.ts$)",
    },

    // ROOT CAUSE FIX (#1): the original config used
    //   enhancedResolveOptions.exportsFields: ["exports"]
    // which resolved "@junction/core" (and other package-name imports) through
    // each package's exports map to "./dist/index.js". The exclude.path rule
    // (which drops "dist") then silently stripped those edges before any rule
    // could evaluate — making ALL cross-package imports via package names invisible.
    //
    // Fix: tsconfig.depcruise.json adds compilerOptions.paths that map every
    // "@junction/X" specifier to "packages/X/src/index.ts". Depcruise resolves
    // these via the tsConfig paths (not the exports map), so cross-package edges
    // land on packages/pkg/src/index.ts paths that survive the exclude filter
    // and are visible to the forbidden rules.
    //
    // We also remove exportsFields from enhancedResolveOptions so enhanced-resolve
    // does not re-resolve the already-mapped specifier through package.json exports
    // back to dist.
    tsConfig: {
      fileName: "tsconfig.depcruise.json",
    },

    // We're using ES modules
    externalModuleResolutionStrategy: "node_modules",

    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
      archi: {
        collapsePattern: "^(packages/[^/]+/[^/]+|packages/[^/]+)/src/[^/]+/",
      },
      text: {
        highlightFocused: true,
      },
    },
  },
}
