/**
 * Lazy, memoized loader for the `@gitwand/core` conflict-resolution engine.
 *
 * `@gitwand/core`'s heavy exports (`resolve`, `resolveAsync`, and everything
 * they pull in transitively: `classifier.ts`, `patterns/` ~1443 lines,
 * `resolver/` ~1511 lines, `structural/` ~965 lines, `refactoring/` ~1184
 * lines, `resolvers/` ~5406 lines) used to be imported statically from
 * `useGitWand.ts` and `useMergePreview.ts`. Because both composables sit on
 * an eager path (`App.vue` → `useGitWand`; `AppHeader.vue` →
 * `BranchSelector.vue` → `useMergePreview`), that static import put the
 * entire engine — ~244 KB raw / ~73 KB gzip — in the boot chunk, parsed and
 * JIT-compiled on every app start even when the user never opens a conflict.
 *
 * `engine()` defers that cost to the first actual resolution call and
 * memoizes the module so repeat calls don't re-trigger the dynamic import.
 * Light, self-contained exports (`parseGitwandrc` from `config.ts`,
 * `summarizeTiers` from `stats/tiers.ts`, `extractImportSources` from
 * `resolvers/imports.ts` — all zero-dependency leaf modules) stay statically
 * imported at their call sites; only the exports that transitively require
 * the classifier + pattern registry go through this loader.
 */
let _engine: typeof import("@gitwand/core") | null = null;

export async function engine(): Promise<typeof import("@gitwand/core")> {
  return (_engine ??= await import("@gitwand/core"));
}
