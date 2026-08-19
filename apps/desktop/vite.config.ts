/// <reference types="vitest" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ESM-safe replacement for `__dirname`. Required under Vite 6 +
// `"type": "module"` in package.json: Vite 5 silently polyfilled
// `__dirname` when compiling the config to `.mjs`; Vite 6 dropped that
// shim, so `__dirname` throws `ReferenceError: __dirname is not defined`.
const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8"),
);

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // Mirrors the "@/*" -> "./src/*" mapping in tsconfig.json so runtime
      // imports (Vite/Vitest) resolve the same "@/..." paths that
      // TypeScript already type-checks.
      "@": resolve(__dirname, "src"),
      // Point directly at the TypeScript source so Vite never needs a
      // pre-built dist/ for @gitwand/core during development or CI.
      // Production builds go through the same alias, so no separate
      // `pnpm --filter @gitwand/core build` step is required.
      "@gitwand/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      // Force web-tree-sitter to resolve to the version installed in apps/desktop
      // (0.26.x). packages/core pins an older ~0.20.x version, but copy-grammars.mjs
      // copies the WASM runtime from the 0.26.x build. Bundling mismatched JS (0.20.x)
      // with the 0.26.x WASM causes a LinkError: _abort_js is not a Function.
      "web-tree-sitter": resolve(__dirname, "node_modules/web-tree-sitter"),
    },
  },
  define: {
    // Injected at build time from package.json — use as __APP_VERSION__ anywhere in the app.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // safari14 is the first Safari with BigInt literal support (needed
    // by smol-toml, pulled in transitively by v1.5.0 post-merge TOML
    // validation). Tauri 2 recommends macOS 11+ which ships Safari 14+.
    target: ["es2021", "chrome100", "safari14"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // Emits dist/.vite/manifest.json, which perf/bundle-check.mjs reads to
    // find the real entry chunk for index.html. Do NOT remove: bundle-check
    // hard-fails without it. Before this flag, the main chunk was guessed
    // by a `/^index-[a-z0-9_-]+\.js$/i` name match + size sort, which would
    // silently measure the wrong file if a vendor chunk ever outgrew it
    // (see docs/superpowers/specs/2026-08-18-dev-loop-ci-build-times-plan.md
    // §0.3 item 13).
    manifest: true,
    rollupOptions: {
      // Mark Node.js built-ins as external so Rollup can analyse
      // packages/core's node adapter (structural/parsers/adapters/node.ts)
      // without erroring.  The adapter is only reached when env === "node",
      // which never happens inside the Tauri webview — the desktop app always
      // passes a customLoader that short-circuits env detection entirely.
      external: (id: string) => id.startsWith("node:"),
    },
  },
  test: {
    // Default to "node": jsdom setup/teardown costs ~1s/file (measured:
    // 95.85s cumulative "environment" time across 94 files vs 19.85s of
    // actual test execution — see docs/superpowers/specs/
    // 2026-08-18-dev-loop-ci-build-times-plan.md §3.1). Only the handful of
    // files that actually touch document/window/HTMLElement opt back into
    // jsdom via a `// @vitest-environment jsdom` docblock at the top of the
    // file.
    environment: "node",
    // src/test-setup.ts installs an in-memory Storage shim (see that file)
    // so that files relying on localStorage/sessionStorage keep working
    // under the "node" environment without needing jsdom.
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.ts"],
    globals: false,
    // Reset mock call counts/instances between each test so that
    // toHaveBeenCalledTimes() assertions are scoped to a single test.
    // Does NOT clear return values — each test's beforeEach sets those explicitly.
    clearMocks: true,
  },
});
