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
      // Point directly at the TypeScript source so Vite never needs a
      // pre-built dist/ for @gitwand/core during development or CI.
      // Production builds go through the same alias, so no separate
      // `pnpm --filter @gitwand/core build` step is required.
      "@gitwand/core": resolve(__dirname, "../../packages/core/src/index.ts"),
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
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
