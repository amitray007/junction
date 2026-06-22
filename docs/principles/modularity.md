# Modularity Principles

How junction stays modular without over-fragmenting. These govern where code lives and when a new package or module is justified.

## 1. Default to a core module, not a new package

Cross-cutting code goes in `@junction/core` as a **named module** by default. Every other package (`cli`, `web`, `mcp/server`, `mcp/client`) already depends on `core`, so a `core` module is automatically reachable everywhere — with zero new packages.

**Create a separate package ONLY when all of these hold:**
- (a) it is consumed by a package that may **not** depend on `core` (today: none — so this rarely triggers), **and**
- (b) it has a genuine independent reason to **version or publish**, **and**
- (c) it is cohesive and **namable by its single responsibility**.

Otherwise: it's a module in `core`. Default = core module.

## 2. No junk-drawer packages or modules

**Never create a `utils`, `common`, `shared`, `helpers`, or `lib` package or module.** If you cannot name it by its single responsibility, it is not a unit yet. A junk drawer accretes unrelated code, becomes a dependency magnet, and resists deletion.

Name by concern: `core/src/result/`, `core/src/errors/`, `core/src/paths/`, `core/src/schema/`, `core/src/ids/`, `core/src/logging/`. A reader should predict a module's contents from its name.

## 3. One-way dependency graph, no cycles

- `core` depends on nothing in the repo. `cli`/`web`/`mcp/server`/`mcp/client` may depend on `core`, never the reverse, never each other (unless a real, declared edge appears).
- **No circular dependencies** — at the package level *and* the module level inside `core`. A cycle means a missing layer or a misplaced responsibility. (`dependency-cruiser` enforces this, inc 1.5.)

## 4. Layer placement

Deepest → shallowest: **types/schema/errors/primitives** (depend on nothing) → **repositories/stores** (depend on schema + db) → **services/managers** (profile manager, credential store) → **edges** (cli/web/mcp, translate I/O ↔ core only). Logic lives in `core`; edges only translate.

## 5. Public API surface discipline

- **One public entry per package** via the `exports` map. No deep imports into another package's internals.
- Inside `core`, distinguish **public** (re-exported from `src/index.ts`) from **internal** (importable within `core`, never re-exported).
- **Narrow, curated barrels.** `core/src/index.ts` re-exports a deliberate public surface — **not** blanket `export *` (which leaks internals and defeats knip's dead-export detection). Per-module index files are fine.
- **Test helpers ship on a separate subpath** (`@junction/core/testing`), never the main barrel.

## 6. Derive types from one source

One source per shape: Zod `z.infer` at boundaries, Drizzle `$inferSelect` for persisted entities. Share types **through `core`**, never via a separate `@junction/types` package — you don't need one because everything depends on `core`.

---

Enforced by: `dependency-cruiser` (direction + cycles, inc 1.5), `knip` (dead exports/deps), the boundary-guard hook (pattern subset), and `junction-package-boundary` (review).
