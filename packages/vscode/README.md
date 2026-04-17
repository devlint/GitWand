# GitWand for VS Code

**Git's magic wand** — automatic conflict resolution directly in your editor.

GitWand detects trivial merge conflicts and resolves them instantly, so you can focus on the real ones.

## Features

### CodeLens — inline actions above each conflict

When you open a file with merge conflicts, GitWand displays a clickable action above each `<<<<<<<` marker:

- **Resolvable conflicts** → `✨ Resolve (type)` — click to auto-resolve
- **Complex conflicts** → `⚠ Complex conflict` — manual resolution needed

### Diagnostics — inline hints

Each conflict appears in the Problems panel with its type and whether GitWand can handle it automatically:

- **Info** (blue) — auto-resolvable, with explanation
- **Warning** (yellow) — complex, needs human judgment

### Status bar

A live indicator shows conflict progress: `✨ 3/5 resolvable`. Click it to resolve the current file.

### Commands

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and type "GitWand":

| Command | Description |
|---|---|
| **GitWand: Resolve Conflicts in Current File** | Auto-resolve all trivial conflicts in the active editor |
| **GitWand: Resolve All Trivial Conflicts** | Resolve across all open files with conflicts |
| **GitWand: Show Conflict Status** | Display conflict summary |

## What conflicts can GitWand resolve?

| Pattern | Description | Confidence |
|---|---|---|
| **Same change** | Both branches made the exact same edit | Certain |
| **One-side change** | Only one branch modified the block | Certain |
| **Delete + no change** | One branch deleted, the other didn't touch it | Certain |
| **Whitespace only** | Same code, different formatting | High |
| **Non-overlapping** | Additions at different locations (e.g. imports) | High |
| **Reorder only** *(v1.4)* | Same lines, different order — pure permutation | High |
| **Insertion at boundary** *(v1.4)* | Pure insertions on both sides, base intact | High |
| **Generated file** | Lockfiles, build outputs, `.min.js`… | Medium |
| **Value-only change** | Same structure, only hashes/versions differ | Medium |

Complex conflicts with real semantic differences are **never** auto-resolved. GitWand only touches what it's confident about.

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitwand.resolveWhitespace` | `true` | Auto-resolve whitespace-only conflicts |
| `gitwand.minConfidence` | `"high"` | Minimum confidence: `certain`, `high`, `medium`, or `low` |

## Installation from source

```bash
# From the GitWand monorepo root
pnpm install
pnpm --filter @gitwand/core build

cd packages/vscode
pnpm build
npx @vscode/vsce package --no-dependencies

# Install the generated .vsix
code --install-extension gitwand-vscode-0.0.1.vsix
```

## How it works

GitWand is a monorepo with a shared core engine. This extension is a thin UI layer that delegates all conflict detection and resolution to `@gitwand/core`:

1. **Parse** — extract conflict markers from the file
2. **Classify** — determine the type and confidence of each conflict
3. **Resolve** — apply the appropriate resolution strategy
4. **Display** — show results via CodeLens, diagnostics, and status bar

## Links

- [GitHub](https://github.com/devlint/GitWand)
- [Core engine](https://github.com/devlint/GitWand/tree/main/packages/core)
- [CLI](https://github.com/devlint/GitWand/tree/main/packages/cli)

## License

MIT — [Laurent Guitton](https://github.com/devlint)
