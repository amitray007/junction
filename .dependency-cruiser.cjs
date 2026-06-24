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
      name: "no-core-importing-edges",
      comment:
        "packages/core must not import from cli, web, or mcp — it is the dependency-free core.",
      severity: "error",
      from: {
        path: "^packages/core/",
      },
      to: {
        path: "^packages/(cli|web|mcp)/",
      },
    },
    {
      // Fix #2: the original rule used ^packages/(cli|web|mcp)/ which captured
      // only "mcp" for both packages/mcp/server/ and packages/mcp/client/, so
      // pathNot "^packages/$1/" (= "^packages/mcp/") matched both sub-packages
      // and let server<->client cross-imports slip through.
      // Now each nested package is a distinct arm in the alternation so $1
      // resolves to "mcp/server" or "mcp/client" and pathNot correctly excludes
      // only intra-package edges.
      name: "no-cross-edge-imports",
      comment:
        "cli, web, mcp/server, and mcp/client are peer edges — they must not import each other. " +
        "Each is matched as a full path segment so mcp/server and mcp/client are distinct peers.",
      severity: "error",
      from: {
        path: "^packages/(cli|web|mcp/server|mcp/client)/",
      },
      to: {
        path: "^packages/(cli|web|mcp/server|mcp/client)/",
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
      //     These are legitimate; no-cross-edge-imports handles direction enforcement.
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
