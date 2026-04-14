# MCP Server

GitWand ships an MCP (Model Context Protocol) server that exposes its conflict resolution engine to AI agents. Any MCP-compatible client can use it — Claude Code, Claude Desktop, Cursor, Windsurf, Continue, and others.

The server runs over **stdio** and requires no API keys or network access. It works entirely with local Git repositories.

## Installation

Use directly via npx (no install needed):

```bash
npx @gitwand/mcp
```

Or install globally:

```bash
npm install -g @gitwand/mcp
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your OS:

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["@gitwand/mcp", "--cwd", "/path/to/your/repo"]
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json` in your project:

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

Claude Code also ships with dedicated slash commands — see [Slash Commands](#slash-commands) below.

### Cursor / Windsurf / Other MCP Clients

Use the same `command` + `args` pattern. Refer to your client's MCP documentation for the configuration file location.

## Tools

The MCP server exposes 5 tools:

### `gitwand_status`

List conflicted files in the current repo with their complexity and auto-resolvability.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | No | Working directory. Defaults to server cwd. |

**Returns:** JSON with file count, total conflicts, auto-resolvable count, and per-file breakdown by conflict type.

### `gitwand_resolve_conflicts`

Auto-resolve trivial merge conflicts using GitWand's pattern-based engine. Writes resolved files to disk unless `dry_run` is true.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | No | Working directory |
| `files` | string[] | No | Specific files to resolve. Omit to auto-discover. |
| `dry_run` | boolean | No | Analyze without writing. Default: `false`. |
| `policy` | string | No | Merge policy: `prefer-ours`, `prefer-theirs`, `prefer-merge`, `prefer-safety`, `strict` |

**Returns:** Summary + per-file results with `resolutions` (what was auto-resolved) and `pendingHunks` (what needs human/LLM attention). Each resolution includes confidence scores and a full DecisionTrace.

### `gitwand_preview_merge`

Dry-run resolution on all conflicted files. Shows stats and a risk assessment (`low` / `medium` / `high`) without modifying any files.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | No | Working directory |

**Returns:** Risk level, summary (total/resolvable/remaining), auto-resolve percentage, and full per-file detail.

### `gitwand_explain_hunk`

Explain why a specific conflict hunk was classified as its type. Returns the full DecisionTrace with evaluation steps and the ours/theirs/base content.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | No | Working directory |
| `file` | string | **Yes** | Path to the conflicted file (relative to cwd) |
| `line` | number | **Yes** | Start line of the hunk to explain |

**Returns:** Classification type, explanation, confidence (score + dimensions + boosters/penalties), trace steps, and the raw ours/theirs/base content.

### `gitwand_apply_resolution`

Apply a custom resolution to a specific conflict hunk. Replaces the conflict markers at the given line with the provided content, then re-checks for remaining conflicts.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cwd` | string | No | Working directory |
| `file` | string | **Yes** | Path to the conflicted file |
| `line` | number | **Yes** | Start line of the conflict (the `<<<<<<<` line) |
| `content` | string | **Yes** | Resolved content to replace the conflict block |

**Returns:** Confirmation + remaining conflict count in the file.

## Resources

The server exposes 3 resources that clients can read for context:

| URI | Description |
|-----|-------------|
| `gitwand://repo/conflicts` | Current conflict state — file list, counts, types, auto-resolvability |
| `gitwand://repo/policy` | Active `.gitwandrc` configuration (or defaults if none exists) |
| `gitwand://hunk/{file}/{line}` | Raw hunk content for a specific conflict — ours/theirs/base + trace |

## The collaboration loop

The MCP server enables a workflow where GitWand handles the trivial conflicts and the LLM tackles the complex ones:

1. **Preview** — The agent calls `gitwand_preview_merge` to understand the conflict landscape: how many files, how many conflicts, what percentage GitWand can handle, and the overall risk level.

2. **Auto-resolve** — The agent calls `gitwand_resolve_conflicts`. GitWand resolves the trivial patterns (same_change, one_side_change, whitespace_only, etc.) and returns `pendingHunks` for everything it couldn't handle.

3. **Understand** — For each pending hunk, the agent has the ours/theirs/base content, the classification trace explaining *why* GitWand flagged it as complex, and the confidence dimensions showing where the uncertainty lies.

4. **Resolve** — The agent writes its own resolution and calls `gitwand_apply_resolution` to apply it. GitWand re-checks the file and reports remaining conflicts.

5. **Verify** — The agent can call `gitwand_status` to confirm all conflicts are resolved, or read `gitwand://repo/conflicts` for a final check.

This loop means the LLM never starts from scratch — it gets pre-triaged conflicts with full context, and only needs to handle the genuinely ambiguous cases.

## Slash Commands

GitWand ships `.claude/commands/` for Claude Code users:

### `/resolve`

Full conflict resolution workflow:

1. Checks conflict status with `gitwand status`
2. Auto-resolves trivial conflicts with `gitwand resolve --ci`
3. Interprets the JSON output
4. Handles remaining complex conflicts with LLM reasoning
5. Verifies the result

### `/preview`

Merge preview and risk assessment:

1. Simulates a merge with `git merge --no-commit --no-ff`
2. Analyzes conflicts with `gitwand resolve --ci --dry-run`
3. Assesses risk level
4. Recommends whether to proceed or abort
5. Cleans up the simulated merge

## CLI flag

The `--cwd` flag lets you point the server at a specific repository:

```bash
npx @gitwand/mcp --cwd /path/to/repo
```

If omitted, the server uses the current working directory.
