# Threat model

## What this project does and where untrusted input enters
GitWand is a desktop Git client (Tauri 2 + Vue 3 + Rust) with a conflict-resolution engine in TypeScript. It opens
repositories the user did not necessarily author, so the content of a repository is untrusted: file names, branch and
tag names, commit messages, diffs, `.git/config`, hooks, submodule URLs and merge-conflict markers.
Other untrusted input: pull/merge request data from GitHub, GitLab, Gitea, Bitbucket and Azure DevOps (titles,
descriptions in markdown, comments, diffs), output of the `git`, `gh` and `glab` CLIs, responses from LLM providers,
and MCP tool arguments.

## Components that matter most / least
- Most: the Rust backend `apps/desktop/src-tauri/src` (Tauri commands, `git/`, `commands/`) and the IPC surface the
  webview can call. Anything reachable from repository content or forge data matters.
- `packages/core` (conflict-resolution engine, pure and browser-compatible), `packages/cli`, `packages/mcp` (stdio MCP
  server exposing resolution tools to an agent) and `packages/vscode`.
- The Vue frontend matters where it renders untrusted HTML (markdown, PR descriptions, commit messages).
- Least: `website/` (static VitePress docs), `benchmark/`, `scripts/`, test fixtures.

## How to exercise it
- `pnpm test` runs the unit and integration tests; tests create real temporary git repositories.
- `apps/desktop/src-tauri/examples/parity_probe.rs` drives git commands from Rust; `apps/desktop/dev-server.mjs` is a
  Node mirror of the backend routes used for web development.
- Rust: `cd apps/desktop/src-tauri && cargo test`. CLI: `packages/cli`. MCP server: `packages/mcp`.

## How you rate severity
- High or above: path traversal outside the repository (every user-supplied path should go through `safe_repo_path()`),
  argument or command injection into spawned `git`/`gh`/`glab`/shell processes, execution of code from a repository
  the user merely opened, XSS in the webview that reaches Tauri IPC, credential or token leakage (logs, process
  arguments, environment passed to children, URLs).
- Medium: data loss from a wrong conflict resolution presented as safe, patch rebuilt incorrectly from a diff
  (hunk parsing must be bounded by the `@@` header counts), unsafe handling of remote URLs.
- Low: denial of service from a pathological repository (huge diff, deep history) of the user's own machine.

## Anything to leave alone
- A user running commands in the integrated terminal, or configuring their own git hooks, is intended behaviour.
- Requiring the user's own `git`, `gh` or `glab` credentials is by design.
- `website/` dependencies and vendored third-party fixtures under test directories.
