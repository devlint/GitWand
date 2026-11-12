import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // Same aliasing as .vitepress/config.ts: the site never builds
      // packages/core/dist, so tests must reach the TypeScript source too.
      '@gitwand/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
      // Shared with the CLI: the advent doors live in one module, bundled here for the browser.
      '@gitwand/advent': fileURLToPath(new URL('../packages/cli/src/advent/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['.vitepress/**/__tests__/**/*.test.ts'],
  },
})
