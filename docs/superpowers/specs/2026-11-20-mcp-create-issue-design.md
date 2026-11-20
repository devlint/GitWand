# MCP tool `gitwand_create_issue` — design (issue #301, part 6)

Short design (small change). Approved in conversation on 2026-11-20.

## Intent

Let an AI agent driving GitWand's MCP server (Claude Code, Cursor, Windsurf…)
file a GitHub issue on the repository it works in, the way the desktop app
does (#301 parts 1–5): same target rule, same secrets guard, nothing sent
without the user seeing it first.

## Goals

- One tool, `gitwand_create_issue`, in `@gitwand/mcp`.
- **Preview by default** (user's choice "A"): without `dry_run: false` the
  tool only returns what it would send. Creating needs an explicit
  `dry_run: false`. The description tells the agent to show the preview to
  the user before creating.
- Same target as the desktop: `origin`, or its fork parent when issues are
  disabled (or the repository archived) on `origin`.
- Secrets scan of title + body before anything leaves the machine.

## Non-goals

- Issue templates, milestones, attachments.
- Forges other than GitHub (GitHub Enterprise works through `gh`'s host).
- Reporting to GitWand's own repository.
- Reading the desktop app's stored token (separate process).

## Anti-goals

- An issue created without an explicit `dry_run: false`.
- A known secret pattern sent to a forge.
- `gh` picking its own target (`gh repo view` without a repo may pick
  `upstream`, the #298 bug).

## Approaches

1. **`gh` CLI (picked).** Agents have `gh` installed and signed in; `gh`
   honours `GH_TOKEN`/`GITHUB_TOKEN` too. It is already the desktop's
   fallback transport. Nothing new to configure.
2. REST with a `GITHUB_TOKEN` given to the MCP server: one more secret in the
   MCP config, no gain when `gh` is there.
3. REST then `gh` as fallback: twice the code and tests for the same result.

## Design

### Parameters

| Param | Type | Notes |
|---|---|---|
| `cwd` | string? | Repo root, as every tool. |
| `title` | string | Required; trimmed; 1–256 characters. |
| `body` | string? | Verbatim; at most 65,536 characters (GitHub's limit). |
| `labels` | string[]? | Must exist on the target (GitHub refuses otherwise). No comma (`gh` splits on commas). |
| `assignees` | string[]? | Logins; `@me` allowed (gh). No comma. |
| `repo` | string? | `owner/repo`; must be `origin` or its fork parent (case-insensitive). |
| `dry_run` | boolean? | **Default true.** |
| `preview_id` | string? | Required to create: the preview's HMAC of (root, host, target, title, body, labels, assignees), per-process key; one create per preview. Added in review; plus an MCP elicitation confirm when the client supports it (pass 4). |

### Target

- `git remote get-url origin` → host/owner/repo (https, `git@host:`,
  `ssh://`). No origin, or an unparseable URL → structured error.
- `gh api [--hostname host] repos/{owner}/{repo}` → the repository JSON,
  which carries `parent` (with `has_issues`, `archived`) when it is a fork.
- Targets as `devIssueTargetsFrom` (dev-issues.mjs): origin, then parent;
  `hasIssues = has_issues && !archived`. Default = first with issues.
- An explicit `repo` not in the targets → error; in the targets but without
  issues → error.

### Secrets

- `scanReportBody` moves from `apps/desktop/src/utils/reportGuard.ts` to
  `@gitwand/core` (pure, browser-safe); the desktop file re-exports it.
  (My call: one implementation, not a copy.)
- Title and body are scanned each on its own (findings name the field and
  its own line). Always on, with the repository's `.gitwandrc`
  `secrets.patterns` and `secrets.entropyThreshold` (default 4.0, core's
  `DEFAULT_ENTROPY_THRESHOLD`); not `secrets.ignore`, which a cloned
  repository could use to allow-list a value (review pass 3).
- `blockAt: "medium"`: a known pattern of severity high/medium blocks;
  entropy only warns. A blocked text is refused even with `dry_run: false`;
  the preview lists the findings (redacted excerpts only).

### Output (JSON in the text content)

- Preview: `{ dryRun: true, repo, isOrigin, title, bodyChars, labels,
  assignees, secrets: { blocking, warnings }, canCreate, next }`.
- Created: `{ created: true, repo, number, url }`.
- Errors: `isError: true`, `{ error: <code>, message }`.

### Running `gh`

- Spawned asynchronously (`src/spawn.ts`: array args, time limit with
  SIGTERM then SIGKILL, output cap): 30 s to read, 60 s to create.
- Create through `gh api -X POST repos/{target}/issues --input -`: the whole
  issue as JSON on stdin (the desktop's REST payload), nothing of it on a
  command line; `@me` resolved with `gh api user`. (Review pass 5; first
  written with `gh issue create`.)
- Environment allow-list (AGENTS.md: only what the child needs): PATH, home
  and Windows profile vars, temp dirs, locale, XDG dirs, `GH_CONFIG_DIR`,
  the gh/GitHub tokens, proxy and CA vars, the D-Bus session (Linux
  keyring); plus `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`,
  `NO_COLOR=1`. `GH_HOST`/`GH_REPO` never passed.
- `gh` missing → `gh_missing`; a create cut off or answered 500/502/503/504,
  reset or EOF → `create_uncertain`; other failures → `create_failed`.

### Docs

`packages/mcp/CLAUDE.md` (tools table), `packages/mcp/README.md`,
`website/guide/mcp.md`, `CHANGELOG.md` `[Unreleased]`. `website/changelog.md`
at tag time.

### Tests

Real temporary git repo with an `origin` remote, and a fake `gh` script
first on `PATH` that records its arguments and stdin and answers from a
fixture file.

## Left to the builder

File split inside `packages/mcp/src/tools/`, error message wording.
