# GitWand MCP Server

Use GitWand's MCP server to automatically resolve Git merge conflicts from any AI agent (Claude, Claude Code, Cursor, Windsurf, etc.).

## Install

```bash
npx @gitwand/mcp
```

Or add to your MCP client config (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["@gitwand/mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `gitwand_status` | List conflicted files with complexity scores and auto-resolvability percentages |
| `gitwand_resolve_conflicts` | Auto-resolve trivial conflicts. Returns DecisionTrace + `pendingHunks` for complex ones |
| `gitwand_preview_merge` | Dry-run — assess resolvability without modifying files |
| `gitwand_explain_hunk` | Explain why a specific hunk is complex (full DecisionTrace) |
| `gitwand_apply_resolution` | Apply a custom resolution you provide to a specific hunk |

## Resources

| URI | Description |
|-----|-------------|
| `gitwand://repo/conflicts` | Live conflict state — files, counts, and auto-resolvability |
| `gitwand://repo/policy` | Current `.gitwandrc` config (merge policies, confidence thresholds) |
| `gitwand://hunk/{file}/{line}` | Raw ours/theirs/base content + confidence for a specific hunk |

## Recommended Workflow

1. **`gitwand_preview_merge`** — check what can be auto-resolved vs. needs attention
2. **`gitwand_resolve_conflicts`** — auto-resolve trivial conflicts (writes files)
3. For each hunk in `pendingHunks`:
   - **`gitwand_explain_hunk`** — understand why it's complex (DecisionTrace, ours/theirs/base)
   - Decide on resolution, then **`gitwand_apply_resolution`** to write it

## Merge Policies

Pass `policy` to `gitwand_resolve_conflicts`:

- `prefer-theirs` *(default)* — take the incoming branch's version when safe
- `prefer-ours` — favour the current branch
- `prefer-merge` — attempt a three-way merge
- `prefer-safety` — only resolve with very high confidence
- `strict` — resolve only non-overlapping / whitespace-only conflicts

## Documentation

- Guide: https://gitwand.app/guide/mcp
- npm: https://www.npmjs.com/package/@gitwand/mcp
- GitHub: https://github.com/devlint/GitWand
