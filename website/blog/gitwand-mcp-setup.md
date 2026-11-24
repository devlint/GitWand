---
title: "Connecting GitWand MCP to your agent: Claude Code, Claude Desktop, Cursor, VS Code, Codex"
description: "One stdio server, five config formats. The exact block for each client, checked against its documentation in November 2026, how to prove the server is talking to the right repository, the problems that actually happen (npx not found, Node too old, the wrong working directory), and the eight tools the server exposes."
date: 2026-11-24
head:
  - - meta
    - property: og:title
      content: "Connecting GitWand MCP to your agent: Claude Code, Claude Desktop, Cursor, VS Code, Codex"
  - - meta
    - property: og:description
      content: "The exact config block for five MCP clients, a test that proves the server sees the right repository, the failures that actually happen, and the eight tools you get."
---

# Connecting GitWand MCP to your agent: Claude Code, Claude Desktop, Cursor, VS Code, Codex

`@gitwand/mcp` is one program: a Node process that speaks MCP over stdin and stdout. Every client below starts it the same way, with `npx -y @gitwand/mcp`. What differs is the file the client reads, the key it expects at the top of that file, and — the part that causes most of the trouble — the directory the process starts in.

This post is the setup reference: one section per client with the block to paste, then a way to prove it works, then the problems that come up. Each client format was checked against that client's own documentation in November 2026. These formats move; if your client's docs disagree with this page, trust the docs. Windsurf and other clients are left out because I did not verify their current format, not because the server does not work there.

If you want to know *why* you would connect an agent to GitWand, and what a session looks like once it is connected, read [Pairing Claude Code with GitWand](/blog/claude-code-gitwand-ai-agents) first. This post is only the wiring.

---

## Before any client: two requirements and one decision

**Node 20.6 or newer.** That is the `engines` field of `@gitwand/mcp`. Check it the way the client will see it, which is not always the way your terminal sees it (more on that under [problems](#problems-that-actually-happen)).

**`git` on the PATH.** The server does not reimplement Git; it runs `git diff`, `git merge-file`, `git show` and friends. The issue-filing tool also needs the GitHub CLI, `gh`, signed in. Nothing else uses it.

**The decision: which repository.** The server works on one directory, chosen like this, in `packages/mcp/src/server.ts`:

1. the value of `--cwd` if you passed one;
2. otherwise the directory the client started the process in.

Every tool that reads the repository also accepts a `cwd` argument, so an agent can point a single call somewhere else. But the default matters, because of this: **if the directory is not a Git repository, the server does not complain.** `gitwand_status` runs `git diff --name-only --diff-filter=U`, gets nothing back, and answers:

```json
{ "files": 0, "conflicts": [], "message": "No conflicted files." }
```

That is the same answer as a clean repository. An agent that is quietly pointed at the wrong folder will tell you, sincerely, that there is nothing to resolve. So the rule for every config below: if the client does not reliably start servers inside your project, pass `--cwd` with an absolute path.

---

## Claude Code

One command ([Claude Code docs: MCP](https://code.claude.com/docs/en/mcp)):

```bash
claude mcp add gitwand -- npx -y @gitwand/mcp
```

Everything after `--` is passed to the server untouched, so `--cwd` goes there too:

```bash
claude mcp add gitwand -- npx -y @gitwand/mcp --cwd /absolute/path/to/repo
```

Without a flag the server is added in the **local** scope: this project only, stored in `~/.claude.json`, not shared. `--scope user` makes it available in all your projects (also in `~/.claude.json`). `--scope project` writes it to `.mcp.json` at the project root, which you commit so the whole team gets it:

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["-y", "@gitwand/mcp"]
    }
  }
}
```

Claude Code reads an entry with no `type` as a stdio server, so none is needed. Don't put an absolute `--cwd` in a file you commit; it is your path, not your teammates'.

**Check it:** `claude mcp list` shows each server's status; `claude mcp get gitwand` shows one entry; inside a session, `/mcp` shows `✔ Connected` or `✘ Failed to connect`.

## Claude Desktop

Open the config from the Claude menu in the menu bar (not the settings inside the window): **Settings… → Developer → Edit Config**. That creates the file if it is missing. It lives at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["-y", "@gitwand/mcp", "--cwd", "/absolute/path/to/repo"]
    }
  }
}
```

Here `--cwd` is not optional in practice. The MCP debugging guide says it plainly: the working directory of a server launched from a client config "may be undefined (like `/` on macOS)". Claude Desktop has no notion of a current project, so without `--cwd` you get the silent "No conflicted files." from above. If you work on several repositories, either add one entry per repository (`gitwand-api`, `gitwand-web`…) or tell the agent which path to pass as `cwd`.

After saving, quit Claude Desktop completely and reopen it; closing the window is not enough. **Check it:** the "+" button in the chat input → **Connectors** lists connected servers and their tools. If `gitwand` is missing, the logs are in `~/Library/Logs/Claude` on macOS and `%APPDATA%\Claude\logs` on Windows: `mcp.log` for connection errors, `mcp-server-gitwand.log` for what the server printed to stderr. A healthy start prints `[gitwand-mcp] Server started on stdio`. (Sources: [Connect to local MCP servers](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers), [Debugging](https://modelcontextprotocol.io/docs/2026-07-28/tools/debugging).)

## Cursor

Cursor reads `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project ([Cursor docs: MCP](https://cursor.com/docs/mcp)). The project file is the better fit here, because Cursor substitutes `${workspaceFolder}` — the folder that contains `.cursor/mcp.json` — inside `args`. That gives you a pinned working directory without hard-coding anyone's path:

```json
{
  "mcpServers": {
    "gitwand": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gitwand/mcp", "--cwd", "${workspaceFolder}"]
    }
  }
}
```

Put `.cursor/mcp.json` at the repository root so `${workspaceFolder}` is the repository. In the global file, `${workspaceFolder}` has nothing sensible to point to; use an absolute `--cwd` there or rely on the `cwd` tool argument.

**Check it:** servers are managed from **Customize** in the sidebar, with a toggle per server. Logs: Output panel (`Cmd+Shift+U` / `Ctrl+Shift+U`) → **MCP Logs**. Cursor asks before each tool call by default, which is a reasonable default for a server with tools that write files.

## VS Code (GitHub Copilot)

This is the client whose format has moved most recently, so read this section with a date on it: November 2026.

The [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) now points new Copilot setups at two "native" files, both using a top-level `mcpServers` key:

- user level: `~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`);
- workspace level: `.mcp.json` at the workspace root, currently behind the experimental setting `chat.mcp.workspaceRootConfig.enabled`.

```json
{
  "mcpServers": {
    "gitwand": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gitwand/mcp", "--cwd", "/absolute/path/to/repo"]
    }
  }
}
```

The user file is shared by every workspace, so an absolute `--cwd` there pins all of them to one repository; leave it out and have the agent pass `cwd` per call if you switch projects often. In a workspace-level `.mcp.json`, don't drop `--cwd` until you have checked (step 3 below) which directory the server actually starts in. The same reference says `${NAME}` and `${NAME:-default}` are expanded in `command`, `args` and `env`.

You will still find `.vscode/mcp.json` with a top-level `servers` key in older guides, including some of ours. The reference describes that file as part of the "Local" harness, deprecated and scheduled for removal in February 2027. It still works today; don't start there.

**Check it:** run **MCP: List Servers**, select `gitwand`, choose **Show Output** to see its log. Workspace-level servers follow Workspace Trust: in Restricted Mode they do not start, which is correct for anything that runs commands. As the docs put it, adding a configuration alone doesn't confirm the session can use the server — make one tool call.

## Codex (CLI, IDE extension, desktop app)

Codex reads TOML, from `~/.codex/config.toml`, and the CLI, the IDE extension and the desktop app share it ([Codex docs: MCP](https://developers.openai.com/codex/mcp), [configuration reference](https://developers.openai.com/codex/config-reference)):

```toml
[mcp_servers.gitwand]
command = "npx"
args = ["-y", "@gitwand/mcp", "--cwd", "/absolute/path/to/repo"]
startup_timeout_sec = 30
```

Codex also has a `cwd` key for the server process; `--cwd` in `args` does the same job and keeps the config identical to the other clients. A project can carry its own `.codex/config.toml`, and Codex loads it only for projects you have marked as trusted — GitWand's desktop app takes that behaviour seriously enough that it runs its own Codex prompts in a fresh private directory, never inside the repository, so a cloned repository's config cannot start servers on your machine.

`startup_timeout_sec` defaults to 10 seconds. The first `npx -y` run downloads the package, and on a slow connection that can take longer than 10 seconds, which looks like a server that "doesn't start". Either raise the timeout as above or install the package once (see below). **Check it:** type `/mcp` in the Codex composer to see connected servers.

## The shortcut: GitWand's own Settings > MCP

If you use the GitWand desktop app, **Settings > MCP** detects the config files of Claude Desktop, Claude Code (`~/.claude.json`) and Cursor (`~/.cursor/mcp.json`) on your machine, shows which servers each already has, and writes the `gitwand` entry in one click. With a repository open, the entry is pre-filled with `--cwd` pointing at it. It does not write VS Code or Codex files; for those, use the blocks above.

---

## Proving it works, in three steps

**1. Without any client.** This talks to the server directly over stdio and lists its tools. It is the fastest way to separate "the server is broken" from "the client config is wrong":

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | (cat; sleep 10) | npx -y @gitwand/mcp
```

You should see `Server started on stdio` on stderr and a JSON response listing eight tools.

**2. With a conflict you made on purpose.** A clean repository and a wrong directory give the same answer, so test against a repository that is known to have a conflict:

```bash
mkdir gw-test && cd gw-test && git init -q
printf 'a\n' > f.txt && git add . && git commit -qm base
git checkout -qb other && printf 'b\n' > f.txt && git commit -qam other
git checkout -q - && printf 'c\n' > f.txt && git commit -qam main
git merge other   # CONFLICT (content): Merge conflict in f.txt
```

**3. From the client.** Point the config's `--cwd` at `gw-test` (or ask the agent to pass it as `cwd`) and ask: "call `gitwand_status`". The answer should report `"files": 1`, `"totalConflicts": 1`, and `f.txt` with one hunk of type `complex` — both sides rewrote the same line, so GitWand correctly declines to pick one. If you get `"No conflicted files."` instead, the server is looking somewhere else.

---

## Problems that actually happen

**`npx` not found, or `env: node: No such file or directory`.** Desktop apps launched from the Dock or Start menu do not inherit your shell's PATH. If Node comes from nvm, fnm, asdf or Volta, the client may find no `npx` at all, or an old system one. Run `command -v npx` in your terminal and put that absolute path in `command`. If the error then becomes `node: No such file`, the `npx` script found itself but not `node`; add the directory containing `node` to the server's `PATH` through the client's `env` block.

**Node too old.** The server requires Node 20.6+. The Node your terminal runs and the Node the client runs can be different binaries (see above). Run `"/absolute/path/to/node" -v` with the exact path the client uses.

**Slow or flaky first start.** `npx -y` downloads the package on first use and checks the registry on later ones. If that is slow, or you are offline, install once with `npm install -g @gitwand/mcp` and use the installed binary as the command: `"command": "gitwand-mcp"` (or its absolute path), with only `--cwd` in `args`. You then upgrade deliberately, which is arguably better for a tool that writes to your working tree.

**Right server, wrong repository.** Covered above, and worth repeating because nothing errors: if the agent says there are no conflicts and `git status` disagrees, fix `--cwd`.

**Windows and Claude Desktop: `${APPDATA}` in the logs.** The MCP debugging guide documents an `ENOENT` failure with `${APPDATA}` in the path; the fix it gives is adding `"env": { "APPDATA": "C:\\Users\\you\\AppData\\Roaming" }` to the server entry. It also notes that `npx` may keep failing if npm itself is not installed globally (`npm install -g npm`).

**`gitwand_create_issue` fails.** That one tool goes through `gh`. It needs `gh auth login` (or `GH_TOKEN`/`GITHUB_TOKEN`) in the environment the client gives the server, which, again, may not be your shell's.

---

## What the agent gets: eight tools, two resources

Read from `packages/mcp/src/tools/` (version 3.13), in the order the server lists them:

| Tool | What it does | Writes? |
|---|---|---|
| `gitwand_status` | Conflicted files with counts, types and how many hunks are auto-resolvable | No |
| `gitwand_resolve_conflicts` | Runs the deterministic engine, writes what clears the gates, returns `pendingHunks` for the rest | Yes, unless `dry_run: true` |
| `gitwand_preview_merge` | Simulates a merge, rebase (`onto`) or cherry-pick (`commit`) and returns a risk level; no change to working tree, index or `HEAD` | No |
| `gitwand_explain_hunk` | The DecisionTrace for one hunk: why it got its type, with ours/theirs/base | No |
| `gitwand_apply_resolution` | Replaces one hunk with the content given — **without** checking it | Yes |
| `gitwand_resolve_hunk` | Returns a prompt asking the calling agent to propose a resolution; calls no LLM itself | No |
| `gitwand_resolve_hunk_llm` | Validates a proposed resolution (no leftover markers; JSON/YAML/TOML parse once no other hunk remains), writes it only above a score | Yes, if it validates |
| `gitwand_create_issue` | Files a GitHub issue through `gh`; previews by default, creates only on a second call with `dry_run: false` and the preview's id; refuses if a known secret pattern is found | Only on confirmation |

Three tools — status, resolve and preview — take `min_confidence_score` (0 to 100), which can only make GitWand apply *less* than its own label gate. Every tool except `gitwand_resolve_hunk`, which works on the text it is given, takes `cwd`.

The two listed resources are `gitwand://repo/conflicts` and `gitwand://repo/policy` (the repository's `.gitwandrc`). The server also answers `gitwand://hunk/{file}/{line}` with one hunk's raw content, but does not list it, so clients that only show listed resources won't display it.

Two of those tools write files without a person in the loop, and one of them does not validate what it writes. Which tool an agent should reach for, and when it should stop and hand back to you, is the subject of [the agent rulebook](/blog/ai-agent-conflict-rules). If you connect the server, give your agent those rules too.
