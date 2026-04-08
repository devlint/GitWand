# Contributing to GitWand

First off, thanks for considering contributing to GitWand! Every contribution helps make Git conflict resolution better for everyone.

## Getting started

```bash
git clone https://github.com/devlint/GitWand.git
cd GitWand
pnpm install
pnpm build
pnpm test
```

Requires Node.js 18+ and pnpm 9+.

## Project structure

```
packages/core/     → Resolution engine (the brains)
packages/cli/      → CLI wrapper
packages/vscode/   → VS Code extension (WIP)
apps/desktop/      → Standalone app with Tauri + Vue 3
```

## How to contribute

### Reporting bugs

Open an issue with a minimal reproduction. If you can include the conflicted file content (with markers), that's ideal — it can become a test fixture.

### Adding a new resolution pattern

1. Add the pattern type to `ConflictType` in `packages/core/src/types.ts`
2. Add detection logic in `classifyConflict()` in `packages/core/src/parser.ts`
3. Add resolution logic in `resolveHunk()` in `packages/core/src/resolver.ts`
4. Add test fixtures and tests in `packages/core/src/__tests__/resolver.test.ts`
5. Run `pnpm test` — all tests must pass

### Improving existing patterns

The best way to improve patterns is to find real-world conflict cases where GitWand fails or misclassifies. Add them as test fixtures and adjust the logic.

## Code style

- TypeScript strict mode
- Prefer explicit types over inference for public APIs
- Comments in French or English — both are welcome
- Every auto-resolution must include a human-readable `explanation` string

## Internationalization (i18n)

GitWand uses a lightweight, type-safe i18n system without external dependency. All user-facing strings must go through the translation system.

### Architecture

```
apps/desktop/src/
  locales/
    fr.ts        → French (reference locale, defines the type shape)
    en.ts        → English
    index.ts     → Registry, detection, exports
  composables/
    useI18n.ts   → Reactive composable: t(), setLocale(), locale
```

### How it works

**`fr.ts`** is the source of truth. It defines the `Locale` type via `as const` + `Widen<>`. Every other locale file must match its exact structure — TypeScript will error if a key is missing or extra.

**`useI18n()`** composable provides a `t(key, ...args)` function that resolves dotted keys (`"header.open"`) into the translated string for the current locale. It supports positional interpolation: `t("sidebar.commitButton", 3)` produces `"Commit (3)"`.

**Language detection** uses `navigator.language` (e.g. `"fr-FR"` is extracted to `"fr"`). Users can override via Settings; the preference is stored in `localStorage` under `gitwand-locale`. Passing `null` to `setLocale()` reverts to OS auto-detection.

### Adding a new language

1. Copy `apps/desktop/src/locales/fr.ts` to `xx.ts` (e.g. `de.ts` for German)
2. Translate all string values (keep the same object structure)
3. Import: `import type { Locale } from "./fr";` and type as `const xx: Locale = { ... }`
4. Register in `apps/desktop/src/locales/index.ts`:
   - Import the new file
   - Add to `locales` record
   - Add a label in `localeLabels` (e.g. `de: "Deutsch"`)
   - Add to the `SupportedLocale` type union
5. Build and verify: `pnpm build` — TypeScript will flag any missing keys

### Using translations in components

```vue
<script setup lang="ts">
import { useI18n } from "../composables/useI18n";
const { t } = useI18n();
</script>

<template>
  <button>{{ t('header.open') }}</button>
  <span>{{ t('sidebar.commitButton', repoStats.staged) }}</span>
</template>
```

### String conventions

**Keys** are hierarchical and grouped by component area: `header.open`, `sidebar.tabChanges`, `merge.keepOurs`.

**Interpolation** uses `{0}`, `{1}`, etc. for positional arguments.

**Pluralization** is handled with separate keys when needed: `header.file` / `header.files`.

**Git terminology** (commit, push, pull, stage, merge) can stay in English even in French locale — these are universally understood by developers. Exception: non-technical labels like section headers or button tooltips should be translated.

### Adding new strings

When you add a new user-facing string:

1. Add the key + French value to `fr.ts`
2. Add the key + English value to `en.ts`
3. Use `t('your.key')` in the component
4. Build — if you forget a key in any locale, TypeScript will catch it

**Never hardcode strings directly in templates or scripts.** All UI text goes through `t()`.

## Pull requests

- Keep PRs focused on a single change
- Include tests for new functionality
- Run `pnpm build && pnpm test` before submitting
- Describe _why_ the change is needed, not just _what_ it does

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
