# VS Code Extension

The GitWand VS Code extension brings conflict resolution directly into your editor with CodeLens annotations, diagnostics, and one-click resolution.

## Features

### CodeLens

When a file contains conflict markers, GitWand displays a CodeLens above each conflict block:

- **Resolvable conflicts**: `✨ Resolve (Only one side changed)` — click to resolve
- **Complex conflicts**: `⚠ Complex conflict — manual resolution needed` — informational only

### Diagnostics

Each conflict appears in the Problems panel with:

- **Information** severity for auto-resolvable conflicts
- **Warning** severity for conflicts requiring manual resolution
- Type label and explanation in the diagnostic message

### Status Bar

A status bar item shows the count of resolvable conflicts in the active file:

```
✨ 3/4 resolvable
```

Click it to resolve all auto-resolvable conflicts in the current file.

## Commands

| Command | Description |
|---------|-------------|
| `GitWand: Resolve File` | Resolve all auto-resolvable conflicts in the active file |
| `GitWand: Resolve All` | Resolve conflicts across all open files |
| `GitWand: Status` | Show a conflict status report in the output panel |

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

## Configuration

Configure the extension in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `gitwand.resolveWhitespace` | `true` | Resolve whitespace-only conflicts |
| `gitwand.minConfidence` | `"high"` | Minimum confidence level for auto-resolution (`"certain"`, `"high"`, `"medium"`, `"low"`) |

## How It Works

1. When you open or edit a file, the extension parses conflict markers
2. Each conflict is classified using the same engine as the CLI and desktop app
3. Resolvable conflicts get a clickable CodeLens; complex ones get a warning
4. When you trigger resolution, the extension replaces conflict blocks with the resolved content
5. Changes go through VS Code's workspace edit system — **fully undoable** with `Ctrl+Z` / `Cmd+Z`

## Conflict Type Labels

| Type | Label |
|------|-------|
| `same_change` | Same change on both sides |
| `one_side_change` | Only one side changed |
| `delete_no_change` | Deleted by one side |
| `whitespace_only` | Whitespace difference only |
| `non_overlapping` | Non-overlapping changes |
| `generated_file` | Auto-generated file (lockfile, build output…) |
| `value_only_change` | Only volatile values differ (hashes, versions…) |
| `complex` | Complex conflict |
