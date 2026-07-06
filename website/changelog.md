---
title: Changelog — GitWand
description: Release history for GitWand — the native Git client with AI conflict resolution. Follow new features, fixes, and improvements across every version.
---

# Changelog

## v3.3.0 — July 2026

### Blame, right in the editor

The File Explorer's built-in editor gets a "Blame" toggle. Turn it on and a gutter appears alongside your code showing who last touched each line and when, with consecutive lines from the same commit grouped together instead of repeating themselves. Hover any line for the full commit details. It clears the moment you start editing — blame on unsaved changes isn't blame on anything real.

### The launch ping actually works now

The anonymous launch ping introduced in v3.1.0 had a quiet bug: the analytics provider it used was filtering out the app's requests as non-browser traffic and silently discarding every single one — the ping was firing, but nothing was ever being counted. GitWand now sends that same anonymous ping through a different, app-friendly analytics service instead. Nothing about what's collected changed: still one fire-and-forget event per launch, still no personal data or user identifiers, still off in every debug build. (For the record, this ping isn't currently toggleable in Settings — a correction to what an earlier version of this changelog said.)

### A smaller fix

Opening a pull request from an Azure DevOps repo, the "into" branch dropdown used to only ever show `main` — it was built from local git refs, which an Azure clone often doesn't have many of. It now asks the forge directly for the real branch list, the same way GitHub, GitLab, and Bitbucket already did.

---

## v3.2.0 — July 2026

### An integrated terminal you can actually work in

The terminal panel got a serious upgrade. Rendering moved to WebGL, so scrollback and fast output feel noticeably smoother. You can now search inline with `Ctrl+F`, and links printed to the terminal are clickable. Tabs carry a type — shell, Claude, or Codex — each with its own icon, and a small dot appears on any tab that received output while you weren't looking at it.

The bigger fix: launching an AI agent from the terminal used to open a tab that did nothing — the process needs an interactive terminal to run in, and it wasn't getting one. "Launch Claude Code" and "Launch Codex" now open a real, working shell tab running the agent. And a new "New AI task" button takes this one step further: it creates a fresh, isolated git worktree and opens a Claude Code session in it in a single click, so you can hand an agent a task without touching your main checkout.

### A File Explorer and editor, right inside GitWand

A new panel — reachable from the dock, next to the Terminal — shows your full repo file tree (respecting `.gitignore`) and opens any file in a real code editor (CodeMirror 6, with syntax highlighting and per-tab undo history). It docks, resizes, and goes fullscreen the same way the Terminal panel does, and a small toolbar lets you lock editing, undo, and save without leaving the panel. Small edits and quick lookups no longer require switching to another app.

### Git Tree gets sharper navigation

The Git Tree toolbar now has a filter mode: narrow the whole graph down to just the commits matching your search instead of scrolling past everything else. Quick-toggle buttons let you filter by branch or author in one click, and the timeline now shows date separators so you can tell where "today" ends and "last week" begins. The branch search box got smarter too — it now offers an autocomplete dropdown as you type, and it can jump straight to a branch by its pull request number (`#1234`), with a small badge showing which branches already have an open PR.

### Managing worktrees and submodules got easier

Every project tab now has a small caret that opens a submenu listing that project's worktrees — switch between them without opening a new tab. Worktrees created for AI tasks show up there too, with a one-click option to merge the work back in or discard it cleanly. Deleting a branch that's checked out in a worktree now offers the right action ("Delete worktree") instead of an error git would have rejected anyway.

Submodules also caught up: GitWand now tells you when a submodule has upstream updates, and lets you pull them in or discard your local pointer changes without dropping to the terminal.

### Everything else

The contributor dashboard now shows per-author line churn (insertions and deletions), not just commit counts. Rebasing no longer requires a local branch as the base — remote branches, tags, and raw SHAs all work now, and if there's nothing to replay, GitWand offers a clean branch reset instead of a dead end. Checking out a pull request from a fork now correctly refreshes your branch and status. The Antigravity CLI (`agy`) joins Claude Code, Codex, and opencode as a selectable local AI provider. And the sidebar's "Unstaged" and "Untracked" sections are now a single, simpler "Changes" section.

---

## v3.1.0 — June 2026

### Dock, startup, and a few quality-of-life wins

The floating AppDock is now yours to configure: choose which tabs appear, where the dock sits, and which view opens when you launch the app. Small change, big difference if you spend your day in the same two or three views.

When creating a pull request, GitWand now catches the case where your branch hasn't been pushed yet and offers to publish it for you — no more switching to the terminal to figure out why GitHub is confused.

Release notes for your PRs can now be customized per-repo, and the default template got smarter: it derives a first draft from the merged commit messages so you're editing, not writing from scratch.

### GDPR-compliant anonymous telemetry

GitWand now sends a single anonymous ping when it launches. That's it — one request, no user identifiers, no device fingerprinting, no analytics events. The only thing it counts is "someone launched GitWand today." This is used purely to understand how many people are actively using the app, and it's skipped entirely in debug builds.

### AI CLI fix: NUL bytes stripped before spawn

Diff content that contained NUL bytes (`\0`) — which can appear in binary-adjacent files — was silently corrupting the prompts GitWand passes to AI CLI tools like Claude Code. Those bytes are now stripped before the process is launched.

### Website and small fixes

The landing page has a new screenshot gallery with a lightbox. The hero no longer jumps in height when you switch between the Desktop and CLI tabs. The VS Code extension's esbuild dependency was bumped to address CVE GHSA-67mh-4wv8-2f99, and the CI tag filter was tightened to prevent `vscode-v*` tags from accidentally triggering the desktop release pipeline.

---

## v3.0.0 — June 2026

### Today — your daily-driver action inbox

The Launchpad is now **Today**. The name change is deliberate: "Launchpad" was borrowed vocabulary; "Today" is a frame — _what do I actually do next?_ The surface has been rebuilt around that question.

Every item is now sorted into three collapsible urgency tiers: **À traiter** (needs you now — review requested, CI failed, merge conflicts, ready to merge), **En attente** (waiting on others, CI running, approved-but-blocked), and **Plus tard** (dependency bumps, auto-mergeable, low-priority). Each row surfaces a single, context-aware primary action — not a generic "Open in GitHub" — that routes directly to the right GitWand surface: merge, review, resolve conflicts, reply, or see CI failures. The card UI is completely reworked: a left-side accent band, state pills, CI/review chips, diff stats, contributor avatars, and a clear action hierarchy.

### The VS Code extension is on the Marketplace

The GitWand VS Code extension is now published and installable directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Gitwand.gitwand-vscode) — no build-from-source required. Under the hood, the extension was rewritten to bundle `@gitwand/core` inline (using esbuild), so the published VSIX is fully self-contained.

Four correctness bugs were also fixed: **Resolve All** now covers every file in the workspace instead of only the ones currently open in the editor. **Resolve File** no longer re-resolves each conflict hunk in isolation, which was silently breaking the engine's per-file confidence context — it now calls the resolver once on the full file content. The **CodeLens "Resolve" button** now correctly respects your configured minimum-confidence threshold. And **validation failures** — residual conflict markers or post-merge syntax errors — now surface as warning notifications.

The same validation visibility lands in the CLI: `gitwand resolve` blocks a write and prints a red warning if the merged output still contains conflict markers, and emits a yellow warning for syntax errors detected post-merge.

### Dashboard & branch management

The dashboard now shows a contributor modal with per-contributor stats, activity-bar tooltips with exact commit counts, and fortnight (14-day) commit windows instead of the previous 7-day view. Clicking a commit in the dashboard graph takes you straight to that commit in the Git Tree.

In the branch panel, each row now shows top-contributor avatars and inline actions, and you can pin branches to keep the ones you use most at the top. When you switch or create a branch, GitWand now automatically carries your uncommitted working-tree changes with you — no more stash-switch-unstash. And if you try to force-delete a branch that hasn't been fully merged, GitWand asks before it acts.

### Small things that add up

Images in markdown files now open in a full-screen overlay viewer. The website hero now has a GUI/CLI toggle with the Desktop app focused by default, and every platform card is a working link that goes where it should — release downloads, npm, or the VS Code Marketplace.

---

## v2.24.0 — June 2026

### Full-screen views and a floating dock

GitWand's permanent left sidebar and right Git-Tree strip are gone. Navigation now lives in a small floating dock at the bottom of the window — Dashboard, Changes, PRs and Git Tree — and every view uses the full width of the window instead of being boxed in by rails. The Git Tree graduates to a first-class full-screen view: pick a commit and you drop straight into its history. And in the Changes view, the commit composer rail can be folded away when you just want to read your diff — GitWand remembers whether you left it open.

### The Launchpad becomes a place you work, not just a list

The Launchpad no longer just lists things and sends you to the browser. Issues now open in a detail view right inside GitWand, a new action inbox surfaces what each of your repos needs from you, and you can move between Launchpad surfaces — and the branch selector — without ever leaving the app.

### The folder tree follows you into history

The same list/tree toggle now works when you're looking at an earlier, already-pushed commit. Open any commit and its changed files can be shown as a nested folder tree instead of a flat list — collapse the folders you don't care about, click a file to jump straight to its diff, just like in the Changes view. The choice is shared: flip to tree once and it stays tree everywhere, whether you're staging new work or reviewing past commits.

### External links in the AppImage, fixed for good this time

We thought we'd fixed external links in the Linux AppImage — and we had, mostly. But one silent case remained. Inside the packaged AppImage, the system's search paths are rewired to point at GitWand's own bundled files first, so the little tool that hands a link to your browser could pick up a bundled helper, or miss your system's browser association entirely, and then quietly exit as if it had succeeded. GitWand now strips those AppImage-injected entries before opening a link, so your real system browser is the one that's found — and it captures what each opener reports, so if anything ever does fail again it shows up in the command log instead of vanishing without a trace. Thanks again to @t1gu1.

## v2.23.0 — June 2026

### See your changes as a folder tree

The Changes sidebar can now show your working-tree changes as a **nested folder tree**, not just a flat list. A small toggle (next to the monorepo scope picker) switches between list and tree; in tree mode each section — Staged, Modified, Untracked — nests its files under their folders, and you can collapse or expand folders just like the sections themselves. Open the folders you're working in, fold away the rest; GitWand remembers your choice and the collapsed folders, and automatically reveals a file's folder when you select it.

### Discard, stage and unstage right where you are

Every file row now has a **discard** button sitting next to stage/unstage, and folder rows in the tree get folder-level stage, unstage and discard that act on everything inside. The buttons are grouped into a tidy segmented control — and they're always visible now, so you no longer have to hover to find them.

### Every external link works in the Linux AppImage

External links did nothing in the released Linux AppImage — clicking "Open GitHub" or "Open Azure" during sign-in, a pull-request or issue link in the Launchpad, the "open this repo on the web" button, or the changelog link simply went nowhere, even though all of them worked when running GitWand from source. There were two reasons. The first: the helper GitWand used to hand a URL to your browser ran without checking whether it actually succeeded, so when the AppImage runtime's polluted library path made that helper (or the desktop tool it calls) crash on the wrong libraries, the failure vanished silently. The second: a handful of links were plain web anchors, which the desktop webview quietly ignores, so they never reached the opener at all. GitWand now tries several system openers in turn, cleans up the environment before each one, and reports a real error if they all fail — and a single catch-all sends every external link in the app through your system browser, so none of them can silently do nothing again. Thanks to @t1gu1 for the report.

### Interactive rebase now works in the desktop app

Reordering, squashing, editing or dropping commits from the rebase editor quietly did nothing in the packaged desktop app — it only ever worked while running GitWand from source in web-dev mode. The reason: the rebase was sent to a small web-only endpoint that simply isn't there in the real app, so the request never reached git. GitWand now drives the rebase through a proper native command, writing your edited todo list and handing it to `git rebase -i` directly, and it pauses on conflicts just like before so you can continue, skip or abort. Base-branch pickers throughout the app — the branch menu, the merge picker and the rebase target — now also list branches with the most recently active ones first (after the current branch and `main`), so the branch you're reaching for is usually right at the top.

---

## v2.22.0 — June 2026

### Resolve a whole file in one click

The merge editor gains a file-level shortcut: **"Accept all — Current · Incoming · Both"** resolves *every* hunk of a file at once, including the complex, low-confidence hunks that the safe "Resolve auto" deliberately leaves for you. Picking "Both" on a build-generated file shows a discreet "⚠ may break a generated file" hint, but never blocks you. Once you've resolved a file by hand, GitWand offers to remember the rule — and that offer now rides along as a persistent toast, surviving the jump to the next conflicted file, so you can save it when you're ready. The saved-rule banner becomes actionable: one click applies it to all matching hunks, with a live count and graceful skipping of anything it can't touch.

### Conflicts that have no markers, finally resolvable

Some conflicts never write `<<<<<<<` markers into your files. A file modified on one side and deleted on the other, deleted on both, or added on both — git records these as conflicts, but the working tree looks clean, and GitWand used to show "0 conflicts" with no way to act. v2.22.0 reads the unmerged index stages directly: tree conflicts now appear in the file list with a distinct badge and open a dedicated panel that explains the case ("modified on the current side, deleted on the incoming side", …) and offers the right choices — keep current, keep incoming, or accept the deletion — with a read-only preview of the surviving content.

The same is true for content conflicts that lost their markers — after a one-sided `checkout`, a `-X ours/theirs` merge, or `rerere`. GitWand is now stage-authoritative: it rebuilds the full three-way conflict from the index stages. When your working tree matches one side, it's reconstructed silently with a small "reconstructed from the index" banner; when it matches neither (a manual resolution you may have started), GitWand asks rather than assumes — reconstruct the conflict, or keep your version as-is — so nothing you typed is ever discarded.

### Remote-state signals that tell the truth

Three "false alarm" fixes that were quietly getting in the way. GitWand no longer offers to "Publish" a branch that's already on the remote but missing its local tracking link — it shows the real ahead/behind state instead. The offline indicator no longer trusts the macOS WebView's unreliable offline events: it confirms with a real connectivity probe before blocking anything, so a stable connection is never mistaken for an outage — while a genuine outage still stops an action before it hangs. And the "unpushed tags" prompt no longer lists tags that are already on GitHub: GitWand now targets `origin` rather than whichever remote happened to sort first, which also makes pull-request lookups and other remote operations more reliable on repos with multiple remotes.

---

## v2.21.0 — June 2026

### Scope a monorepo to one sub-workspace

Large monorepos make the commit graph noisy — hundreds of commits across dozens of packages you don't care about right now. v2.21.0 adds a **scope picker** to the repo sidebar: pick a sub-workspace and the commit graph, commit search and repository stats all narrow to that part of the tree. GitWand auto-detects your packages from six workspace formats — pnpm (`pnpm-workspace.yaml`), npm/yarn (`package.json` workspaces), Cargo (`[workspace]`), Nx (`nx.json`), Turborepo (`turbo.json`) and Go (`go.work`) — all read natively in Rust, with a clear precedence when several coexist. Not inside a package? A "Custom folder…" option scopes to any directory you pick.

### History that stays focused

With a scope active, the graph filters to the commits that actually touched that sub-tree, and the header shows a chip for the current scope plus an "N commits hidden" badge — a stable count of everything outside it that stays put as you scroll. Clicking either clears the scope and brings the whole repo back. Your choice is remembered per repository (stored in `.gitwand-workspace.json`) and quietly falls back to the whole repo if the folder it pointed at has since been deleted. The picker only appears when GitWand actually detects a monorepo, so single-package repos stay uncluttered.

---

## v2.20.1 — June 2026

### Sign-in fixed in the Linux AppImage

Signing in to GitHub or Azure DevOps from the released Linux AppImage failed with a cryptic `Failed to parse device-code response` error — even though it worked perfectly when running GitWand from source. The culprit was the AppImage runtime rewriting the library path for everything GitWand launches, which left the bundled `curl` loading the wrong system libraries and dying mid-request. GitWand now cleans up that environment before launching any helper process, so sign-in (and every other GitHub/Azure operation) works the same from the AppImage as it does everywhere else. The transport also reports the real underlying error now instead of a misleading parsing message. Thanks to @t1gu1 for the detailed report.

---

## v2.20.0 — June 2026

### Resolve conflicts in a scratch worktree

Some conflicts are easier to untangle away from your live checkout. From the merge preview, "Resolve in scratch worktree" now spins up a temporary, isolated worktree (`gitwand-scratch-<timestamp>`) right next to your repo and opens it as its own tab — your working tree stays untouched. Resolve there, then bring the result back into your main checkout in one click, or discard it. Either way the scratch is cleaned up automatically, with no dangling worktree left behind. Bring-back is anchored to your original repo (and refuses if your main checkout still has its own conflicting changes), so the result always lands where you expect.

### The Conflict Predictor now sees rebases and cherry-picks

GitWand could already predict the conflicts of a merge before you ran it. That now extends to **rebase** and **cherry-pick** — without touching your working tree, index or HEAD. A rebase preview replays each commit on top of the target branch the way Git actually would (not a single squashed guess), and a cherry-pick preview simulates applying the commit onto HEAD. The merge-preview panel gains an operation selector (merge / rebase / cherry-pick), a colour-coded risk badge (low / medium / high), and an expandable hunk-by-hunk view of exactly what would conflict.

### Predict from the command line and from AI agents

The same side-effect-free prediction is available everywhere the engine runs. The `@gitwand/mcp` server's `gitwand_preview_merge` tool takes an `operation` parameter so connected AI agents can ask "would this rebase conflict?" before acting. And the `@gitwand/cli` gains a new `gitwand preview` command — `--onto <ref>`, `--commit <sha>` or `--branch <name>` — that exits 0 for a clean operation, 1 when conflicts are predicted, and 2 on error, with `--json` for CI pipelines.

---

## v2.19.0 — June 2026

### Sign in with GitHub — no `gh` CLI required

Connecting GitWand to GitHub no longer means installing and configuring the `gh` CLI. Settings → Accounts now has a "Sign in with GitHub" button that runs the OAuth device flow: approve the code in your browser once, and the token is stored in your OS keychain — never exposed to the app's frontend. From then on the whole PR workflow (list, detail, diff, checks, create, merge, checkout, mark-ready) goes straight through the GitHub REST API. The `gh` CLI still works exactly as before when you'd rather use it.

### Azure DevOps, as a first-class forge

Azure DevOps joins GitHub, GitLab and Bitbucket. Sign in with the same Entra ID device flow (with automatic token refresh, so your session doesn't expire mid-task), and GitWand auto-detects `dev.azure.com` and `*.visualstudio.com` remotes. You get the full pull-request lifecycle — list, detail, diff, create, merge, checkout, draft→ready — plus threaded comments, branch-policy CI checks and reviewer votes, so the merge-readiness chip reflects real build and approval state.

### Cross-fork pull requests

If your `origin` is a fork, the PR create view now lets you target the upstream parent instead of your own fork — it defaults to upstream, the way most contributions flow. The PR list for a fork also surfaces the PRs you opened on the upstream repo, merged in with your origin's own, and detail/diff/checks/merge resolve transparently to the right repository.

### Faster context switches

A round of backend work makes the app feel quicker when you jump between repos and PRs: Tauri commands are now async with blocking git and network calls offloaded to background threads, a stale-while-revalidate cache paints PR lists and details instantly from disk while refreshing behind the scenes, and `git_status` gained an in-process libgit2 fast-path that skips spawning a CLI process.

---

## v2.18.0 — June 2026

### Your CI, inside the diff

When a linter or typecheck fails, you no longer have to dig through CI logs to find the offending line. Check-run annotations now appear directly in the PR diff: a ❌, ⚠ or ℹ icon in the gutter marks each affected line, and hovering shows the full message and which check produced it. Files flagged by the CI carry a ⚠ count in the diff sidebar, and in the CI tab, any check that produced annotations gets an "N annotations" badge — click it to jump straight to the diff.

### All three forges

GitHub check-run annotations, GitLab code-quality reports (`artifacts:reports:codequality`), and Bitbucket report annotations all feed the same overlay. No configuration: if your pipeline already publishes annotations, GitWand shows them. Annotations load once per pull request, the first time you open the Diff or CI tab — browsing your PR list costs nothing extra.

### Copilot CLI as an AI provider

GitHub Copilot's CLI joins Claude Code, Codex and opencode as an AI provider. If you have the `copilot` binary and a Copilot subscription, pick it in Settings → AI — no API key needed. GitWand runs it in a text-only sandbox: it can write your commit messages, but it can't touch your files or run shell commands.

---

## v2.17.0 — June 2026

### opencode joins the lineup

opencode is now a first-class AI provider in GitWand, alongside Claude Code and Codex. Pick it in Settings → AI and GitWand finds your local `opencode` binary, shows its status, and runs your prompts through `opencode run` — using whatever provider you've authenticated with `opencode auth login`. Detection mirrors the other CLI agents, so there's nothing new to learn.

### A model picker for every CLI agent

Each of the three CLI agents now gets its own model selector, a second dropdown right under the provider picker. opencode enumerates its catalogue live (`opencode models`), with a Refresh button when you add a new one; Claude Code offers its stable aliases (Sonnet, Opus, Haiku); Codex takes a free-text model name. Your choice is remembered per provider, so switching back and forth always restores what you had — and leaving it on "default" lets each CLI use its own configured model.

---

## v2.16.0 — May 2026

### PR activity notifications

GitWand now tells you when something happens on your pull requests — a review request lands, someone comments, CI flips from green to red, or a PR gets merged or closed — with a native OS notification, even when the app is in the background. A dedicated background poller watches your whole workspace and a snapshot-diff layer figures out exactly what changed between two ticks, with no extra network calls beyond the Launchpad refresh you already had.

### You decide how much

Settings → Notifications lets you dial the granularity: all activity, reviews & comments only, CI failures only, or off. A "by people" toggle hides the noise from bots like GitHub Actions, Dependabot and Renovate. Notifications fire only while GitWand is in the background — when you're looking at the app, the Launchpad just updates in place. Everything is also logged in the Logs tab.

---

## v2.15.1 — May 2026

### Force push, with guardrails

Force push is now available directly from the branch context menu in the Git Tree, alongside the header sync button. It uses `--force-with-lease` so you never silently clobber commits you haven't seen. When the target is a protected trunk (`main`/`master`) or the remote has diverged, a confirmation modal spells out exactly what's at stake; a clean push of local-only commits goes through without ceremony.

### Quick Stash — `⌘⇧,`

Stash your work in progress instantly from anywhere, no dialog. The label is written for you from the current diff, so your `git stash list` stays readable. A subtle badge on the WIP node shows when stashes are pending.

### Submodules in the Git Tree

The branch picker now has a Submodules section listing each submodule and its branches. In the graph, any commit that moves a submodule pointer carries a `path@sha` badge — click it to navigate straight into that submodule's own Git Tree.

---

## v2.15.0 — May 2026

### Git Tree as the primary view

The flat commit log is gone. In its place, the Git Tree is now the main way to navigate your repository's history — a full multi-branch DAG that shows every branch, merge, and tag in their actual topology rather than a linearised list. Trunk-pinning keeps your default branch in the leftmost lane; a lane-cooldown algorithm prevents the graph from growing unboundedly wide on long-running projects; and an automatic WIP node shows your uncommitted changes as a live node at HEAD so you always know where you stand relative to the rest of the graph.

### Everything from the graph

The Git Tree is not just for browsing. Right-click any commit node to checkout, reset (soft, mixed, or hard), revert, branch off, tag, or cherry-pick — without visiting a separate panel. Right-click any branch or tag label to merge, rebase, rename, delete, push, or pull it. Stash nodes appear inline in the DAG; apply, pop, or drop them from the same context menu.

### Commit and branch search

A search bar at the top of the Git Tree panel filters commits live by message, SHA prefix, or author name. Matching nodes are highlighted in place; the graph doesn't jump or collapse, so you keep the spatial context while narrowing down.

### Log panel removed

The flat history sidebar that previously lived alongside the graph has been removed — it was redundant once the Git Tree became the primary view. If you want the history of a specific file, a **File history** button in the diff header opens a compact inline list without displacing the graph.

---

## v2.14.0 — May 2026

### GitLab diff-line discussions

Inline comments on GitLab MRs are now anchored to the exact diff line. Previously, `createComment` posted a general MR note (visible but not attached to a line). In v2.14, when a path and line number are supplied, GitWand routes the call to the GitLab Discussions API instead — passing the three SHAs (`base_sha`, `start_sha`, `head_sha`) fetched from the MR's `diffRefs`, plus `old_line` / `new_line` to pin the thread. The result looks and behaves identically to a GitHub review comment: the thread is anchored in the diff, collapsed when resolved, and visible in the MR timeline.

### Bitbucket CI checks

The CI checks panel now works on Bitbucket repositories. Build status is fetched from the Bitbucket Pipelines commit statuses endpoint (`/commit/{sha}/statuses`) and mapped to the same `CICheck` shape used for GitHub and GitLab — name, state, conclusion, and a deep link to the pipeline run. `SUCCESSFUL` → success, `FAILED` → failure, `STOPPED` → cancelled, `INPROGRESS` → in_progress.

### Bitbucket draft → ready

`convertDraftToReady` is now implemented for Bitbucket. Since Bitbucket has no native draft concept, the de-facto convention is a `"Draft: "` title prefix — GitWand strips it and PATCHes the PR title. The **Mark as ready** button only renders when the prefix is detected, so there are no false positives.

### `updateComment` / `deleteComment` on all three forges

Comment editing and deletion now work on GitLab and Bitbucket in addition to GitHub. Both methods gained an optional `prNumber` parameter — required at runtime for GitLab and Bitbucket (their REST paths include the MR/PR ID), silently ignored on GitHub (comment IDs are globally unique there).

### Forge-agnostic conflict preview and hotspot analysis

The conflict preview widget and hotspot analysis panel are no longer GitHub-only. Both features run entirely on local git data — `git merge-tree` for conflicts, a commit-graph walk for hotspots — with no forge API call. The `forge.name === "github"` guard that blocked them on GitLab and Bitbucket repos has been removed.

### Multi-account credential context

Each `ForgeProvider` method that makes an API call now accepts an optional `Account` parameter. Switching the active account in **Settings → Accounts** and refreshing the PR panel picks up the new credentials immediately, without closing or re-opening the repo tab.

---

## v2.13.0 — May 2026

### AI Prompt Presets

Named system-prompt presets let you craft the exact instructions sent to your AI provider when generating commit messages. Four built-in presets are always available — Default (Conventional Commits), Concise (subject line only), Detailed (with mandatory WHY/WHAT body), and Emoji (Gitmoji-style prefix) — and you can add as many custom presets as you like from **Settings → AI → Presets**. A preset picker in the commit-zone AI dropdown makes switching instant; your active preset is remembered per repository.

### Code Suggestions in PR Diffs

Every non-delete line in a PR diff now has a pencil **Suggest** button (visible on hover). Clicking it opens an inline editor pre-filled with the current line; edit the code, hit **Add to review**, and the change is serialized as a GitHub suggestion block (` ```suggestion ``` `). The suggestion lands in your review and the PR author can apply it to their branch in a single click — all without leaving GitWand. (GitHub only in 2.13; GitLab support planned.)

---

## v2.12.0 — May 2026

### Archived Branches

Branches accumulate. After a sprint, you can have a dozen old `feat/` and `fix/` branches cluttering the sidebar without adding any signal. Right-click any branch and choose **Archive branch** — it moves to a collapsible "Archived" section at the bottom of the dashboard, out of the way but never deleted from git. A "Merged" badge appears automatically on branches already integrated into your default branch; an "Inactive" badge appears on branches quiet for longer than a configurable threshold (Settings → Git → Inactive branch threshold, off by default). One click to unarchive if you need it back.

### Pinned Branches

The dashboard sidebar used to show the top-5 branches by activity, computed automatically. That heuristic is replaced by explicit user pins. Right-click any branch → **Pin branch** to keep it permanently in the "Pinned branches" section, in the order you choose. Unpin the same way. If you haven't pinned anything yet, the sidebar falls back to the old top-5 behaviour so nothing changes for new users.

### Multiple Committer Identities

If you contribute to open-source projects, work across clients, or maintain a separate personal account, you've had to remember to set `user.name` and `user.email` for each repo. GitWand now lets you save named identity profiles — label, git name, email, and optional GPG key — in **Settings → Git → Identities**. Set one as global default, then override per repo from the same panel. A compact selector at the bottom of the commit panel shows which identity is active and lets you switch without leaving the commit flow.

### Commit Templates

Typing the same conventional commit prefix forty times a week gets old. Add named templates — a subject line and optional body — in **Settings → Git → Templates**. Apply a template from the picker button next to the subject field, or type `/` in an otherwise empty subject field to trigger autocomplete filtered by template name. You can also import your existing `.gitmessage` file with one click — GitWand reads the path from `git config commit.template`, fetches the file, and creates a template from it.

## v2.11.0 — May 2026

### Transparent command log

Every git command GitWand runs is now visible. Press `⌘⇧L` (macOS) or `Ctrl+Shift+L` to open a slide-in panel showing the last 200 write operations — commit, push, pull, fetch, merge, rebase, stash, cherry-pick, branch ops, clone — with the working directory, wall-clock timestamp, execution time in milliseconds, and exit code (green for success, red for failure). The log lives in a Rust ring buffer (`VecDeque`, cap 200) that accumulates passively while the app runs; opening the panel costs nothing when you don't need it, and gives you instant insight when you're debugging why something misbehaved. No external log file, no extra process.

### Real-time clone progress bar

Cloning a large repo used to mean staring at a spinner for however long it took. The Clone modal now shows a live progress bar backed by git's own `--progress` output. Git writes carriage-return-delimited stage lines to stderr as it works; GitWand reads them as raw bytes, parses the stage and percentage from each line, and emits Tauri events to Vue in real time. The bar advances through four weighted stages: Counting objects (0–15 %), Compressing (15–25 %), Receiving objects (25–90 %), Resolving deltas (90–100 %). The current stage label and raw git message are shown below the bar.

### CommitLog pagination — infinite scroll for large repos

The commit log now loads in pages of 100 rather than a fixed 50-entry snapshot. Scroll within 200 px of the bottom of the log and the next page loads automatically, appended below the existing entries. A small spinner appears in the sentinel row while the next page is fetching; it disappears once you've reached the last commit. On a repo with thousands of commits, the initial load is faster and you only pay for the pages you actually scroll to. Powered by `--skip=N` on the Rust side.

### Fork Point visualization in CommitGraph

The divergence point between the current branch and its upstream is now marked with a distinct node in the commit graph — the merge-base commit where your branch parted ways with the remote. Useful at a glance when you want to know how far you've diverged before a rebase or merge.

### `backend.ts` domain split

The internal TypeScript layer that bridges Vue and Rust has been refactored from a single 900-line file into per-domain modules (`branch`, `commit`, `diff`, `forge`, `graph`, `log`, `repo`, `stash`, `tag`, `workspace`). No behaviour change — `backend.ts` remains a re-export barrel for existing imports — but future additions go into focused, reviewable files instead of a sprawling utility module.

---

## v2.10.0 — May 2026

### Forge integrations — GitLab, Bitbucket, multi-account

GitWand no longer assumes GitHub. v2.10 adds native support for GitLab Merge Requests (via the `glab` CLI, auto-detected) and Bitbucket Cloud Pull Requests (via the REST v2 API, no CLI needed). The full PR panel experience — diffs, CI status, inline comments, draft-to-ready conversion — works across all three forges. A new **Accounts** tab in Settings lets you connect multiple accounts per forge (personal + work). GitWand resolves the right account for each repo automatically from the remote URL; credentials are stored in the OS keychain and never written to disk in plaintext.

### MCP catalog in Settings

The **MCP** tab in Settings is a lightweight browser for the MCP ecosystem, built directly into GitWand. It pulls from the npm registry (250+ packages tagged `mcp-server`) and lets you install any server to your Claude Desktop, Claude Code, Cursor, or Windsurf config file in one click — no terminal, no JSON editing.

The search input is context-aware: paste a `registry.modelcontextprotocol.io` URL and GitWand deep-links to that server, type `@scope/package` to install a specific npm package directly, or search by keyword across names and descriptions. Every config file is scanned to show which servers are already installed where, so you never duplicate an entry. `@gitwand/mcp` sits at the top of the list with a "Reconfigure" shortcut and automatic `--cwd` injection so it always points at the right repo.

### Settings panel redesign

The Settings modal grows from medium to extra-large (960 px, fixed at 72 vh) and switches from a horizontal scrolling tab bar to a left-side navigation sidebar. Items are grouped the way you actually think about them — **Application** (General, Editor), **Dépôt** (Git, Hooks, Accounts), **IA & Agents** (AI, MCP, Automations), **Système** (Logs) — with the app version in the footer. Switching tabs no longer resizes the modal. A dedicated "Check for updates" action sits in the Système group: it spins while checking, shows a green "Up to date" confirmation for a few seconds, or opens the update modal directly if a new version is found.

---

## v2.9.0 — May 2026

### Launchpad — your workspace at a glance

GitWand gets its cross-repo dashboard. The Launchpad is a single full-screen view that aggregates everything you care about across every repo in your active workspace — uncommitted work, open pull requests, GitHub issues, and what your teammates are doing. Inspired by GitKraken's Launchpad but local-first: no cloud account, no syncing, no monthly fee. Open it from anywhere with `⌘L` (macOS) or `Ctrl+L` (Linux/Windows), or from the Workspace panel.

Four tabs, each pulling from a different angle of the workspace. **WIP** lists every repo that has uncommitted changes (staged, unstaged, or untracked) or a branch that's drifted from its upstream — useful first thing in the morning when you want to know which repos still have leftover work. **PRs** shows every open pull request across the workspace via `gh pr list`, with full status (Draft, Approved, Changes Requested, Review Required, CI rollup), labels, and a secondary chip row for assignees and review-requested users so you can spot the ones waiting on you. **Issues** does the same for GitHub Issues with three filter modes (assigned to me / mentioned / created by me) and milestone badges. **Team** is the most ambitious one — it groups colleagues' open PRs by author and detects overlap between your local work (WIP files plus un-merged commits on your branch) and the files each colleague's PR touches. Overlap members are auto-expanded so you can see the conflict before it becomes one.

### Pin and Snooze

Both PRs and Issues support pinning to the top of the list and snoozing for 1, 3, 7, or 14 days. The per-item `⋮` menu in every row exposes both actions. Pinned items sort first; snoozed items disappear from view until their preset elapses, and a small "N item(s) snoozed" banner above the list lets you peek and unsnooze any of them. The list of pins and snoozes persists to localStorage so it survives app restarts. Snooze takes priority over pin — a snoozed-and-pinned item stays hidden until the snooze expires, which is what you want when you're trying to focus.

### Lazy Team tab + perf settings

The Team tab does the most work — one `gh pr view --json files` per colleague PR — so on a busy workspace it can take ten seconds. To keep the Launchpad snappy at first open, the Team tab no longer fetches automatically. A placeholder with a "Load team activity" button shows on first click, and the data caches for subsequent opens. The other three tabs (WIP / PRs / Issues) stay eager because they're cheap and parallelised. A new Settings toggle "Disable Launchpad Team tab" lets you hide it entirely if you don't use it.

The Launchpad also gets a new "Refresh all" button that fans out the four refresh calls in parallel via `Promise.all`, plus persistence of the active tab between opens so reopening the Launchpad doesn't reset you back to WIP. All four tabs now share a homogeneous loading spinner — a small SVG that animates centrally on first load and tucks into the top-right corner on subsequent refreshes.

Under the hood: 36 unit tests cover the five composables (`useLaunchpadWip`, `useLaunchpadPrs`, `useLaunchpadIssues`, `useLaunchpadPins`, `useLaunchpadTeam`), plus 11 new UI smoke tests for `LaunchpadView.vue` itself. Total desktop test suite is now 95/95 green.

### Homepage redesign — from 21 flat cards to 3 Pillars + 4 tabs

The landing page had been collecting feature cards since v1.0 and ended up with 21 of them in a flat list, all with identical visual weight. With v2.5 LLM fallback, v2.7 Workspaces, v2.8 offline mode, and v2.9 Launchpad shipping in quick succession, the gap between "what GitWand is" and "what the homepage tells you GitWand is" had become awkward. v2.9 ships a complete rework of `HomeLanding.vue`.

Three pillars now sit directly under the hero: auto-resolve 95% of trivial conflicts (the resolution engine), Tauri 2 + Rust native performance (no Electron, sub-second cold start), and AI assists where humans get stuck (LLM fallback + MCP server, always opt-in). Each pillar has a stat, a one-line subtitle, and a "learn more" link into the relevant guide section. The conflict before/after demo moved up to sit right under the pillars instead of being buried below the feature list — it's the most concrete thing on the page and should be visible without scrolling past 20 cards.

The features section is now four tabs: Core Git (Resolve, PR, Diff, Folder tree, Split commit, Tags), Power user (Worktrees, Submodules, File history, History, Commit context, Fork workflow), AI (AI merge, AI PR, AI flow, Commit trailers, MCP, Commit context), and New in v2.9 (Launchpad, LLM fallback, Workspaces, Offline mode, In-app logs, Image diff, Performance, UI polish). The default tab is Core Git, but a prominent "New in v2.9 — Launchpad" banner sits above the tabs and jumps you to the New tab on click.

---

## v2.8.5 — May 2026

### Critical CSP fix — Tauri IPC was secretly running on the slow path

The Content Security Policy in `tauri.conf.json` had `connect-src 'self' http://localhost:3001` — and that was the entire story for a long time. Tauri 2's IPC protocol uses the `ipc://localhost/<command>` URL scheme on macOS and Linux, and `http://ipc.localhost/<command>` on Windows. **Neither was whitelisted in the CSP.** Every single IPC call — `git_status`, `git_repo_state`, `git_exec`, `git_remote_info`, every `gh_*`, every `workspace_*_all` — was being rejected by the browser engine. Tauri detected the rejection and silently fell back to its `postMessage` legacy path, which is dramatically slower and prone to callback-id race conditions. That cascade of mysterious `[TAURI] Couldn't find callback id …` warnings users had been seeing in the developer console for months? Each one was a real IPC promise that had timed out and a real subprocess response that came back too late to be claimed. The CSP repair restores Tauri's custom protocol path — IPC calls now go through their intended fast lane, the console quiets down, and the entire app feels measurably snappier across every interaction.

The same fix also unblocked AI provider connectivity. The Ollama detection probe, the Claude API endpoint, and any user-configured OpenAI-compatible URL were all hitting the same CSP wall — `Refused to connect to http://localhost:11434/api/tags because it does not appear in the connect-src directive`. README badges (`shields.io`, `github-user-content`) were rejected by `img-src` for the same reason. All of these now work. The script source policy stays locked at `'self' 'wasm-unsafe-eval'`, so the security posture is unchanged: no surface for remote code injection was opened — only outbound data fetches and IPC.

### macOS launchd env gap — login shell preload at startup

GUI apps launched from Finder, Dock, or Spotlight on macOS inherit a minimal environment from `launchd`: a bare `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin`, plus `HOME`, `USER`, and `TMPDIR`. Nothing from `~/.zshrc`, `~/.zprofile`, `~/.bashrc` is sourced. So no `SSH_AUTH_SOCK` for SSH-based git operations, no `XDG_CONFIG_HOME` for tool configs, no `LANG`/`LC_ALL` for proper locale, no custom `PATH` prefixes from version managers (asdf, mise, nvm), no nix-darwin exports. Subprocess like `gh`, `claude`, `codex`, `pnpm` that work flawlessly from your terminal would simply hang from the app, waiting on auth lookups or config files they couldn't find. GitWand now spawns `$SHELL -l -c env` once at startup (bounded by a three-second timeout, so a misbehaving rc file can't freeze launch), parses the result, and propagates every variable not already set into the process environment. Subsequent subprocess inherit the enriched env via the standard `Command::new` mechanism. PATH is deliberately left to GitWand's own homebrew-prefix enrichment for predictability, and shell-local noise (`PWD`, `OLDPWD`, `SHLVL`) is filtered out. This is the same approach VS Code, Sublime Text, and the JetBrains IDEs have used for years. No-op on Linux (display managers already pass a full session env) and Windows (registry-backed user env).

### `gh` keychain ACL — explicit token bypass

A subtler companion to the env gap: even with a complete shell environment, `gh pr list` from the signed GitWand.app subprocess would still hang. macOS keychain ACLs are per-binary-trust, and the keychain treats the signed Developer ID GitWand.app as a different application than iTerm or Terminal — even though the binary it spawns (`/opt/homebrew/bin/gh`) is the same. So the `security` helper that `gh` invokes to read the OAuth token from the `keyring` auth method silently waits for a foreground authorization prompt that never gets focus inside the webview context. GitWand now also runs `$SHELL -l -c "gh auth token"` from the login shell at startup, where the keychain ACL is already authorized, captures the token, and stores it as `GH_TOKEN` in the process env. `hidden_cmd` in `git/cmd.rs` explicitly propagates `GH_TOKEN` and `GITHUB_TOKEN` to every subprocess so the env survives any future runtime quirk. `gh` then bypasses the keychain helper entirely on every call — list, count, view, create, checkout, merge.

### Boot perf — `gh pr list` payload + lazy PR loading

`gh pr list` was being asked for too much, too soon. The list query at boot requested eighteen JSON fields including `statusCheckRollup` and `mergeStateStatus` — each one expanding internally into a per-PR roundtrip to the GitHub API for CI checks and merge state. On a busy repo with 100+ open PRs (think dendreo-class enterprise codebases), the full query returned `HTTP 502 Bad Gateway` from GitHub's GraphQL endpoint after thirty seconds, tripping GitWand's IPC timeout. The list now requests twelve cheap fields with a `--limit 10` first page, paginated lazily via an `IntersectionObserver` sentinel that fires the next ten-PR batch when you scroll near the bottom of the sidebar. Deduplication by PR number handles list shifts between fetches.

The Dashboard's "Open PRs" stat card used to fire a full `gh pr list` just to count the result array. It now uses a new lightweight `gh_pr_count` command that hits GitHub's GraphQL `totalCount` edge directly — a single sub-200ms call with no per-PR expansion. The PullRequest panel no longer auto-loads the list on mount; it only fires `gh pr list` when you actually click the PR tab. For multi-repo workspaces, `workspace_prs_all` got the same treatment — limit reduced from 100 to 10, heavy fields dropped — which matters disproportionately there because the per-PR roundtrip cost multiplies across every repo in the workspace.

Heavy field data (CI rollup, merge state, additions/deletions, review requests) is fetched lazily when you click into a PR's detail view, where it was always going to be displayed anyway. The sidebar's CI/merge badges are temporarily blank until you select a PR — a Phase 2 follow-up will introduce a batched `gh_pr_status_rollup` call to repopulate them without requiring a click.

---

## v2.8.4 — May 2026

### Quick Fixes batch — closing the ROADMAP backlog before v2.9

Eight chantiers identified post-v2.5 and prioritised before any new feature work, all shipped together in a single release.

**Two real bugs.** The global search palette was holding onto the branch list from the previous repo when you switched between tabs — the `useGitRepo` composable now watches the active folder path and invalidates `branches` and `log` whenever it changes. The PR sidebar was sometimes returning an empty list on repos that clearly had open PRs — root cause was a brittle atomic deserialization of `gh pr list --json` output that failed entirely if any single PR had a `null` author (deleted user, GitHub App bot). The parser was rewritten as a two-pass tolerant walk: structurally broken entries are skipped and logged to stderr, the rest of the list comes through. Three new Rust tests cover the regression.

**Six polish items.** The `+` dropdown in the tab strip now shows your pinned and recently-opened repos beneath the Open / Clone / Fork actions, with a clean separator and a vertical scroll if you've accumulated more than would fit — no more bouncing back to the home screen just to reopen something. Pushing while you have unpushed tags now opens a confirmation modal with three explicit choices (push with tags, push without, cancel) instead of silently committing to either behaviour — backed by a new `git_unpushed_tags` command that deterministically diffs your local tags against the remote. The Tags modal's action buttons were too small relative to the rest of the design system, now properly sized at 32 px height with consistent padding. The Rewind button in operation history had a transparent background that disappeared in light mode, now anchored to `--color-bg-secondary` which resolves cleanly across themes. The "Assigned to me" filter in the PR sidebar — visible since a prior release but with a few rough edges — was verified end-to-end and documented. And the red error banner that used to hijack the header on any unhandled error has been retired entirely, replaced by a Logs tab inside Settings that keeps a 500-entry FIFO buffer with timestamped, level-tagged entries — plus a discrete pill counter in the status bar that lights up when you have unread errors.

### Offline mode

A genuine feature, not a polish item. GitWand now detects when the network is unreachable and degrades gracefully instead of letting spinners hang forever. A new `useConnectivity` composable probes the active repo's remote with a two-second `reqwest` HEAD for HTTPS or a TCP `connect_timeout` for SSH/git/IPv6 URLs. The check runs every ~30 seconds via the existing repo-poller heartbeat (no new timer introduced — strict respect of the polling discipline established in v2.8.2). Both `navigator.online`/`offline` browser events and the probe result feed into a single `isOffline` ref. When you're offline, the "Offline" pill appears in the header, the sync button and all network actions disable themselves, and any guarded operation (push, pull, fetch, clone, fork, every `gh` call) short-circuits with a toast before reaching the IPC layer — so no spinner is ever started on a network call you couldn't complete. Eight tests cover probe flip, log transitions, no-repo and no-remote paths, and guard behaviour. Eleven Rust unit tests cover URL parsing across HTTPS, SSH, SCP-form (`git@host:owner/repo`), `git://`, and IPv6 brackets.

---

## v2.8.3 — May 2026

### LLM fallback tie-in — closing the v2.5 chantier across consumers

`@gitwand/core@2.5.0` shipped the `llm_proposed` pattern and `LlmEndpoint` injection back in April, but until this release the feature was effectively dead code: no consumer (desktop, CLI, MCP) was wired to inject an endpoint, so the pattern never matched. v2.8.3 wires it through every surface and validates the end-to-end pipeline.

**Desktop.** A new "AI fallback" section in the Settings panel — toggle, provider picker covering Claude, Claude Code CLI, Codex CLI, OpenAI-compatible endpoints, Ollama, and a self-hosted MCP target — with sliders for the post-merge validation threshold (50-100), the context lines window (10-200), and the validation mode. Choices persist to `.gitwandrc.llmFallback` via a new three-layer `write_gitwandrc` command. When the toggle is on, `useGitWand` reads the config on file open and injects an `LlmEndpoint` into `resolveAsync` that bridges to the existing AI provider stack via `useAIProvider.toLlmEndpoint()`. A new `LlmTracePanel` Vue component renders the audit trail (model, validation score with red/amber/green bucket, latency, prompt hash with click-to-copy, raw response truncated to 2 KB) above any conflict hunk where the resolution came from the LLM, with per-hunk Accept / Reject buttons that downgrade to manual resolution on reject.

**CLI.** Three new flags on `gitwand resolve`: `--llm-fallback`, `--llm-provider {claude,openai,ollama}`, and `--llm-model`. The CLI switches from `resolve()` to `resolveAsync()` and builds a Node-side endpoint using the native `fetch` available in Node 20+ — zero new dependencies, no SDK, no `node-fetch` shim. Claude reads `ANTHROPIC_API_KEY`, OpenAI reads `OPENAI_API_KEY`, Ollama hits `${OLLAMA_URL || http://localhost:11434}/api/chat`. A stderr warning fires at startup ("LLM fallback enabled — your code will be sent to …") so nothing is silent. The `--json` machine-readable output includes a per-resolution `llmTrace` block when the LLM was invoked. Backwards-compatible: without the flag, the CLI behaves exactly as before.

**MCP.** A new `gitwand_resolve_hunk` tool exposed by `@gitwand/mcp`. This is the inversion of the CLI flow — instead of GitWand calling a remote LLM, the connected agent (Claude Code, Cursor, Windsurf) *is* the LLM and resolves the hunk inside its own tool-call loop. Pure prompt builder, zero `fetch`, zero API key.

**Validation.** A new fifteen-fixture ConGra-mini benchmark covers conflicts across TypeScript, Python, Go, Rust, JSON, and Markdown at three difficulty tiers. With a deterministic mock endpoint, all fifteen fixtures resolve through `llm_proposed` with a validation score of 100 — the v2.5 critical "≥80% resolution" threshold is met decisively. Four desktop integration scenarios cover the happy path, validation-failure rejection, disabled fallback, and missing-provider behaviour. 901 core tests, 76 desktop tests, and 13 new CLI tests — all green.

**Docs.** Two new pages in the documentation: a how-to guide covering why opt-in matters, how to enable across the three surfaces, supported providers, validation policy, audit trail, revocation flow, and an FAQ on confidentiality and cost (roughly 0.015 USD per hunk on Claude Sonnet). And a release-day blog post on the state of LLM-assisted merge resolution (ConGra, Project Harmony) and where GitWand fits — the LLM is positioned as a last-resort safety net, gated by validation, never as the primary resolver.

---

## v2.8.2 — May 2026

### Performance hardening

A fluidity regression had crept in between v2.6 and v2.8 — the app felt sluggish even when nothing was happening. v2.8.2 is a single-purpose release that fixes it. Around thirty individual tasks were delivered across six layers of the app: the Vue frontend, the polling layer, the Rust backend, the bundle, the measurement tooling, and the code structure itself. No new features, no API surface change — just a faster, lighter, more predictable GitWand.

**A lighter cold start.** Twenty panels and modals that you only see once in a while — Settings, Stash, the merge editor, the rebase editor, the split-commit modal, Branch rename / delete, PR Review, PR Create, the Tags panel, Hooks, Worktrees, Submodules, Agent Sessions, Launchpad, Workspaces — are no longer parsed at launch. They load in the background the first time you open them, then stay cached. Same for seventeen of the rarer programming languages the syntax highlighter supports: Rust, Go, Python, Java, SQL, PHP, C, C++ and friends are now fetched only when you open a file in that language. The combined effect is a noticeably faster open, especially on cold disk cache or slower machines. The README badges on the Dashboard (CI status, npm version, license) also stopped blocking the rest of the page — they decode in the background while you can already read the README text underneath.

**Less work per render.** The diff viewer was doing a fair amount of redundant work. Word-level highlighting (the green/red boxes inside an added/deleted line) was being computed twice — once for side-by-side mode and once for inline mode, even though you only ever see one mode at a time. Now both views share a single computation. Syntax highlighting was being re-run from scratch on every reactivity tick; a two-layer cache (one per language token, one per fully-sanitised line) keeps the result around so re-renders are essentially free. The commit graph compares its props deeply and only re-renders the visible portion of the canvas. The search palette debounces the input by 150 ms so typing quickly no longer triggers a storm of recalculations.

**Polling discipline.** The previous code ran three independent timers — one for status, one for fetch, one to detect an in-progress rebase. They were unconditional and ran whether you were looking at the window or not. All three are now consolidated into a single timer with named callbacks, paused automatically when the window is in the background, and resumed when you bring GitWand back to focus. The rebase-detection timer is the most important fix: it was checking every three seconds whether a rebase was in progress, even when none was. It now only runs while a rebase is actually happening, which removes the constant background work that was the root cause of the v2.6 → v2.8 fluidity drop.

**A faster `git status`.** The hottest IPC call in the app — `git_status`, fired every two seconds while you have a repo open — now runs in-process via libgit2 instead of forking a `git` subprocess. The Rust backend opens the repo, computes ahead/behind, and walks the index and worktree directly in memory. The previous CLI implementation is kept as a fallback for edge cases (partial clones, exotic configs) so robustness is unchanged. On a deterministic test fixture, the probe goes from 41 ms to 32 ms; inside the running app, where the fork-exec overhead disappears entirely, the real-world gain is closer to 2-3×.

**Multi-repo workspaces run in parallel.** The six `workspace_*_all` aggregates — Status all, Fetch all, Pull all, WIP all, PRs all, Issues all — used to walk repositories one at a time. They now use Rust's `rayon` work-stealing pool, so N repositories run as N tasks in parallel, bounded by your CPU's core count. The bigger your workspace, the more visible the win: a workspace of ten repos benefits at least an order of magnitude more than a workspace of two.

**A 5 MB defensive cap on per-file diffs.** A pathological case (a 50 MB minified JSON, a generated SQL dump) used to send tens of megabytes of diff text over IPC and freeze the renderer parsing them. The backend now slices output at 5 MB per file, always at the last newline so a hunk header is never split mid-line, and exposes a `truncated_from_bytes` field the frontend can use to display a notice.

**A safety net on IPC calls.** Every `tauriInvoke()` call now carries a 30-second timeout by default, with two presets for the genuine exceptions: 5 minutes for network operations (`git push / pull / fetch / clone`) and unlimited for AI prompts (which can legitimately take minutes). If a backend command hangs, the frontend gets a clean error instead of a spinner spinning forever.

**A rewritten backend layout.** The Rust file `lib.rs` used to be a 3 254-line monolith holding 60+ Tauri commands. It has been split into one module per domain — `commands/ai.rs`, `commands/files.rs`, `commands/gh.rs`, `commands/ops.rs`, `commands/read.rs`, `commands/workspace.rs`, plus shared helpers in `git/cmd.rs`, `git/libgit2.rs`, `git/parse.rs`, and structs in `types.rs`. `lib.rs` is now 670 lines: the Tauri bootstrap, the `invoke_handler!` map, and the parity wrappers consumed by the Rust ↔ Node test harness. The IPC surface is unchanged — every Tauri command name is identical, every API call from the Vue side still works without modification. This makes future contributions, debugging, and onboarding dramatically easier without a single user-visible behaviour change.

**Bench suite and bundle budget in CI.** A new benchmark script (`apps/desktop/perf/bench.mjs`) measures CLI versus libgit2 on a deterministic fixture and reports the delta in a "vs CLI" column. A bundle-size budget runs on every PR and breaks the build if the initial JavaScript exceeds the configured ceiling. Two regression nets so the gains shipped today don't quietly erode tomorrow.

**Two fixes along the way.** The Windows terminal-flash issue that v2.8.1 had fixed reappeared briefly during the backend refactor — the `CommandExt` trait import got lost in a module split, silently turning `CREATE_NO_WINDOW` into a no-op. Re-imported and verified. And the Settings panel was running a small AI prompt at every open to verify Claude / Codex authentication, which was wasteful and surprising (each open could cost you API tokens). Authentication is now detected once at process level and only re-validated when you actively use the provider.

Performance is a feature you only notice when it's broken. v2.8.2 makes sure you stop noticing.

## v2.8.1 — May 2026

Patch release addressing regressions reported after v2.8.0.

**Windows — CMD console flash.** Every Git command, `gh` CLI call, and external tool spawn was opening a visible black CMD window on Windows. All child processes now carry the `CREATE_NO_WINDOW` flag so they run fully silent. The only intentional exception is the `claude login` interactive flow, which needs a visible terminal to complete OAuth.

**Auto-updater stuck on "Installation…".** On macOS, Gatekeeper holds the newly-written binary for signature verification before allowing execution. If `relaunch()` was called too soon it threw "operation not permitted", leaving the update modal frozen on the spinner forever. A 3-second post-download delay is now applied on macOS only — on Windows the NSIS installer handles process restart itself, so no delay is needed. Any remaining `relaunch()` failure is caught and surfaced as a readable error with a manual-reopen instruction instead of silently hanging.

**Pull requests not loading when GitWand is opened from the Dock or Finder (macOS).** Apps launched outside a terminal inherit a minimal `PATH` that does not include Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`). The `gh` CLI — required for the PR panel — lives there and was therefore invisible to GitWand. All child-process spawns now extend `PATH` with the four common Homebrew and MacPorts prefixes on macOS automatically.

**CI release — intermittent asset upload failure.** GitHub's Releases API occasionally returns a 500 error when several platform builds upload assets in parallel. A verification step now runs after each build, detects any missing asset, and re-uploads it with up to three retries.

## v2.8.0 — May 2026

### Agent Sessions View + Scheduled AI tasks

GitWand now sees the AI agents working on your repos — and can act on your behalf while you sleep.

**Agent Sessions View** answers the question "what is my AI agent actually doing right now?" A new panel in the sidebar detects running Claude Code, Cursor, and Windsurf processes by examining their working directories, cross-referenced against your repo's worktrees. Each card shows the tool, branch, ahead/behind/modified status, and whether the session is currently live (animated pulse indicator). One click opens the worktree in a GitWand tab so you can watch the diff evolve in real time, or launch a fresh Claude Code session on any worktree directly from GitWand.

**Scheduled AI tasks** is a lightweight automation layer with no daemon, no cloud, and no configuration files — four opt-in tasks that integrate cleanly with the Git events you already work with:

- **Auto-resolve on conflict** fires the moment a `MERGE_HEAD` appears, runs the conflict resolver automatically, and logs the result.
- **Nightly pull + rebase** runs `git pull --rebase` at the hour and minute you choose — once per day, skipped if you're offline.
- **Release notes on tag** triggers when you push a `v*` tag and generates a CHANGELOG entry via the AI provider already configured in Settings.
- **AI commit batch** watches for staged files as you switch away from the app or close it, and surfaces an AI commit message suggestion so it's ready when you return.

All tasks have a toggle, show their last-run timestamp, and log every action to the Logs tab. AI-dependent tasks disable themselves gracefully when AI is turned off.

### Website refresh

The homepage has been redesigned from the ground up. The flat 20-card feature wall is gone; in its place:

A **live terminal demo** in the hero replaces the static screenshot — watch `gitwand resolve` classify and auto-resolve 12 conflicted files in real time, with a ↻ Replay button to run it again. Right after the hero, a **conflict before/after block** shows the exact transformation — one side tries `'dark'`, the other reads from localStorage, GitWand picks the right answer in a single line.

A **10-pattern grid** dedicates a card to each resolution pattern, with its name in monospace, a colour-coded confidence badge (certain / high / medium / low), a plain-English description, and an ⚡ Auto-resolved or ○ Review needed indicator. Below that, **tabbed features** organise 20 cards into four navigable tabs: Core Git, AI, Integrations, and New in v2.8 — so you can find what matters without scrolling past a wall of equal-weight items.

The page closes with a **benchmarks section** that leads with numbers, not adjectives: 249k ops/sec on a single conflict, 40k on five, 4.5k on fifty, ~8 MB binary (vs ~150 MB Electron), 322 tests all passing, and 0 hallucinations — fully deterministic resolution.

## v2.7.0 — May 2026

### Workspaces, Hooks manager, and Worktree first-class

Three pillars that together make GitWand the command center for multi-repo engineering workflows.

**Workspaces** bring the multi-repo dashboard you've always wanted — without any cloud, account, or proprietary sync. Drop a `.gitwand-workspace.json` in a directory (commitable if you like), group your repos by project or squad, and get a single view of every repo's branch, ahead/behind count, and modified file count. Fetch all, pull all, or open all in tabs in one click. The foundation v2.9's Launchpad will build on.

**Hooks manager** makes `.git/hooks` visible and controllable. The new Hooks tab in Settings lists every hook in the repo, lets you toggle it on/off with a switch (using the `.disabled` suffix convention understood by tools like Husky), create new hooks from a dropdown of all 18 standard Git hook names, and delete them with confirmation. The same 3-layer pattern (Rust command → dev-server endpoint → typed TS wrapper) used for all GitWand backend features.

**Worktree first-class** finishes what v1.6 started. Hit ⌘⇧N from anywhere, type a task name, and GitWand creates the worktree (path auto-derived as a sibling of the main worktree), creates the branch (`task/<name>` by default), and opens the worktree in a new tab — one gesture, no terminal. Each worktree row in the manager now shows live status pills (↑ ahead, ↓ behind, ~ modified, ✓ clean). And a new Cleanup panel surfaces non-main worktrees with nothing left to push, so you can select and delete merged branches in bulk.

---

## v2.6.0 — May 2026

### Refactoring-aware merge

The conflict resolver has a new trick: it now understands that two branches can make incompatible changes to a file not because they edited the same lines with conflicting intent, but simply because one branch renamed a variable while the other added new uses of the old name. These are the conflicts that look scary but aren't — and they've been invisible to every merge algorithm until now.

`@gitwand/core@2.6.0` introduces a four-phase pipeline for this. When a hunk resists all the standard patterns, the refactoring detector kicks in. It tokenises the base, ours, and theirs versions, identifies tokens that disappeared from one side and appeared on the other, and confirms via a full bijective substitution check that the token sequence maps cleanly. It handles three refactoring kinds: local variable / parameter renames (scoped to the enclosing function), top-level function and class renames (applied globally), and method moves between classes. Once the refactoring is confirmed, both branches are inverted back to the base nomenclature, merged with the standard 3-way engine (which now operates on code that agrees on all names), and the refactoring is replayed forward on the result. The whole pipeline runs inside a try/catch — if anything is uncertain, it degrades to `complex` without touching the conflict.

The feature is opt-in. Set `refactoringAware: { enabled: true }` in your `GitWandOptions` or `.gitwandrc`. With it disabled (the default), the code path is completely silent and adds zero overhead.

A technical note on a non-obvious edge case this release also fixes: when two parameters are renamed simultaneously in the same commit (`a` → `left`, `b` → `right`), both appear with the same occurrence count, which the original bijective algorithm misclassified as ambiguous. The fix uses permutation search over same-count candidate groups and validates each assignment against the full token sequence — correct result, negligible cost at the scales these hunks actually appear.

---

## v2.5.1 — May 2026

### PR filter — finally working end-to-end

The "Assignées" and "Reviews" filter buttons in the PR sidebar were silently showing all PRs regardless of the selection. Three separate bugs compounded to produce this failure. First, `ghCurrentUser()` was fetching from `/api/gh-current-user` (pointing at Vite's dev server on port 5173, which served back `index.html`), so JSON parsing threw `Unexpected token '<'` and the identity resolved to `null`. Second, the old error handler was `.catch(() => {})` — which swallowed the failure completely and showed all PRs as if the filter were off. Third, busy repos like Dendreo have more than 50 open PRs, and the `--limit 50` cap in the Rust backend silently dropped older ones; PR #9023 (assigned to Laurent) never appeared in any list. All three are fixed: the URL now carries the `${DEV_SERVER}` prefix used by every other endpoint; the error lands in a visible `currentUserError` ref with a Retry button in the UI; and the limit is raised to 300 in Rust and paginated 3 × 100 in the dev-server.

### Offline mode

A new `useNetworkStatus()` composable wires the browser's `online` / `offline` events to an `isOffline` ref that propagates through the app. When offline, `SyncSplitButton` disables all remote actions (push, pull, fetch, merge remote) and shows a tooltip explaining why. The app header shows an "Offline" pill. No more mystery failures when the laptop is on a train.

### Error log replaces the blocking banner

The red error banner that blocked the header whenever the app encountered an unhandled error is gone. In its place: a slim, non-blocking toast with a "View logs" link, a discrete red dot on the settings button to signal unread entries, and a dedicated Logs tab in Settings that shows a timestamped, reverse-chronological list (max 200 entries) with a Clear button. Errors are persisted to `localStorage` so they survive a reload.

---

## v2.5.0 — April 2026

### LLM fallback for complex conflicts

The core engine gets its biggest new capability since tree-sitter structural merge: a generative model fallback for the hunks that the deterministic patterns can't touch. When `llmFallback.enabled: true` is set in `GitWandOptions`, every hunk classified as `complex` by the pattern engine is routed to a model endpoint you supply — any API that accepts a prompt string and returns a string. The resolver constructs a context-aware prompt (configurable window of surrounding lines), calls the model, validates the output through the parse-tree and post-merge scoring pipeline, and accepts the resolution if its score clears the `minPostMergeScore` threshold. Below threshold, it falls back cleanly to `complex` and surfaces the hunk for manual review.

The new `llm_proposed` ConflictType appears in decision traces whenever a model resolution was accepted. The full audit trail — model name, latency, prompt hash, truncated raw response, validation score, accepted/rejected — is recorded in `LlmTrace` and attached to the hunk's `DecisionTrace`, so you can see exactly what happened and reproduce it.

The synchronous `resolve()` continues to work exactly as before — it never calls the model. The LLM path is only active in `resolveAsync()`, so the performance characteristics of the standard pipeline are unchanged.

`@gitwand/mcp` gains a `resolve_hunk` tool that exposes this full pipeline to any MCP client. Pass `ours`, `theirs`, and optionally `base`, and get back `type`, `confidence`, `resolution`, `explanation`, and `llmTrace` when a model was involved. Ten new corpus fixtures (F36–F45) cover the v2.5 surface.

### Desktop polish

Recent and pinned repositories now appear on the empty state and in the repo-switcher dropdown — no more hunting for a path you just had open. Push confirmation detects unpushed local tags and offers to include them. Two visual fixes: the Tags modal buttons were too small (now `size="md"` to match the rest of the app), and the Rewind button had a transparent background in Light mode (now uses `opacity: 0.12` on the danger color). The Worktree and Submodule panels have been migrated to `BaseModal` for visual consistency with every other overlay in the app.

---

## v2.4.1 — April 2026

### Semantic validation lands in core

The headline change is invisible from the merge editor: GitWand's resolver now refuses to ship a resolution that breaks the file's parse tree. Every candidate fix is fed through tree-sitter for the file's language, and resolutions that produce parse errors are either retried with another pattern or surfaced as manual conflicts. A new `postMergeRisk` dimension on `ConfidenceScore` (weight −0.20) retroactively demotes any resolution whose output doesn't parse cleanly — so the score you see in the trace is the score *after* validation.

Validation now ships in three tiers. `off` skips the parse-tree pass entirely — useful for raw-throughput batch resolves. `balanced` is the new default (renamed from `standard`) and runs the parse-tree check. `strict`, opt-in via `.gitwandrc`, layers `tsc --noEmit` and `eslint` on top through the new `adapters/strict-node.ts`. External-tool errors come back as a typed `ExternalValidationResult { tool, errors, passed }` instead of the previous loose `strictErrors` shape, so consumers can render per-tool diagnostics rather than concatenating strings.

The async resolver got the same treatment: `resolveAsync()` now populates `externalValidation` on every return path, regardless of which tier ran. Five new corpus fixtures (F31–F35) cover the v2.4 surface, and two new test suites (`v2-core-scenarios.test.ts` and `validation-parse-tree.test.ts`, 1,100 lines together) hold the line at **841/841 passing**.

This closes the v2.4 entry on the [CORE-V2-ROADMAP](https://github.com/devlint/GitWand/blob/main/CORE-V2-ROADMAP.md). The expected impact, per the roadmap target, is a roughly 50 % drop in parse-tree-broken false positives.

### In-app Help Panel

A new Help button in the header — mirrored in the macOS menu bar — opens a multilingual overlay covering Getting Started, Conflicts, Shortcuts, Workflow, AI features, and an FAQ. Press `Esc` to dismiss. Translated across all five locales.

### Agent discovery surfaces on the website

`gitwand.devlint.fr` now publishes the surfaces AI tooling looks for: an MCP server card, Agent Skills entries, an RFC 8288 `api-catalog` link, WebMCP browser-tool declarations, and explicit AI usage signals in `robots.txt`. The result is that an agent visiting the site can find `@gitwand/mcp` and its install path on its own — no human in the loop. The `server-card.json` is wired into `bump-version.sh`, so the version stays aligned with every release.

### Fixes

The post-merge "Delete «branch»" button was offering to delete `master`, `main`, or `develop` if you'd just merged them — now those mainline names are filtered out, and only feature/PR branches are eligible for cleanup.

The Histogram-diff opt-out flag was reading `import.meta.env.GITWAND_DIFF`, which isn't typed on `ImportMeta` without Vite types — `tsc --build` was breaking in CI. Replaced with a `typeof process`-guarded `process.env` lookup that works under Node.js without breaking browser/Tauri.

`@gitwand/cli` and `@gitwand/mcp` were stuck at 2.3.0 because `bump-version.sh` deliberately skips packages whose version drifts from `@gitwand/core`. The resync brings them to 2.4.1 alongside core, and the publish workflow's `[ version == tag ]` precondition now passes. `server.json`, `server.ts`, and `server-card.json` are aligned in the same commit.

---

## v2.3.0 — April 2026

The umbrella tag for three back-to-back `@gitwand/core` releases — v2.1, v2.2, v2.3 — that take the resolver from "good with text diff" to "good with the structure of the file." Plus cherry-pick from the log with full conflict-resolution flow, and a hardened auto-update manifest publish in CI.

### `@gitwand/core@2.1.0` — Histogram diff

The underlying diff routine now uses **Histogram diff** (rare-anchor splitting with forward/backward extension, JGit-style), replacing the pure DP / Hirschberg backend that shipped through 2.0.x. The new alignment is more stable on real source code, which directly lifts the success rate of `non_overlapping` and `insertion_at_boundary` patterns — corpus fixtures that previously fell into `complex` are now auto-resolved end-to-end.

The change is opaque to consumers: `lcs(a, b)`, `computeDiff(base, branch)`, and `mergeNonOverlapping(base, ours, theirs)` keep their public signatures. Set `GITWAND_DIFF=lcs` at call time to roll back to the legacy backend (debug, reproducibility, perf comparison). On runtimes without `process.env`, Histogram is always used.

A primitive `detectBlockMove(base, ours, theirs)` (Rabin-Karp rolling hash with token-diversity and literal anti-collision filters) ships alongside it — no scoring impact in 2.1, but it's the foundation for the v2.6 refactoring-aware merge. `ConfidenceScore.dimensions` gains an optional `algorithmStability` field reserved for the same purpose; default 0 keeps numeric output identical to v1.4 for all existing patterns.

### `@gitwand/core@2.2.0` — Format profile registry & JSON Patch

The JSON and YAML resolvers gain a registry of **format profiles** that annotate JSON Pointer paths with a merge strategy. The result is that two long-standing functional gaps disappear:

- **JSON arrays** at `/dependencies`, `/scripts`, `/keywords`, `/files`, etc. now merge semantically (set-by-identity or merge-keys) instead of bailing out on `Array.isArray`.
- **YAML sequences** in `helm/values.yaml` and Kubernetes manifests (containers, volumes, env vars, ports) merge by `name` (or `port` / `host` per resource) instead of failing on a single divergent line.

Five built-in profiles ship in 2.2: `package.json`, `tsconfig.json` (and `tsconfig.<variant>.json`), `composer.json`, `helm/values.yaml`, and a generic `kubernetes` profile that matches manifests under `k8s/`, `kubernetes/`, `manifests/`, or with conventional basenames. `registerFormatProfile(profile)` registers a custom profile and returns an unregister function for clean teardown in tests.

Under the hood, this version also ships a minimal in-house **RFC 6902 (JSON Patch)** implementation: `diffJson(base, target)` produces an op sequence (`add` / `remove` / `replace`), `applyJsonPatch(doc, ops)` applies it immutably, and `mergeJsonPatches(ours, theirs)` returns the concat when paths are disjoint or `null` plus a list of conflicting paths otherwise. The round-trip property `applyJsonPatch(base, diffJson(base, x)) ≡ x` is verified on 100 random JSON inputs. `move` and `copy` are deliberately not supported — express them via `add` + `remove`.

A new `GitWandOptions.disableFormatProfiles?: boolean` (default `false`) reverts the JSON and YAML resolvers to their v2.1 behaviour, useful when a third-party profile causes unexpected silent deletions, or for A/B comparison on a specific repo.

### `@gitwand/core@2.3.0` — Tree-sitter structural merge

The big one. GitWand now does an **AST-based first pass** for TypeScript, TSX, JavaScript, JSX, Python, Go, and Rust files: parse `base` / `ours` / `theirs` with `web-tree-sitter`, pair top-level entities (functions, classes, methods, top-level statements) by canonical signature, and merge entity-by-entity — the same approach as Mergiraf and Weave. When the structural pass yields `null`, the existing hunk-based engine takes over, so there's no loss of coverage on cases the structural merge can't handle.

Three things make this stay browser-compatible. `web-tree-sitter` is an *optional* peer dependency (`>=0.20.0`) — consumers who don't need structural merge don't pay for the WASM. Grammars come from `tree-sitter-wasms` and load lazily, behind a loader that supports both v0.20 and v0.26 API shapes. And the loader uses three environment adapters (`structural/parsers/adapters/{node,browser,tauri}.ts`) so the package keeps zero static Node.js imports; the Node-specific path is dynamic and guarded.

The async entry point `resolveAsync()` runs the structural pass and falls back to `resolve()` when needed. The synchronous `resolve()` keeps its v2.2 contract for callers that don't want to wait on WASM init.

### Cherry-pick from the log, with conflict resolution

The right-click *Cherry-pick* entry in the commit log used to call `git cherry-pick` and assume it succeeded. It now treats conflicts as a first-class state: `isCherryPicking` stays `true` while there are unresolved conflicts, the desktop switches to the changes view and selects the first conflicted file (mirroring `mergeBranch()`), and auto-fetch/poll pause for the duration. `cherryPickContinue()` handles multi-pass conflicts — it keeps the cherry-pick mode active until everything is resolved. The conflict banner button reads *Annuler le cherry-pick* or *Annuler le merge* depending on which operation is in flight. New i18n key `header.abortCherryPick` across all five locales.

### Polish

- Test regression: the CSS resolver's reason string explicitly skips the structural merge path. Stylesheets aren't AST-parseable in the way the structural dispatcher expects, so the test pins this contract.
- The release workflow's auto-update manifest publish gains a fallback endpoint and tighter retry semantics — a transient hiccup on the primary endpoint no longer fails the whole release.
- The README and website drop the macOS Gatekeeper workaround. The app has been Developer-ID-signed and notarized since v1.9.0, so the manual `xattr -d com.apple.quarantine` step is no longer needed.

### Fixes

A Rust panic in the diff line-counter — caused by removed-line counts going negative on an unsigned int — is fixed; the counter now uses signed integers.

The PR create form's base-branch detection used to fail because the branch list was still empty when the form opened. The form now waits for the list and uses the raw branch name instead of the display string, so candidate-base resolution works.

Untracked file diffs now render in the UI — the desktop falls back to parsing the diff output for files Git doesn't yet track.

The Vite alias points at `packages/core` source instead of the prebuilt dist, so a fresh clone runs the desktop dev server without an extra build step.

---

## v2.0.1 — April 2026

### A friendlier update prompt

The in-app update modal used to render the GitHub release notes as-is — a download table with platform/file rows and a raw "see the changelog" link. Useful for CI debugging, less so when you're being told a new GitWand is available. The modal now shows a sparkle, the version, a one-line teaser, and a link straight to this page anchored at the right heading. The release manifest still carries the technical body for future iterations, but the modal stops surfacing it.

---

## v2.0.0 — April 2026

### Native macOS menu bar

GitWand has a proper File / Edit / Repository / View / Window / Help menu bar on macOS. Open repositories, clone or fork, find in log, merge, open the integrated Git terminal, toggle the sidebar — all from the system menu, with labels translated across the five supported locales. The menu rebuilds on locale change and on repo open/close, so repository-only items grey out when nothing is loaded.

### Clone & Fork from the UI

Three entry points for getting a repo without leaving the app: secondary buttons under the empty state, a `+` dropdown on the tab strip, and File menu items (`⌘⇧O` for Clone). Pick a parent folder, paste a Git URL, GitWand creates the subfolder named after the repo. Fork uses `gh repo fork --remote-name=upstream` so you get the right two-remote setup for upstream PRs out of the box — no terminal trip.

### Beta update channel

A new toggle in Settings → General opts you into the beta channel. Stable users keep the in-app one-click auto-install. Beta users get notified of pre-release builds and download from the GitHub release page manually — a deliberate split because the Tauri updater can't be retargeted at runtime, and we'd rather be honest about that than fake an auto-install path that doesn't exist.

### OpenAI Codex CLI provider

Pair GitWand with Codex the same way it pairs with Claude Code CLI. The app detects the `codex` binary, pings to check auth, then routes commit messages, branch-name suggestions, conflict resolution, PR descriptions, and the rest through `codex exec`. Works with your ChatGPT subscription via `codex login`, or with `OPENAI_API_KEY` — no extra setup, no API key entry in Settings.

### Dashboard contributors — full history, scrollable

Contributors on the Dashboard now reflect the entire HEAD history via `git shortlog -sne` instead of a windowed `git log -n 250` aggregation. The list scrolls horizontally with scroll-snap and a fourth card peeking in to cue the swipe — so you see every author who ever touched the repo, not just whoever committed last.

### Five menu accelerators long overdue

Small items that disproportionately reduce friction once they're wired:

- **`⌘F`** — focus the search input in the commit log (and switch to the log view first if you weren't already there).
- **`⌘⇧T`** — open the integrated Git terminal in an overlay.
- **`⌘⇧S`** — toggle the sidebar to reclaim horizontal space for the diff.
- **`⌘⇧U`** — open the undo / rewind popover (separate from `⌘Z`, which stays on text-undo so editing a commit message doesn't accidentally rewind a merge).
- **Repository → Merge…** — opens the merge picker directly from the menu.

Toggle Light/Dark Mode loses its `⌘⇧T` accelerator (now claimed by Open in Terminal per the v2 spec). Still in View, still on the header chip.

### Fixes

- `RepoTabStrip` `+` dropdown was clipped by the strip's `overflow-y: hidden` and silently invisible. The menu now teleports to `<body>` and positions itself via `getBoundingClientRect`.
- `BaseModal` primary / danger buttons used `opacity: 0.5` for the disabled state, which read as "still active" against saturated backgrounds in light mode. Disabled now flips to neutral background + muted text.
- Browser-mode `FolderPicker` opened *underneath* `CloneModal` and `ForkModal` because both layers used `z-index: 100`. The folder picker is bumped to `z-index: 200` — it always dominates the modal that triggered it.
- `codex exec` doesn't accept `--quiet` (we'd added it on a hopeful guess); removed from detection ping and prompt calls.

---

## v1.8.0 — April 2026

### Shared design chrome — BaseModal everywhere

Ten modals — `EditCommitOverlay`, `MergeSuccessModal`, `PrReviewModal`, `RebaseEditor`, `SettingsPanel`, `SplitCommitModal`, `StashManager`, `BranchRenameModal`, `BranchDeleteModal`, `SearchPalette` — all now share a single `BaseModal` wrapper that handles the backdrop, focus-trap, Esc-to-close, and footer layout in one place. Accessibility fixes apply everywhere at once; duplicated chrome is gone.

### AppHeader rebuilt as composable blocks

The 1654-line `AppHeader.vue` monolith is split into focused components: `SyncSplitButton`, `BranchSelector`, `BranchMenu`, `SearchTrigger + SearchPalette`, `RepoTabStrip`, and `HeaderLogo`. Each is typed, i18n'd across all 5 locales, and independently testable. The `⌘K` command palette surfaces branches, commits, and quick actions from anywhere in the app.

### Merge editor — line numbers and minimap

The merge editor gains per-line numbering on code and conflict panels, plus a right-side canvas minimap that highlights auto-resolvable vs manual conflicts. Click any region in the minimap to jump to that conflict — particularly useful across large merges with dozens of hunks.

### PR intelligence panel redesign

The intelligence panel replaces emoji section icons with accent-soft tiles, upgrades the scope grid to stat cards with a radial hover gradient, and unifies file/hotspot/AI flag rows with a `border-left` severity strip. The conflict summary became a success/danger banner. Loading states use a dot spinner; reduced-motion preferences disable all transforms and animations.

### Branch rename and delete modals

`BranchRenameModal` and `BranchDeleteModal` replace the inline `rename()` / `confirm()` flows. The delete modal includes a type-the-name guard for unmerged branches. Backed by a new `git_rename_branch` primitive with the full three-layer implementation (Rust + dev-server + TypeScript wrapper).

---

## v1.7.0 — April 2026

### Split commit by hunks

A new "Split this commit…" entry in the commit log's context menu opens a modal that lets you break a single commit into two by picking individual lines across files. Each file shows as a collapsible row with diff stats and a hunk count; expand it to pick which lines go into the first commit, with the rest flowing into the second automatically. Large commits (> 3 files) get an "Expand all / Collapse all" toolbar.

Split is also wired into interactive rebase: pick a commit, switch its action to `split`, and the rebase halts at that commit, opens the split modal with the commit preloaded, then resumes after you confirm. Splitting a merge commit is blocked at every entry point — doing so would silently drop the second parent and flatten history.

### Correct patch headers for file lifecycle events

Added and deleted files were causing `git apply --cached` to fail with "does not exist in index" when a split touched a file creation or deletion. The diff now carries `status` and `oldPath` from `git_show`, and `patchBuilder` emits the correct extended headers (`new file mode`, `deleted file mode`, `rename from/to`) to match.

### Fix: context-line detection in git_show parser

The final site that still used `!starts_with('\\')` to detect context lines — at line 1811 of the `git_show` parser — is now corrected to `starts_with(' ')`. Empty strings were misclassified as context lines, producing phantom context in splits touching empty-line boundaries.

---

## v1.6.3 — April 2026

### Worktree manager

Create, list, and remove Git worktrees from a dedicated overlay panel. Each worktree shows its branch, HEAD SHA, path, and status badges (main / locked / bare). "Open in tab" opens any worktree as a first-class repo tab, enabling parallel work on two branches without stashing or switching. Every non-current branch in the branch popover gains a one-click worktree shortcut (⧉ icon) for a two-click "open this branch without touching my working tree" flow.

### Submodule panel

A new "Submodules" header button lists all submodules declared in `.gitmodules` with live status badges (clean / modified / not initialized). "Init & Update all" runs `git submodule update --init --recursive`. "Open in tab" opens any initialized submodule as a standalone repo tab. An inline warning banner counts uninitialized submodules and doubles as a one-click init trigger.

### Auto-update infrastructure fixes

Several gaps in the auto-update setup that had been preventing `.sig` file generation and installer delivery on all platforms are resolved: `createUpdaterArtifacts: true` added to `tauri.conf.json`, permissions (`updater:default`, `process:default`, `process:allow-restart`) added to `capabilities/default.json`, the updater endpoint simplified to a static `latest.json`, and the release workflow corrected to use the cryptographically-signed manifest produced by `tauri-action` rather than a hand-crafted one with empty signature fields.

---

## v1.6.2 — April 2026

### Image diff viewer

Binary image files (PNG, JPG, WebP, GIF, SVG) now render in the commit diff with four comparison modes: side-by-side with dimension and size metadata, overlay with opacity control, blink alternating the two images to reveal pixel-level deltas, and a draggable reveal slider. A 20 MB per-side guardrail skips oversized images with an explicit notice. SVG files render as text, not raster. A new `read_file_at_revision(path, rev)` backend command fetches file bytes at any git revision, enabling comparisons across `HEAD^`, branches, stashes, and anything in between.

### Folder tree in commit diff

The file list in `CommitDiffViewer` gains a flat ↔ tree toggle. Tree mode shows an expandable folder tree with per-folder aggregates and a click-to-filter that narrows the list to a folder's descendants with a breadcrumb and clear button. The sidebar column is now resizable by dragging its left edge (180–600 px, double-click to reset, persisted in `localStorage`). Full keyboard navigation on the tree.

---

## v1.6.1 — April 2026

### MCP Registry — ownership verification fix

`@gitwand/mcp@1.6.0` was published without the `mcpName` field required by the MCP Registry for ownership verification, causing the initial submission to fail with HTTP 400. This patch adds `"mcpName": "io.github.devlint/gitwand"` to `packages/mcp/package.json` and re-publishes as `1.6.1`. The registry listing is now live at `registry.modelcontextprotocol.io`.

---

## v1.5.1 — April 2026

### Release build fix — tauri-bundler binary crash

The `parity_probe` test binary was declared as `[[bin]]` with `required-features`. The Tauri bundler auto-discovers every `[[bin]]` entry and tries to embed it as a sidecar regardless of whether the feature flag is enabled, which caused release builds to fail on every platform with "does not exist". The probe is moved to `[[example]]`, which the bundler ignores. Source moves from `src-tauri/src/bin/` to `src-tauri/examples/`.

### macOS permission dialogs — repeated prompts fixed

Opening the home directory was triggering a `.join(".git").exists()` probe on every child entry, hitting macOS TCC for `Documents`, `Desktop`, `Downloads`, `Pictures`, `Movies`, `Music`, and `Library` on each listing. A `MACOS_TCC_PROTECTED` guard now skips the `.git` probe for these well-known system folders — they're never git repos anyway.

### i18n sweep — composable error strings

The remaining hardcoded French error strings in the AI-powered composables (`useCommitMessage`, `useBranchName`, `useReleaseNotes`, and nine others) now route through the `errors.*` i18n namespace across all 5 locales.

---

## v1.5.0 — April 2026

### XSS hardening

All `v-html` usage now routes through a shared `useSafeHtml` / `useMarkdown` composable that sanitizes output with DOMPurify. README rendering, PR bodies, commit-message previews, and every other bit of user- or Git-authored markup is filtered through a conservative DOMPurify profile with a URI allow-list, `target="_blank" rel="noopener noreferrer"` hardening, and `javascript:` protocol blocking.

### English-first UI

The desktop app now defaults to English, with French as a secondary locale kept in sync. The locale registry's source of truth moves from `fr.ts` to `en.ts`. The Settings panel still lets you force either language; the OS locale is respected automatically.

### `.gitwandrc` — `generatedFiles` option

Users can now declare extra glob patterns in `.gitwandrc` (e.g., `"dist/**"`, `"**/*.generated.ts"`) that GitWand treats as generated when applying the `generated_file` resolver. Patterns are additive on top of the built-in list.

### Post-merge validation — YAML + TOML

The `validateMergedContent` contract is extended with format-specific parsers. Invalid YAML or TOML after a merge is surfaced as a `syntaxError` with a `YAML: …` / `TOML: …` prefix, matching the existing JSON behaviour.

### LCS memory — 35× reduction

The diff engine's LCS now runs a hybrid `Int32Array` DP under 4 million cells and switches to Hirschberg's divide-and-conquer above that threshold. Measured on 3000×3000 inputs: ~36 MB → ~1 MB. Tie-break behaviour is preserved so existing diffs are byte-identical.

### Parallel conflict loading

Conflicted files are now read in parallel (bounded concurrency) instead of serially in both the desktop app and the CLI. Throughput scales with file count on large merges.

---

## v1.4.0 — April 2026

### AI everywhere

Fourteen AI-powered features shipped across the v1.4 cycle: branch-name suggestion from staged diff or a description; PR title and description from the `currentBranch..base` diff; hunk-level critique in the PR review panel; natural-language conflict explanations in the merge editor; pre-merge risk summary; stash message from unstaged diff; semantic squash grouping in interactive rebase; AI-ranked Absorb target selection; natural-language commit search; blame context ("why did this line change?"); AI release notes generator; and rotating localised feature tips on the empty state.

### Conflict engine — pattern registry

The classification pipeline is rewritten around a prioritised pattern registry. Each pattern declares its `priority`, `requires` (diff3 / diff2 / both), `detect`, `confidence`, `explanation`, `passReason`, and `failReason`. Two new patterns are added: `reorder_only` (pure permutations, auto-resolved) and `insertion_at_boundary` (pure insertions on both sides with an intact base, auto-resolved). Confidence scoring is tuned with boosters, penalties, and stricter guarding on `complex`.

### Auto-update check

The app checks for new versions against the GitHub Releases feed on launch and shows a toast with a changelog link when a new version is available. The current version is visible in the footer / About section.

---

## v1.2.0 — April 2026

### Interactive rebase

Drag-and-drop reorder in the log, per-commit actions (squash, edit message, drop, fixup), multi-select squash with combined message, rebase onto branch from the UI, and in-flight conflict handling (continue / abort / skip).

### Absorb

Right-click any modified file to absorb it into an existing commit. GitWand finds the best candidate via `git blame`, or you can do a partial absorb by selecting specific hunks. Inspired by GitButler's absorb workflow.

### AI commit messages

A dropdown in the commit area analyses the staged diff and produces a summary and description. Provider-agnostic: Claude Code CLI, Claude API, OpenAI-compatible, and Ollama are all supported. Regenerate, shorten, expand, switch language — without leaving the commit panel.

### Universal Undo

An operation stack covering commit, merge, rebase, cherry-pick, stash, and discard. One-click undo via `git reset` / `git reflog`. The history panel lets you jump back to any prior state.

---

## v1.1.0 — April 2026

### MCP server

`@gitwand/mcp` ships with 5 tools (`gitwand_status`, `gitwand_resolve_conflicts`, `gitwand_preview_merge`, `gitwand_explain_hunk`, `gitwand_apply_resolution`) and 3 resources over stdio transport. Compatible with Claude Code, Claude Desktop, Cursor, and Windsurf. Includes `/resolve` and `/preview` slash commands for Claude Code.

### CLI — enriched JSON output

The CLI now emits confidence scores, decision traces, `pendingHunks` with ours/theirs/base, and post-merge validation results in `--json` mode.

### Partial resolution

The desktop app can now apply all automatically-resolvable hunks even when some hunks remain manual — you don't have to wait until everything is resolved before committing the safe ones.

---

## v1.0.0 — 2026

### Full desktop Git client + conflict engine

The first production release. The core engine covers 8 conflict patterns (same_change, one_side_change, delete_no_change, whitespace_only, non_overlapping, value_only_change, generated_file, complex), LCS 3-way merge, diff2 + diff3 format support, composite confidence scoring, configurable merge policies via `.gitwandrc`, and a full format-aware resolver suite (JSON/JSONC, Markdown, YAML, Vue SFC, CSS/SCSS, TS/JS imports, npm/yarn/pnpm lockfiles).

The desktop app ships a complete Git workflow: staging, commit, push/pull, branches, merge editor, advanced diff, history, DAG graph, file history, blame, time-travel diff, merge preview, cherry-pick, stash, amend, repo switcher, multi-tabs, terminal, PR workflow via `gh` CLI, inline code review, intelligence panel, AI suggestions (Claude / OpenAI / Ollama), i18n in FR and EN, and dark/light/system theme.

332 tests, a 20-fixture real-world corpus, and benchmarks at 249k ops/s on a single conflict. CI/CD runs on macOS universal, Linux, and Windows.

---

## v0.0.1 — April 2026

### First public build

The initial release proved out the core idea: a TypeScript conflict-resolution engine with 5 automatic patterns (same_change, one_side_change, delete_no_change, whitespace_only, non_overlapping), a CLI with `--ci / --json` structured output, a VS Code extension with inline diagnostics and CodeLens annotations, and a CI pipeline across Node 18, 20, and 22. 28 tests covering all patterns against real-world fixtures (package.json, Laravel routes, Vue SFC, CSS, .env files).
