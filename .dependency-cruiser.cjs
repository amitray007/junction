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
      // Increment 7: app-vs-lib boundary model.
      //
      // APPS (composition roots): cli, web.
      //   Apps may import any lib (core, mcp/server, mcp/client).
      //   Apps are leaves — nothing may import an app.
      //   Apps must NOT import each other.
      //
      // LIBS: core, mcp/server, mcp/client.
      //   core: imports nothing in-repo (no-core-importing-edges above).
      //   mcp/server, mcp/client: import ONLY core — never each other, never an app.
      //
      // This rule (no-lib-importing-non-core):
      //   Forbids mcp/server and mcp/client from importing any in-repo package
      //   except core. Blocks: mcp-server→cli, mcp-server→web, mcp-server→mcp-client,
      //   mcp-client→cli, mcp-client→web, mcp-client→mcp-server.
      //   The no-core-importing-edges rule already handles core→anything.
      name: "no-lib-importing-non-core",
      comment:
        "Lib packages (mcp/server, mcp/client) may only import core within the repo — " +
        "never an app (cli/web) and never a peer lib (mcp/client↔mcp/server). " +
        "Intra-package imports (within the same mcp/server or mcp/client) are always allowed.",
      severity: "error",
      from: {
        path: "^packages/(mcp/server|mcp/client)/",
      },
      to: {
        // Target: any in-repo package except core AND except the same lib package itself.
        // pathNot excludes:
        //   - ^packages/core/             : core imports are always OK for libs
        //   - ^packages/$1/               : intra-package (mcp/server→mcp/server, etc.)
        path: "^packages/",
        pathNot: "^packages/core/|^packages/$1/",
      },
    },
    {
      // Forbids apps from importing each other (cli→web, web→cli).
      // cli and web may both import any lib (core, mcp/server, mcp/client).
      name: "no-app-cross-imports",
      comment:
        "Apps (cli, web) are composition roots — they must not import each other. " +
        "Each app may import any lib (core, mcp/server, mcp/client).",
      severity: "error",
      from: {
        path: "^packages/cli/",
      },
      to: {
        path: "^packages/web/",
      },
    },
    {
      name: "no-app-cross-imports-web-to-cli",
      comment: "Apps (cli, web) are composition roots — they must not import each other.",
      severity: "error",
      from: {
        path: "^packages/web/",
      },
      to: {
        path: "^packages/cli/",
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
