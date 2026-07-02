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
    environment: "jsdom",
    // Patch globalThis.localStorage to use the jsdom Storage implementation.
    // Node.js v25 ships a built-in `localStorage` stub that has no methods
    // (setItem/getItem/clear) unless --localstorage-file is supplied. Vitest's
    // jsdom environment does not override it, so we do so here.
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.ts"],
    globals: false,
    // Reset mock call counts/instances between each test so that
    // toHaveBeenCalledTimes() assertions are scoped to a single test.
    // Does NOT clear return values — each test's beforeEach sets those explicitly.
    clearMocks: true,
  },
});
