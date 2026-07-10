// SPDX-License-Identifier: AGPL-3.0-only
// Hand-written ambient types for serve.mjs (a committed .mjs source file, not
// build output). REQUIRED: without this, `pnpm --filter @junction/web
// typecheck` fails with TS7016 — the web tsconfig has strict + no allowJs and
// typechecks its src test files, and packages/web/src/server/serve-static.test.ts
// imports "../../serve.mjs" directly. Do NOT enable allowJs instead — committed
// .js/.mjs files under src/ would then enter the typecheck's checking scope.

export declare function resolveStaticFile(
  reqPath: string,
  baseDir?: string,
): Promise<{ filePath: string; contentType: string } | null>

export declare function main(): Promise<void>
