import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclure :
    // - les fichiers .bench.ts du run normal (vitest run / vitest watch).
    //   Ils sont lancés séparément via : npx vitest bench
    // - **/dist/** : on ne veut pas que vitest charge les .test.js compilés
    //   d'un build pré-v2.1 qui traîne. Vitest transforme directement les .ts
    //   sources via esbuild — le dist n'apporte rien aux tests, et un dist
    //   périmé peut causer des faux positifs (ex: un test qui appelle lcs()
    //   et a été compilé avant le passage de lcs() à Histogram).
    exclude: [
      "**/*.bench.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
