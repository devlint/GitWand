import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclure les fichiers .bench.ts du run normal (vitest run / vitest watch)
    // Ils sont lancés séparément via : npx vitest bench
    exclude: ["**/*.bench.ts", "**/node_modules/**"],
  },
});
