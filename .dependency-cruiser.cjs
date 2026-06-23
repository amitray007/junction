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
      name: "no-cross-edge-imports",
      comment:
        "cli, web, and mcp packages must not import each other — they are peer edges that only depend on core.",
      severity: "error",
      from: {
        path: "^packages/(cli|web|mcp)/",
      },
      to: {
        path: "^packages/(cli|web|mcp)/",
        pathNot: "^packages/$1/",
      },
    },
    {
      name: "no-deep-src-imports",
      comment:
        "Do not deep-import into another package's src/ internals — use the package entry point.",
      severity: "error",
      from: {
        path: "^packages/([^/]+)/",
      },
      to: {
        path: "^packages/([^/]+)/src/",
        pathNot: "^packages/$1/src/",
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
    /* Which modules NOT to follow when encountered */
    doNotFollow: {
      path: "(node_modules|dist|build)",
    },

    /* Exclude paths from being scanned */
    exclude: {
      path: "(node_modules|dist|build|\\.d\\.ts$)",
    },

    /* Use TypeScript config for module resolution */
    tsConfig: {
      fileName: "tsconfig.base.json",
    },

    /* Resolve to the tsconfig that is closest to the cruised module */
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },

    /* We're using ES modules */
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
