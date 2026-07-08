# AGENTS.md — GitWand AI Agent Rules

This file is read by all AI agents (Claude, Codex, Cursor, etc.) working on this repository.
Follow every rule below exactly. When in doubt, ask rather than guess.

---

## Monorepo Structure

```
apps/desktop/        — Tauri 2 + Vue 3 desktop git client
packages/core/       — TypeScript conflict-resolution engine
packages/cli/        — @gitwand/cli (Node.js CLI)
packages/mcp/        — @gitwand/mcp (MCP server)
packages/vscode/     — VS Code extension
scripts/             — Maintenance scripts (bump-version.sh, etc.)
```

Package manager: **pnpm only** (never npm, never yarn).

---

## Security — Critical Rules

### No shell string interpolation in git commands

Never build git commands via string interpolation. Always pass arguments as a
discrete array or use `.arg()` chaining.

```rust
// WRONG
Command::new("git").arg(format!("checkout {}", branch_name))

// CORRECT
Command::new("git").args(["checkout", &branch_name])
```

### Never bypass `safe_repo_path()`

`apps/desktop/src-tauri/src/lib.rs` contains `safe_repo_path()` which guards
against path-traversal attacks. Every file-system operation on user-supplied
paths must go through this function. Do not inline your own path validation.

### Never log secrets

- API keys, tokens, and passwords must never appear in log output or in spawned
  process arguments.
- Strip environment variables that carry secrets before spawning any external
  process. Pass only the specific env vars the child process needs.

---

## Version Management

### Never edit version files by hand

The following files are managed automatically — do not touch them directly:

- `package.json` (any workspace)
- `Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`

### Always use the bump script

```bash
./scripts/bump-version.sh X.Y.Z
```

This script aligns **all** version fields in one shot — desktop, core, cli, mcp,
website, README, and `HomeLanding.vue`. It derives the current version from
`packages/core/package.json` and replaces it everywhere.

Files bumped by the script:
- `apps/desktop/package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
- `packages/core/package.json`, `packages/cli/package.json`, `packages/mcp/package.json`
- `packages/mcp/server.json`, `packages/mcp/src/server.ts`
- `website/package.json`, `website/.vitepress/theme/HomeLanding.vue`
- `README.md`

### Independent versioning — VS Code only

`packages/vscode` is the **only** package with independent versioning.
Its `package.json` is not touched by `bump-version.sh` — version it manually
and publish via `vsce`.

---

## Rust / Tauri — Binary Declaration

Secondary binaries in `apps/desktop/src-tauri/` **must** be declared under
`[[example]]` in `Cargo.toml`, never under `[[bin]]`.

**Reason:** `tauri-bundler` automatically bundles every `[[bin]]` entry, which
breaks the release build. The `[[example]]` section is ignored by the bundler.

```toml
# WRONG
[[bin]]
name = "parity-probe"
path = "src/bin/parity-probe.rs"

# CORRECT
[[example]]
name = "parity-probe"
path = "examples/parity-probe.rs"
```

---

## Frontend Vue 3 — Conventions

### Composition API only

All new components must use `<script setup>` (Composition API). Options API is
not acceptable for new code.

### Business logic belongs in composables

Extract reusable or non-trivial logic into `apps/desktop/src/composables/`.
Components should stay thin — they orchestrate composables and handle template
rendering only.

### Settings must be kept in sync

App settings exist in two places that must always stay aligned:

1. `apps/desktop/src/composables/useSettings.ts` — `AppSettings` interface
2. `apps/desktop/src/components/SettingsPanel.vue` — local `Settings` interface

When adding a new settings field, add it to **both** files in the same commit.

### Sanitize user-generated HTML

Any content derived from user input (PR descriptions, markdown rendered to HTML,
commit messages displayed as HTML, etc.) must be sanitized with `useSafeHtml.ts`
(DOMPurify wrapper) before being injected into the DOM.

---

## Diff Parsing — Critical Gotcha

When classifying lines in a git diff, detect context lines by checking for a
leading space character.

```typescript
// WRONG — empty strings pass this test and become phantom context lines
if (!line.startsWith('\\')) { /* context line */ }

// CORRECT
if (line.startsWith(' ')) { /* context line */ }
```

This applies to both the TypeScript (`packages/core`) and Rust
(`apps/desktop/src-tauri`) diff parsers. Both implementations must stay in sync.

---

## Modal CSS — Specificity Rule

In `apps/desktop/src/components/BaseModal.vue`, the `.bm-btn` base class must
remain at specificity `(0,1,0)` — a single class selector with no parent
prefixes.

```css
/* WRONG — raises specificity to (0,2,0), silently overrides modifiers */
.base-modal__footer .bm-btn { ... }

/* CORRECT */
.bm-btn { ... }
.bm-btn--primary { ... }
.bm-btn--danger { ... }
```

Never prefix `.bm-btn` with `.base-modal__footer` or any other ancestor selector.
Doing so causes `.bm-btn--primary` and `.bm-btn--danger` to lose silently.

---

## IPC — Tauri Commands

All Tauri commands (Rust → TypeScript bridge) are centralized in:

```
apps/desktop/src/utils/backend.ts
```

When adding a new `#[tauri::command]` in Rust, add its typed wrapper in
`backend.ts` in the same PR. Never call `invoke()` directly from a component or
composable — always go through `backend.ts`.

---

## Testing

### Use real git repos in tests

Do not mock the git layer. Spin up a real temporary git repository in each test
that needs one, and clean it up on teardown.

### Parity tests — Rust backend vs Node dev-server

The parity probe (`apps/desktop/src-tauri/examples/parity_probe.rs` + the
harness in `apps/desktop/tests/parity/`) verifies that **git commands** exposed
by the Rust Tauri backend and their `dev-server.mjs` Node equivalents produce
identical output (git-status, git-log, git-branches, …). Rule: every
`#[tauri::command]` consumed by the frontend needs an equivalent dev-server
route, and deterministic commands should get parity coverage.

The conflict-resolution engine itself is **TypeScript-only** (`@gitwand/core`)
— there is no Rust resolution implementation to mirror. (Older revisions of
this file claimed a Rust↔TS resolution parity probe; that was never what the
probe covered — do not derive a "mirror resolution changes in Rust" obligation
from it.)

### Performance benchmarks

Located at `packages/core/src/__tests__/bench.bench.ts`. Run them when touching
hot paths in the core engine and include results in the PR description if there
is a regression risk.

---

## i18n

GitWand supports 5 languages. Every user-visible string must have a key in all
locale files.

| Code  | Language        |
|-------|-----------------|
| `en`  | English (default) |
| `fr`  | French          |
| `es`  | Spanish         |
| `pt-BR` | Portuguese (Brazil) |
| `zh-CN` | Chinese (Simplified) |

Locale files live under `apps/desktop/src/locales/`. Do not hardcode any
user-facing text directly in components.

---

## Roadmap

`roadmap.md` at the repo root is the canonical product roadmap.

### Before starting any non-trivial feature

Read `roadmap.md` first. Locate the relevant section (Shipped, In Progress, or
Planned) to understand the intended scope, the already-decided design choices,
and what has already been done. Do not re-design something that is already
specified there.

### When a feature ships (at tag time)

Move the item from its current section into the nearest **Shipped** block with
the correct version, exactly as the release tag names it. Keep the entry concise
— one line or a short bullet group.

If the shipped work introduces a new future dependency (a follow-up, a
limitation to document, a next phase), add it to the appropriate planned section
at the same time.

---

## Changelog

### Root CHANGELOG.md — source of truth

`CHANGELOG.md` at the repo root is the authoritative release history. It follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format:

```
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD
### Added / Changed / Fixed / …
- entries…
```

**Every release tag must have a corresponding entry here**, written before
`git tag vX.Y.Z` is run. Never tag without updating the CHANGELOG first.

### website/changelog.md — narrative mirror

`website/changelog.md` is the public-facing changelog on the marketing site. It
uses an editorial/narrative format (prose sections, not raw bullet lists) rather
than the technical Keep-a-Changelog format. It must cover **every version** from
v0.0.1 forward — full history, no truncation.

Rules:
- Update `website/changelog.md` in the same commit as `CHANGELOG.md`, at every
  tag. The two files must stay in sync.
- Remove phantom versions (versions absent from the root `CHANGELOG.md`).
- The editorial content can be richer than the root CHANGELOG, but must never
  contradict it.
- The frontmatter block (`title`, `description`) must be preserved.

---

## Monorepo Commands

```bash
# Build all workspaces
pnpm -r run build

# Test all workspaces
pnpm -r run test

# Add a dependency to a specific workspace
pnpm --filter @gitwand/core add some-package
```

### Browser-compatibility constraint for `packages/core`

`packages/core` must remain compatible with browser environments. Do not
introduce Node.js-only modules (e.g., `fs`, `path`, `child_process`) as
dependencies of this package.
