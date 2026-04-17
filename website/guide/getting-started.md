# Getting Started

GitWand is available as a desktop app, a CLI tool, and a VS Code extension. Install whichever fits your workflow — they all share the same conflict resolution engine.

## Desktop App

Download the latest release for your platform:

- **macOS** — `.dmg` (Universal: Apple Silicon + Intel)
- **Linux** — `.AppImage` or `.deb`
- **Windows** — `.msi` or `.exe`

👉 [Download from GitHub Releases](https://github.com/devlint/GitWand/releases)

Open the app, select a Git repository, and you're ready to go.

### macOS — first launch workaround

GitWand is not yet Apple-notarized (on the v1.5 roadmap), so macOS Gatekeeper will refuse to open the app the first time with a message like *"GitWand can't be opened because Apple cannot check it for malicious software"*. Three ways to bypass it:

**Option 1 — Right-click → Open** *(simplest)*

1. Open Finder → **Applications**
2. Right-click (or Ctrl-click) **GitWand.app** → choose **Open**
3. In the dialog, click **Open** again

macOS remembers the choice; subsequent launches work normally.

**Option 2 — System Settings** *(if option 1 is blocked)*

1. Try to open **GitWand.app** once — macOS will refuse and log the block
2. Open **System Settings → Privacy & Security**
3. Scroll to the message *"GitWand was blocked to protect your Mac"* → click **Open Anyway**

**Option 3 — Terminal** *(removes the quarantine flag)*

```bash
xattr -dr com.apple.quarantine /Applications/GitWand.app
```

After this, the app opens normally like any signed app. Only run this on the GitWand build you downloaded from the official [GitHub Releases](https://github.com/devlint/GitWand/releases) page.

## CLI

Install globally via npm:

```bash
npm install -g @gitwand/cli
```

Or with pnpm:

```bash
pnpm add -g @gitwand/cli
```

Verify the installation:

```bash
gitwand --help
```

## VS Code Extension

Install from the VS Code marketplace:

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for "GitWand"
4. Click **Install**

The extension activates automatically when it detects conflict markers in your files.

## MCP Server (AI Agents)

GitWand exposes its engine as an MCP server for Claude Code, Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.

```bash
npx @gitwand/mcp
```

Add to your MCP client configuration:

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

See the [MCP Server guide](/guide/mcp) for the full tool and resource reference.

## Quick Start

### Resolve conflicts with the CLI

```bash
# Auto-discover and resolve all conflicted files
gitwand resolve

# Resolve specific files
gitwand resolve src/config.ts package.json

# Preview without writing changes
gitwand resolve --dry-run --verbose

# Check conflict status
gitwand status
```

### Resolve conflicts in VS Code

When you open a file with conflict markers, GitWand shows:

- **CodeLens** above each conflict with the resolution type
- **Status bar** showing how many conflicts are auto-resolvable
- Click the CodeLens or status bar to resolve

### Resolve conflicts in the desktop app

1. Open a repository with merge conflicts
2. Conflicted files appear in the sidebar with a conflict icon
3. Click a file to see the diff with conflict markers highlighted
4. GitWand shows which conflicts it can auto-resolve
5. Use the merge preview to see the predicted outcome before committing

## Configuration

Create a `.gitwandrc` file at the root of your repository to customize behavior:

```json
{
  "policy": "prefer-safety",
  "patterns": {
    "*.lock": "prefer-theirs",
    "package.json": "prefer-theirs"
  }
}
```

See the [Configuration reference](/reference/config) for all options.
