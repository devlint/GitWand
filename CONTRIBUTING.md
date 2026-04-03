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
apps/desktop/      → Standalone app with Tauri + Vue 3 (planned)
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

## Pull requests

- Keep PRs focused on a single change
- Include tests for new functionality
- Run `pnpm build && pnpm test` before submitting
- Describe _why_ the change is needed, not just _what_ it does

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
