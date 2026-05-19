# Changelog

All notable changes to GitWand will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.14.0] - 2026-05-19

v2.14 closes the remaining `ForgeNotImplementedError` gaps on GitLab and Bitbucket and makes all three intelligence methods (conflict preview, hotspots, file history) forge-agnostic.

### Added

- **GitLab diff-line discussions** — `createComment` now routes to the GitLab Discussions API (`POST /projects/:id/merge_requests/:iid/discussions`) when `path` + `line` are supplied, anchoring the comment to the exact diff line instead of posting a general MR note. New Rust command `gl_mr_create_discussion`; new TS wrapper `glMrCreateDiscussion` in `backend-gitlab.ts`.
- **Bitbucket CI checks** — `getCIChecks` wired to the Bitbucket Pipelines commit statuses endpoint (`/commit/{sha}/statuses`). The PR's `source.commit.hash` is extracted to form the URL, then each status is mapped to the common `CICheck` shape. New Rust command `bb_pr_ci_checks`; new TS wrapper `bbPrCiChecks`.
- **Bitbucket draft → ready** — `convertDraftToReady` strips the `"Draft: "` title prefix (case-insensitive) via a `PUT` PR update. New Rust command `bb_convert_draft_to_ready`; new TS wrapper `bbConvertDraftToReady`.
- **`updateComment` / `deleteComment` on GitLab and Bitbucket** — both methods now fully wired: GitLab via `gl_mr_update_note` / `gl_mr_delete_note`, Bitbucket via `bb_update_comment` / `bb_delete_comment`. `prNumber` added as optional 4th parameter to the `ForgeProvider` interface (required at runtime for non-GitHub providers; ignored on GitHub where comment IDs are globally unique).
- **`setAccount(account: Account | null): void`** — new method on `ForgeProvider` interface implemented by all three providers; stores an `Account` context in-memory to enable multi-workspace credential resolution (Bitbucket) and multi-profile switching (GitLab, GitHub) without re-authenticating.

### Changed

- **`getConflictPreview` / `getHotspots` — forge-agnostic** — both methods now delegate to the same local-git implementation (`ghPrConflictPreview` / `ghPrHotspots`) in `GitLabProvider` and `BitbucketProvider`. These methods run `git merge-tree` and `git log --merges` locally — no forge API required. The `forge.name === "github"` guard that was previously needed in consumers is no longer necessary.
- **`PullRequestPanel.vue` — forge bypass fixed** — the panel now uses `forge.value.getConflictPreview`, `forge.value.getHotspots`, and `forge.value.getFileHistory` through the resolved `ForgeProvider` instead of calling `gh*` functions directly.

### Technical

- `ForgeNotImplementedError` import removed from `GitLabProvider` and `BitbucketProvider` — all stubs replaced; no remaining `throw new ForgeNotImplementedError(…)` in either provider.
- `PrFileHistory` zeroed stubs corrected: `{ reviewCommentCount: 0, reviewers: [], lastComment: null }` — matches the actual interface shape.
- `CreatePrCommentParams.diff_hunk` reference removed from `GitLabProvider.createComment` — `diff_hunk` is not part of the interface; condition simplified to `params.path && params.line != null`.
- 128 tests green; TypeScript strict mode — 0 errors.

## [2.13.0] - 2026-05-18

v2.13 extends the AI commit workflow with named system-prompt presets and adds inline code suggestions directly in PR diffs.

### Added

- **AI Prompt Presets** — named system-prompt presets for commit message generation; four built-in presets (Default, Concise, Detailed, Emoji/Gitmoji) plus unlimited user-defined presets with a custom `systemPrompt` field; `${lang}` placeholder is substituted with the resolved commit-message language at generation time.
- **Preset CRUD in Settings → AI** — add, edit, and delete custom presets from a dedicated Presets section in the AI settings tab; built-in presets are read-only (displayed with a "built-in" badge).
- **Per-repo preset picker** — preset submenu in the commit-zone AI dropdown; active preset is persisted per repo in `AppSettings.activePresetIdByRepo`; selecting "Default" resets to the built-in conventional-commits prompt.
- **Inline Code Suggestions in PR diffs** — pencil "Suggest" button on every non-delete diff line in `PrInlineDiff`; clicking opens an inline editor pre-filled with the current line content; submitting serializes the change as a GitHub suggestion block (` ```suggestion ``` `) and stages it via the existing `add-to-review` mechanism.

### Technical

- New composable `useAiPromptPresets` — module-level CRUD (`addPreset`, `updatePreset`, `removePreset`, `setActivePreset`) + reactive composable wrapper; built-ins are immutable (id prefix `__builtin_`); stored in `AppSettings.aiPromptPresets`.
- `CommitMessageOptions.systemPromptOverride` — new optional field on `useCommitMessage.generate()` to inject a custom system prompt (replaces the default conventional-commits prompt); `${lang}` substitution applied.
- `useCommitMessage.transform()` unchanged — shorten/detail/changeLang transform actions remain independent of presets.
- 10 new unit tests for `useAiPromptPresets` (all CRUD paths + builtin immutability + repo override).

## [2.12.0] - 2026-05-18

v2.12 solves three daily workflow friction points: branches that pile up, multiple git identities, and repetitive commit messages.

### Added

- **Archived Branches** — archive any branch from its context menu; archived branches move to a collapsible "Archived" section in the dashboard sidebar and are never deleted from git.
- **Pinned Branches** — user-chosen branch pins replace the former auto-computed top-5 heuristic; pin/unpin via context menu, ordered list persisted per repo.
- **Branch badges** — "Merged" badge on branches already integrated into the default branch (`git branch --merged`); "Inactive" badge on branches silent for N days (configurable in Settings → Git).
- **Multiple Committer Identities** — named profiles (label, git name, email, optional GPG key) in Settings → Git → Identities; global default + per-repo override; discrete selector in the commit panel.
- **Commit Templates** — named templates (subject + body) in Settings → Git → Templates; apply via picker button or `/` autocomplete in the subject field; import from `.gitmessage` via `git config commit.template`.

### Changed

- `git_commit` Rust command accepts optional `identity_name` / `identity_email` params (non-breaking); injects `-c user.name=… -c user.email=…` when an identity is active.
- Dashboard sidebar branch section now driven by `usePinnedBranches`; falls back to top-5 by activity when no pins are set.

### Technical

- New Rust commands: `git_branch_merged`, `git_config_identity`, `git_commit_template_path`.
- New composables: `useArchivedBranches`, `usePinnedBranches`, `useIdentity`, `useCommitTemplates` — all state persisted in `AppSettings` via localStorage.
- i18n: ~28 new keys across `branch.*`, `commit.identityDefault`, `settings.git.*` in all 5 locales.
- 23 new unit tests (118 total, all green).

## [2.11.0] - 2026-05-18

v2.11 focuses on performance at scale and developer transparency — pagination for large repos, real-time feedback during clones, and full visibility into every git command GitWand runs under the hood.

### Added

- **Transparent command log** — new `⌘⇧L` / `Ctrl+Shift+L` shortcut opens a slide-in panel listing the last 200 git commands executed by GitWand (write operations only: commit, push, pull, fetch, merge, rebase, stash, cherry-pick, branch ops, clone). Each entry shows the command label, working directory (last 2 segments), wall-clock timestamp, execution time in ms, and exit code (green 0 / red non-zero). Implemented as an in-process ring buffer (`VecDeque<CmdLogEntry>`, cap 200, `OnceLock<Mutex<…>>`) in Rust — zero overhead when the panel is closed. New Tauri command `get_command_log`; new composable `useCommandLog` (module-level singleton so panel state survives remounts); new component `CommandLogPanel.vue` (560 px slide-in from right, `slide-right` transition).

- **Real-time clone progress bar** — the Clone modal now shows a live progress bar while `git clone` is running. Git's `--progress` flag writes carriage-return-delimited stage lines to stderr; the Rust `git_clone` command spawns the process, reads raw stderr bytes in 512-byte chunks, splits on `\r`/`\n`, and emits `clone-progress` Tauri events with `{ stage, percent, message }`. The Vue listener maps stages to weighted progress ranges: Counting objects 0–15 %, Compressing 15–25 %, Receiving objects 25–90 %, Resolving deltas 90–100 %. The event listener is cleaned up on unmount.

- **CommitLog pagination with infinite scroll** — the commit log now loads 100 entries at a time instead of a fixed 50. When scrolling within 200 px of the bottom of the log, the next page is fetched via `--skip=N` (Rust side) and appended to the existing list. A sentinel row below the virtualizer shows a spinner while the next page is loading, and disappears once the last page is reached (heuristic: fewer than 100 entries returned). Props `has-more` and `loading-more` thread from `useGitRepo` → `RepoSidebar` → `CommitLog`; emit `load-more` bubbles back up. Debounced with a `_loadMorePending` flag to prevent duplicate fetches during fast scrolling.

- **Fork Point visualization in CommitGraph** — divergence point between the current branch and its upstream is now marked with a distinct node style in the commit graph. The merge-base is detected server-side and surfaced via the existing `git_graph` data; the Vue renderer applies a `fork-point` CSS class to the corresponding node.

### Changed

- **`backend.ts` domain split** — the monolithic `src/utils/backend.ts` (900+ lines) is split into per-domain modules under `src/utils/commands/`: `branch.ts`, `commit.ts`, `diff.ts`, `forge.ts`, `graph.ts`, `index.ts`, `log.ts`, `repo.ts`, `stash.ts`, `tag.ts`, `workspace.ts`. `backend.ts` is now a thin re-export barrel; all existing imports continue to work without changes. This is a refactor only — no behaviour change.

- **`git_log` default page size** — increased from 50 to 100 entries per page (Rust `git_log` command).

### Technical

- New Rust commands: `get_command_log`.
- New composables: `useCommandLog`.
- New components: `CommandLogPanel.vue`.
- Rust `git_log` gains `offset: Option<i32>` parameter (`--skip=N`); parity shim in `lib.rs` passes `None`.
- TypeScript: zero errors. Tests: 95/95 passing.

## [2.10.0] - 2026-05-13

v2.10 opens GitWand to the broader forge ecosystem and brings the MCP ecosystem inside the app.

### Added

- **GitLab MR integration** — list, review, and merge GitLab Merge Requests without leaving the app. Uses the `glab` CLI, auto-detected on `$PATH`. Full feature parity with the GitHub PR panel: diff, CI status, inline comments, "Mark as ready" for drafts.

- **Bitbucket PR integration** — list and manage Bitbucket Cloud Pull Requests via the REST v2 API. No CLI dependency — authenticates via credentials stored in the OS keychain (`tauri-plugin-keyring`).

- **Multi-account forge support** — new **Settings > Comptes** tab to connect multiple GitHub, GitLab, and Bitbucket accounts (personal + work). GitWand resolves the right account for each repo from the remote URL; credentials persist in the system keychain and never touch localStorage.

- **Draft PR → Ready** — "Mark as ready" button in the PR detail view. GitHub: `gh pr ready`. GitLab: `glab mr update --ready`. One click, no terminal.

- **MCP catalog in Settings** — a new **MCP** tab in the Settings panel to browse, search, and install MCP servers without leaving GitWand.
  - Source: npm registry fallback (250+ packages with `keywords:mcp-server`), official MCP Registry when available.
  - **One-click install** into any detected config file: Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`), Claude Code global (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.windsurf/mcp.json`).
  - **Installed badge** — reads `server_keys` from every config file to show exactly which servers are already configured where.
  - **Smart input** — paste a `registry.modelcontextprotocol.io` URL for deep-link, type `@scope/package` to install directly from npm, or plain-text search across names and descriptions.
  - **`@gitwand/mcp` pinned at the top** with automatic `--cwd` injection and a "Reconfigure" shortcut.
  - **Manual fallback** — when running in browser/dev mode (no config files accessible), shows a copy-paste path with JSON copy button and the 4 standard config file locations.
  - New Rust commands: `mcp_detect_configs`, `mcp_read_config`, `mcp_install_server`, `mcp_uninstall_server`.

- **Settings panel redesign** — the Settings modal is now wider (`xl`, 960 px fixed at 72 vh) and replaces the horizontal scrolling tab bar with a left-side navigation sidebar. Groups: **Application** (Général, Éditeur), **Dépôt** (Git, Hooks, Comptes), **IA & Agents** (IA, MCP, Automations), **Système** (Logs). Footer shows the app version. No more layout shift on tab switch.

- **Check for updates from Settings** — "Vérifier les mises à jour" in the Système group. Spinner while checking; green "À jour" confirmation for 4 s if up to date; opens the update modal directly if a new version is found (single network call, no double-check).

### Changed

- **`ForgeProvider` abstraction** — new `forge/` layer routes all PR/MR operations through a typed interface (`GitHubProvider`, `GitLabProvider`, `BitbucketProvider`). Auto-detected from remote URL; multi-account overrides applied transparently. No API change for consumers of `usePrPanel`.

### Technical

- New Rust commands (18): `gl_mr_list/detail/merge/ready`, `bb_pr_list/detail/merge`, `gh_pr_ready`, `keyring_set/get/delete`, `mcp_detect_configs/read_config/install_server/uninstall_server`.
- New composables: `useForge`, `useAccounts`, `useCredentials`, `useMcpRegistry`.
- New components: `SettingsAccountsTab.vue`, `SettingsMcpTab.vue`.
- TypeScript: zero errors. Tests: 95/95 passing.

## [2.9.0] - 2026-05-12

Launchpad — cross-repo dashboard inspired by GitKraken's Launchpad but local-first (no cloud, no account). Closes the v2.9.0 ROADMAP entry. Audit established the chantier was ~95% implemented across previous unmerged work; this release wraps the closure (keyboard shortcut, tab persistence, lazy Team tab, UI tests) and ships. Detail per task in [PLAN-v2.9-launchpad.md](./PLAN-v2.9-launchpad.md).

### Added

- **Launchpad — cross-repo dashboard for workspaces** (depends on v2.7.0 Workspaces). Single full-screen view with four tabs aggregating across every repo in the active workspace:
  - **WIP tab** — repos with uncommitted changes or branches behind upstream. Staged / unstaged / untracked counts, ahead/behind, no-upstream warning, last commit timestamp. Powered by `workspace_wip_all` (libgit2, P3.3a — from v2.8.2 perf hardening).
  - **PRs tab** — open pull requests across all workspace repos via `gh pr list` (now with the v2.8.5 lightweight payload). Renders Draft / Approved / ChangesRequested / Review-Required badges, CI rollup status, labels, per-repo error states. Secondary row shows assignees and review-requested users as chips (up to 3 each + `+N` overflow).
  - **Issues tab** — open GitHub Issues via `gh issue list` with three filters (Assigned to me / Mentioned / Created by me). Milestone badge, labels, per-repo errors.
  - **Team tab** — colleagues' open PRs grouped by author with overlap detection: intersection between my WIP files (staged + unstaged) OR my un-merged commits and the files touched by each colleague's PR. Avatars use deterministic colour from a 6-colour palette. Auto-expand members with overlap. Identity resolved via `gh api user --jq .login` (module-level cache). PR file lists fetched lazily with `concurrentMap(limit=5)` to stay within GitHub rate limits.
- **Pin / snooze for PRs and Issues** — module-singleton `useLaunchpadPins` composable persists to `localStorage` under key `gitwand-launchpad-pins`. Pin sorts the item to the top of its list; snooze removes it from view for 1, 3, 7, or 14 days. Per-item `⋮` menu in the row exposes both actions. A "N item(s) snoozed" banner above the list lets you peek at the snoozed items and unsnooze any of them. Snooze takes priority over pin so a snoozed-and-pinned item stays hidden until its preset elapses. Lazy-prune of expired snoozes on every write. 8 unit tests cover the singleton, sort order, expiry, and persistence round-trip.
- **Keyboard shortcut `⌘L` / `Ctrl+L`** — opens the Launchpad from anywhere via the new **View > Open Launchpad** menu entry. Gating: if no workspace is defined, the shortcut toasts a warning ("Create a workspace first to use the Launchpad") and opens the Workspace panel instead.
- **Tab persistence** — `launchpadActiveTab` (`"wip" | "prs" | "issues" | "team"`) is now part of `AppSettings` and survives between Launchpad opens. If the persisted tab is "team" the lazy fetch fires on mount instead of waiting for a click. Default remains `"wip"`.
- **Refresh all button** — alongside the existing "refresh current tab" button, a new "Refresh all" button fans out `refreshWip` / `refreshPrs` / `refreshIssues` / `refreshTeam` via `Promise.all`. SVG double-arrow icon with spin animation during the run. Combined loading state disables both refresh buttons.
- **Settings toggle "Disable Launchpad Team tab"** — `launchpadTeamTabEnabled` (default `true`) hides the Team tab entirely when off, for users on small teams or perf-sensitive setups who don't want the per-PR `gh pr view --json files` cost.

### Changed

- **Launchpad re-framed as a full-screen modal.** Previously the Launchpad was an opaque panel that filled the viewport edge-to-edge, hiding the app entirely. Now it renders as a centered card with a 2 rem inset on every side over a dimmed-and-blurred backdrop (`var(--color-overlay)` + `backdrop-filter: blur(4px)`, same pattern as `BaseModal`). The card itself uses `--color-bg-secondary` (the canonical white surface, `#ffffff` light / `#1a1a26` dark — no more "is it grey?" ambiguity), `--radius-2xl` rounded corners, `--shadow-xl` elevation, and a subtle `scale(0.985) → scale(1)` slide-in animation. The blurred view of the app behind keeps spatial context (you remember which repo you came from, where the menu is, etc.) and matches user expectations of a modal overlay.

- **Launchpad design pass — full alignment with the app's design system.** The original `LaunchpadView.vue` styles were written with hardcoded fallback hex colours (`#3182ce`, `#718096`, `#e53e3e`, etc.) and references to **non-existent tokens** (`--color-surface-raised`, `--color-surface`) which silently fell through to the hardcoded white/grey backgrounds in dark mode — the whole tab read "work in progress". Refactor (style block only, template/script intact so the 95 tests stay green):
  - All hardcoded hex fallbacks removed. Every colour now resolves through the canonical tokens defined in `assets/main.css`: `--color-bg{,-secondary,-tertiary}`, `--color-text{,-muted,-subtle}`, `--color-border{,-strong}`, `--color-accent{,-hover,-soft,-text}`, `--color-{success,warning,danger,info}{,-soft}`, `--color-focus-ring`.
  - All spacing converted from ad-hoc `12px` / `0.5rem 1rem` literals to `var(--space-N)` (4 px base). All `border-radius` to `var(--radius-{xs,sm,md,lg,pill})`. All font sizes to `var(--font-size-{xs,sm,base,md,lg,xl})` and weights to `--font-weight-{regular,medium,semibold,bold}`.
  - **PR / Issue / WIP rows** : surface `--color-bg-secondary` with `1px` border that brightens to `--color-border-strong` on hover; padding and density match `PullRequestPanel.vue` / `StashManager.vue`. Repo / milestone chips use `--color-bg-tertiary` pill shape.
  - **Status badges** mapped semantically: Approved + CI Success → `--color-success-soft`/`--color-success`, Changes Requested + CI Failure → `--color-danger-soft`/`--color-danger`, Review Required + CI Pending → `--color-warning-soft`/`--color-warning`, Draft → `--color-bg-tertiary`/`--color-text-muted`. All pill-shaped with `--font-weight-semibold`.
  - **Tab strip** : active indicator is a 2 px underline (replaces the previous solid accent block), inactive tabs muted, hover lifts to `--color-text`, tab badges use `--color-accent-soft` idle / full accent when active. Focus-visible outline on every interactive element.
  - **`⋮` menu dropdowns** now use `--shadow-popover` (the canonical popover shadow), `--color-bg-secondary` panel, slide-down animation via `--transition-base`. Snooze submenu items are aligned to the same x-position as parent menu items.
  - **Team panel** : member cards use `--color-bg-secondary` + border + `--radius-md`. Overlap members use `--color-warning-soft` background + `--color-warning` border + warning-text badge (replaces the previous Catppuccin hardcoded `#f38ba8` / `#2a1e2e` that didn't read in light mode). Avatars enlarged 20 px → 24 px with subtle border. Per-PR rows in expanded member cards use `--color-bg` with proper borders (replaces `rgba(0, 0, 0, 0.2)` which inverted in light mode).
  - **Snoozed bandeau** : tertiary background with hover that grades through to primary surface; reveal/hide toggle aligned right via `margin-left: auto`.
  - **PR people chips** (assignees / reviewers from v2.9 Wave B) : assignees use `--color-accent-soft` + `--color-accent`, reviewers use `--color-warning-soft` + `--color-warning` (replaces the v2.9 first-pass `#fef3c7` + `#92400e` hardcoded values). Separated from the row body by a dashed border-top.
  - **All 12 emojis** (📌 pin × 6, 💤 snooze × 6, ⚠ warning × 2) replaced with 14 px SVG inline icons consistent with the rest of the app. Each menu item now uses `display: flex; align-items: center; gap: var(--space-2)` to align the icon and the label cleanly. New CSS slots `__pin-badge`, `__menu-icon`, `__bandeau-icon`, `__warning-icon`.
  - Hover, focus-visible, and transition states added to every interactive element. Dark mode parity verified: now that everything resolves through tokens, both themes are first-class.
  - Style block grew from 674 → 962 lines, but the added volume is hover/focus/transition declarations + comments, not duplication. No new dependencies. No template changes — 95/95 tests still green.

- **Team tab is now lazy-loaded** — `refreshTeam(repos)` no longer fires in `LaunchpadView.vue#onMounted`. Eager refreshes stay on `wip` / `prs` / `issues` (fast, parallel, bounded). Team only fetches on the first click of the tab (or via Refresh-all). A placeholder ("Team activity not loaded yet") with a "Load team activity" button shows on the empty Team panel. Same pattern as the lazy PR loading shipped in v2.8.5; on a 50-PR-colleague workspace this saves ~10 s off the Launchpad first open.
- **Homogeneous loading state across all four tabs** — central 24 px SVG spinner on first load (empty tab), top-right 16 px spinner on subsequent refreshes (data already shown). Uses `var(--color-accent)`. Same animation across tabs; previously only Team had a plain "Loading…" string.

### Tests

- **`apps/desktop/src/components/__tests__/LaunchpadView.test.ts`** — 11 new UI smoke tests using Vue 3's native `createApp` + `nextTick` (no `@vue/test-utils` dependency added). Coverage: initial render (4 tabs), Team tab hidden when toggle off, default tab from settings, tab switch fires correct refresh, `⋮` menu opens with Pin + Snooze, Pin action wired to `useLaunchpadPins.pin`, Snooze submenu with 4 presets, close emit on `✕`, Refresh all fans out to all four refresh mocks, Team click triggers lazy refresh, persisted activeTab honoured at mount, `onMounted` eager refreshes wip/prs/issues.
- 36 existing Launchpad composable tests preserved (pins / prs / issues / wip / team).
- **Total desktop tests: 95/95 passing** (84 from v2.8.5 + 11 new UI smoke), `vue-tsc --noEmit` clean.

### Notes

- Naming inconsistency `pr_files` (Rust) vs `ghPrFiles` (TS wrapper): documented in `commands/ops.rs` above the command. Renaming the Tauri command would be a breaking change for external callers (parity probes), not worth it.
- Homepage redesign still pending decision (see `project_homepage_redesign.md` memory). A Launchpad feature card on `HomeLanding.vue` will be added in the next homepage pass, not piecemeal here.

---

## [2.8.5] - 2026-05-12

Critical lag fixes that surfaced post-2.8.4 release. The v2.8.2 perf hardening had attacked the symptoms (slow renders, polling churn) but missed the dominant root causes hiding beneath. Two compounding bugs were responsible for the bulk of the perceived lag and the wave of mysterious `[TAURI] Couldn't find callback id` warnings in the console. Diagnosed from Safari Web Inspector logs.

### Fixed

- **CSP blocked Tauri 2 IPC — every command was falling back to `postMessage`.**
  - `connect-src` in `tauri.conf.json` was `'self' http://localhost:3001` only. Tauri 2 IPC uses `ipc://localhost/<cmd>` (macOS/Linux) or `http://ipc.localhost/<cmd>` (Windows), neither of which were allowed. Every IPC call (`git_status`, `git_repo_state`, `git_exec`, `git_remote_info`, `set_git_config`, `plugin:menu|*`, …) was rejected by the CSP, triggering Tauri's `postMessage` fallback path — significantly slower and prone to callback-id races.
  - Fix: `connect-src` now includes `ipc: http://ipc.localhost http: https:` to cover Tauri IPC on all platforms plus user-configurable AI providers (Anthropic / OpenAI-compat / Ollama / custom endpoints, e.g. `http://localhost:11434/api/tags` for the Ollama detection probe). `img-src` opened to `https: http:` for README badges (shields.io, github user-content) that were also rejected.
  - Security posture preserved: `script-src 'self' 'wasm-unsafe-eval'` is unchanged — no remote code execution surface added. Only data fetches and IPC channels were unblocked.

- **macOS GUI apps lacked the user's shell env — subprocess auth lookups hung indefinitely.**
  - Apps launched from Finder/Dock/Spotlight inherit `PATH=/usr/bin:/bin:/usr/sbin:/sbin` plus `HOME`/`USER`/`TMPDIR` from launchd, but nothing from `~/.zshrc`, `~/.zprofile`, `~/.bashrc` — so no `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`, `LANG`, custom `PATH` prefixes (asdf/mise/nvm), nix-darwin exports, etc. `gh`'s credential chain then fell back to the macOS keychain helper from a launchd-spawned process, where the authorization prompt fires silently or retries indefinitely.
  - Fix in new `apps/desktop/src-tauri/src/shell_env.rs`: at `run()` startup, spawn `$SHELL -l -c env` once (bounded by a 3-second timeout — a misbehaving rc file can't freeze app launch), parse the output, and `std::env::set_var` everything not already set. `PATH` is skipped (`hidden_cmd` owns it for Homebrew-prefix enrichment predictability); `PWD`/`OLDPWD`/`SHLVL`/`_`/`SHELL` skipped (shell-local noise). All subsequent subprocess (`gh`, `claude`, `codex`, `git`, etc.) inherit the enriched env. No-op on Linux/Windows. Same approach used by VS Code, Sublime, IntelliJ.

- **Offline detection false-positive on networks that block SSH port 22.**
  - The connectivity probe was using the URL-derived port (22 for SSH remotes, 9418 for `git://`, etc.) to test if the host was reachable. Corporate networks like Dendreo's routinely block outbound port 22 while allowing HTTPS through proxies/tunnels — so SSH remotes would falsely report "Offline" even though `git fetch` worked fine.
  - Fix in `commands/network.rs#check_remote_reachable`: always probe HTTPS/443 first (universally open wherever internet exists), and only fall back to the URL-derived port if 443 itself fails. Catches enterprise SSH-only hosts as a last resort. Connectivity is now a "can I reach this host?" question, not "can I git over this exact protocol?".

- **`gh` subprocess hung on signed Tauri.app even with the right env — keychain ACL trust mismatch.**
  - Even with the full shell env, `gh pr list` from the signed GitWand.app subprocess hung because the macOS keychain ACL treats the signed Developer ID app as a different application than iTerm/Terminal, and the `security` helper called by `gh` to retrieve the OAuth token waited for a foreground UI prompt that never fires in the webview context.
  - Fix: `init_login_shell_env()` also runs `$SHELL -l -c "gh auth token"` once from the login shell (where the keychain ACL is authorized) and `std::env::set_var("GH_TOKEN", …)`. `git/cmd.rs#hidden_cmd` now explicitly propagates `GH_TOKEN` and `GITHUB_TOKEN` to every subprocess (belt-and-suspenders against any future `env_clear()` or tokio-runtime peculiarity). gh subprocess from Tauri now skip the keychain helper entirely.

### Changed

- **Boot perf — `gh pr list` payload + lazy PR loading.**
  - `gh_list_prs` heavy fields (`statusCheckRollup`, `mergeStateStatus`, `reviewRequests`, `reviewDecision`, `additions`, `deletions`) dropped from the initial list. Each cost a per-PR roundtrip to the GitHub API internally — for a repo with 100+ open PRs (Dendreo-class), the full query returned `HTTP 502 Bad Gateway` from GitHub's GraphQL endpoint after >30s, tripping the IPC timeout. The list query now returns 12 cheap fields; heavy data is lazy-loaded when the user opens a PR's detail view.
  - `--limit` reduced 50 → **10** with new cursor-friendly pagination. `gh_list_prs(cwd, state, limit, offset)` accepts page parameters; `PrListSidebar.vue` uses `IntersectionObserver` on a sentinel `<div>` to trigger the next 10-PR page when the user scrolls near the bottom. Deduplication by PR `number` handles list shifts between fetches.
  - New lightweight `gh_pr_count(cwd, state)` Rust command (3-layer: `commands/gh.rs` + dev-server `/api/gh-pr-count` + TS `ghPrCount`). Single GraphQL `totalCount` call (~150 ms, no per-PR roundtrip) replaces the heavy `gh pr list` call previously fired at every boot just to populate the Dashboard "Open PRs" stat card.
  - `DashboardView.vue` boot Promise.all dropped from 8 to 7 entries: the old `ghListPrs(cwd, "open")` slot is now `ghPrCount(cwd)` (assignment, not `.length`). The merged-PRs count is deferred to v2.9 (Phase 2 — needs a `ghMergedSinceCount(cwd, since)` command to stay cheap).
  - `PullRequestPanel.vue` no longer auto-loads PRs on `onMounted` — `loadPrs()` only runs when `props.show` flips to true (PR tab opened). cwd changes while the panel is hidden reset the list without spawning `gh`.
  - `workspace_prs_all` (`commands/workspace.rs`) reduced `--limit 100 → 10` with the same lighter JSON field set, since multi-repo workspaces multiply the per-PR roundtrip cost.

### Phase 2 deferred (v2.9)

- Cursor-based `gh api graphql` `pullRequests(first:N, after:CURSOR)` to replace the naive `offset+limit` re-walk (current implementation re-fetches all previously-loaded pages each scroll).
- `gh_pr_status_rollup(cwd, numbers[])` batched call to repopulate CI/merge badges on the list without requiring a click.
- `ghMergedSinceCount(cwd, since)` for the Dashboard "N merged this week" hint (currently stuck at 0).
- Re-enrich the "Reviews" PR filter (currently shows empty list — depends on lazy enrichment landing).

### Notes

- The previous v2.8.4 tag bundled only the Quick Fixes work (see entry below). The CSP / shell_env / boot-perf fixes here were on top but the tag did not move — so v2.8.5 is the first release where they ship to users.
- Verified: `pnpm test` → 84/84 desktop, `pnpm exec vue-tsc --noEmit` → clean. Rust changes (`shell_env.rs`, `commands/gh.rs`, `commands/workspace.rs`, `git/cmd.rs`, `commands/network.rs`) require `cargo check` host-side.

---

## [2.8.4] - 2026-05-12

Quick fixes batch — 2 bugs, 6 UX polish, 1 feature (Mode hors-ligne). Closes the "Quick Fixes" section of the ROADMAP. Detail per chantier in [PLAN-quick-fixes.md](./PLAN-quick-fixes.md).

### Fixed

- **Global search palette — stale branches on repo switch** : `useGitRepo.ts` adds a `watch(folderPath, …)` that invalidates `branches` and `log` whenever the active repo changes. The inline reset inside `openRepo`/`closeRepo` is kept as defense-in-depth.
- **PR sidebar empty when PRs exist** : root cause was an atomic `Vec<GhPrRaw>` deserialization that failed when any PR had `author: null` (deleted user, GitHub App bots) or `assignees[].login: null` — the whole list was dropped, surfacing as a generic error. Refactored `parse_gh_pr_json` to two-pass tolerant: parse to `Vec<Value>` first, then try each PR individually; structurally-broken entries are skipped and logged to stderr Rust. `GhPrAuthor.login`, `GhPrAssignee.login`, `GhPrRaw.author` now `Option<>` with `#[serde(default)]`. 3 new Rust tests (`parse_pr_with_null_author_does_not_drop_list`, `parse_pr_with_null_assignee_login_keeps_others`, `parse_pr_list_skips_unparseable_entry`).

### Changed

- **Repo `+` dropdown — recent and pinned repos** : `RepoTabStrip.vue` extended with two sections (pinned + recents) under the existing Open / Clone / Fork actions, separated by `<hr>`. Cap 8 entries combined (pinned first), `max-width: 320px`, `max-height: 360px`, vertical scroll. Empty state is handled cleanly (no orphan `<hr>`). +1 i18n key × 5 locales (`tabStripPinnedSection`); the existing `tabStripRecentSection` is reused.
- **Push confirmation when unpushed tags exist** : new 3-layer command `git_unpushed_tags(cwd, remote)` (Rust `commands/ops.rs` + dev-server `GET /api/git-unpushed-tags` + TS `gitUnpushedTags`) — deterministic diff between `git tag -l` and `git ls-remote --tags --refs <remote>`. `App.vue#handlePush` intercepts the push, opens an inline `BaseModal` with 3 actions (Push with tags / Push without tags / Cancel) when the list is non-empty, otherwise pushes directly. Best-effort: a probe failure falls back to a standard push (no UX blocking). 5 i18n keys × 5 locales (`push.tagsConfirm.*`).
- **Tags modal — buttons aligned with design system** : `TagsPanel.vue` "Nouveau tag" and "Pousser tout vers origin" buttons now use a new `.tp-btn-sm` class (`height: 32px`, `padding: var(--space-2) var(--space-4)`, `font-size: var(--font-size-sm)`) matching `StashManager`'s `.sm-btn-sm`. Specificity (0,1,0) preserved per the BaseModal rule.
- **Rewind button — Light mode contrast** : `AppHeader.vue#.undo-entry-btn` already used `background: var(--color-bg-secondary)` which resolves cleanly to `#ffffff` (light) / `#15151f` (dark). Inline CSS comment expanded to document the theme intent and prevent future regression to `transparent`.
- **Red error banner replaced by in-app Logs panel** : new `useLogs.ts` composable (module-level singleton, `LogEntry { id, timestamp, level: "error"|"warn"|"info", message, context? }`, FIFO cap 500 with `splice` eviction, `unreadCount` ref, `pushLog`/`clearLogs`/`markAllRead`, in-memory only — no `localStorage`). New Logs tab in `SettingsPanel.vue` with structured rendering (`[YYYY-MM-DD HH:mm:ss] LEVEL message` + optional context block), `Clear` button, `markAllRead` on tab mount. Status-bar indicator in `AppHeader.vue` with pill counter (caps visually at `99+`), tooltip "{count} unread logs". Lightweight `error-toast` (3s auto-dismiss, "View logs" jump button) is preserved for immediate critical errors (clone/push fail) — these errors also `pushLog("error", …)` so they accumulate. 15 new i18n entries (`logsLevelError`, `logsLevelWarn`, `logsLevelInfo` × 5 locales) plus reworded `logsEmpty` strings.

### Added

- **Sidebar PR — "Assigned to me" filter** (verified — already shipped in a prior iteration). 3-position toggle All / Assigned / Reviews in `PrListSidebar.vue`, Rust command `gh_current_user` (wraps `gh api user --jq .login`) cached at module level, `usePrPanel.ts#displayedPrs` computed filters by `assignees` (assigned mode) or `reviewRequested` (reviews mode). Identity banner with retry button when current user can't be resolved. Dedicated empty states for both modes. 15 locale keys × 5 locales already in place.

- **Offline mode** :
  - New Rust command `check_remote_reachable(url, timeout_ms)` in `commands/network.rs` — `reqwest::Client::head()` for HTTPS, `TcpStream::connect_timeout` fallback for SSH (`git@host:owner/repo` SCP-form), `ssh://`, `git://`, and IPv6 bracketed URLs. Strips `user:pass@` credentials. 11 Rust unit tests on the URL parser.
  - New `useConnectivity.ts` composable (module-level singleton — `isOnline`, `lastCheckedAt`, `checking`). `probeConnectivity(cwd)` reads `gitRemoteInfo` then calls `checkRemoteReachable(2000ms)`. Logs `info`/`warn` transitions via `useLogs`. Listens to `window.online` (optimistic flip + poller confirmation) and `window.offline` (immediate flip).
  - Polling integrated into `useRepoPoller`'s existing 2-second heartbeat via new optional `onConnectivityTick` callback gated to every 15 ticks (~30s). No new independent timer (respects the polling-discipline invariant from v2.8.2).
  - New `networkGuard.ts` helper exporting `requireOnline(operationLabel): boolean` — synchronous, logs `warn` + shows toast and returns `false` when offline. Wrapped on 9 Tauri network call sites: `fetchRemote`, `push`, `pull` (`useGitRepo.ts`), `gitClone` (`CloneModal.vue`), `ghFork` (`ForkModal.vue`), `ghListPrs` / `ghCreatePr` / `ghCheckoutPr` / `ghMergePr` (`usePrPanel.ts`). Guard runs *before* IPC, so no spinner is ever started on a network operation while offline.
  - "Offline" badge in `AppHeader.vue` driven by `isOffline = navIsOffline || !probedOnline` computed; `SyncSplitButton` accepts `:disabled="isOffline"` for push/pull/sync.
  - 8 new i18n keys × 5 locales (`connectivity.{offline.badge,offline.tooltip,offline.disabledOp,offline.opSkipped,online.reconnected,offline.detected,probe.error,probe.label}`).
  - 8 vitest tests in `connectivity.test.ts` covering probe flip, log transitions both ways, no-repo path, no-remote path, guard true/false, guard log. **84/84 desktop tests green.**

### Test results

- `cd apps/desktop && pnpm test` → 84/84
- `cd apps/desktop && pnpm exec vue-tsc --noEmit` → clean
- New Rust unit tests (11 in `network.rs` + 3 in PR parser): cargo run required host-side (sandbox cargo unavailable)

## [2.8.3] - 2026-05-12

### Added

- **LLM fallback tie-in (closes v2.5.0 across consumers)** — `@gitwand/core@2.5.0` shipped the `llm_proposed` pattern + `resolveAsync` + `LlmEndpoint` injection earlier; this batch wires it through every consumer.
  - **Desktop** : new "AI fallback" section in `SettingsPanel.vue` (toggle, provider picker `claude` / `claude-code-cli` / `codex-cli` / `openai-compat` / `ollama` / `mcp`, `minPostMergeScore` 50-100 slider, `contextLines` 10-200, `minMode` `off`/`balanced`/`strict`). Persists to `.gitwandrc.llmFallback` via new 3-layer `write_gitwandrc` (Rust `commands/files.rs` + dev-server `POST /api/write-gitwandrc` + TS `backend.ts#writeGitwandrc`). `useGitWand.ts` reads the config on file open and injects an `LlmEndpoint` into `resolveAsync` when enabled; `useAIProvider.toLlmEndpoint()` bridges to the existing AI provider stack. New `LlmTracePanel.vue` component renders the `LlmTrace` (model, validation score with red/amber/green bucket, latency, prompt hash click-to-copy, raw response truncated to 2 KB) above the conflict hunk in `MergeEditor.vue` whenever `decision.type === "llm_proposed"`; per-hunk Accept / Reject buttons downgrade to manual resolution on reject. ~80 new i18n entries (16 keys × 5 locales).
  - **CLI** : new `--llm-fallback`, `--llm-provider {claude,openai,ollama}`, `--llm-model` flags on `gitwand resolve`. Switches from `resolve()` to `resolveAsync()` and builds a Node-side `LlmEndpoint` via native `fetch` (Node 20+, zero new dep — no `node-fetch`, no SDK). Claude reads `ANTHROPIC_API_KEY`, OpenAI reads `OPENAI_API_KEY`, Ollama hits `${OLLAMA_URL || http://localhost:11434}/api/chat`. Stderr warning at startup ("LLM fallback enabled — your code will be sent to …"). `--json` output now includes per-resolution `llmTrace`. 13 vitest unit tests covering each provider's request body, headers, response parsing, and error paths. Backwards-compatible: without the flag, `resolve()` is called exactly as before.
  - **MCP** : new `gitwand_resolve_hunk` tool exposed by `@gitwand/mcp`. Inversion of the CLI flow — instead of GitWand calling a remote LLM, the connected agent (Claude Code, Cursor, Windsurf, etc.) *is* the LLM and resolves the hunk inside its own tool-call loop. Pure prompt builder, zero `fetch`, zero API key. README and CLAUDE.md updated for the 6-tool surface.
  - **Validation** : `packages/core/src/__tests__/bench/congra-mini.test.ts` — 15 hand-crafted fixtures across TS, Python, Go, Rust, JSON, Markdown (4 easy, 7 medium, 4 hard difficulty distribution), each forcing a `complex` classification. Mock endpoint deterministic. Result: **15/15 (100 %) resolved by `llm_proposed`** with validation score 100 across the board (target ≥ 80 % met). `apps/desktop/src/__tests__/llm-fallback-integration.test.ts` — 4 composable-level scenarios (happy path, validation-failure rejection, disabled fallback, missing provider) mocking `readGitwandrc`, `getConflictedFiles`, `toLlmEndpoint`, `useFolderHistory`, `useI18n`.
  - **Docs** : new `website/guide/llm-fallback.md` (why opt-in, how to enable across the three surfaces, supported providers, validation policy, audit trail, revocation, FAQ on confidentiality and cost — ~0.015 $/hunk on Sonnet, browser-safe contract). New `website/blog/v2-5-llm-fallback.md` (~2 100 words: state of the art ConGra + Project Harmony, architecture of `llm_proposed` priority 998, CLI walkthrough, rejection by design, MCP roadmap).
  - **Test results** : `pnpm test` → 901/901 core, 76/76 desktop. `tsc --noEmit` clean on `apps/desktop`, `packages/cli`, `packages/mcp`. VitePress build clean.

## [2.8.2] - 2026-05-11

Performance hardening release. After a fluidity regression observed between v2.6 → v2.8, ~30 chantiers were delivered across 6 optimization levels (frontend, polling/IPC, backend Rust, bundle, measurements, code structure). Behaviour is unchanged for end users — this is consolidation, no new commands or API surface. Detail per chantier in [PERFORMANCE_PLAN.md](./PERFORMANCE_PLAN.md).

### Changed

- **Frontend — cold start**
  - 20 panels and modals are now lazy-loaded via `defineAsyncComponent` (Settings, Stash, Merge editor, Rebase editor, Split commit, Branch rename/delete, PR Review, PR Create, Tags, Hooks, Worktrees, Submodules, Agent Sessions, Launchpad, Workspaces…). Each becomes its own Vite chunk, removed from the initial JS parsed at app launch.
  - 17 highlight.js languages moved to dynamic-import chunks (Rust, Go, Python, Java, SQL, PHP, C/C++, etc.). Only the 9 most-used languages remain in the main bundle. Saves ~150-250 KB gzipped off the cold start.
  - README badges in the Dashboard now use `loading="lazy"`, `decoding="async"`, `referrerpolicy="no-referrer"` so external image fetches no longer block first paint.

- **Frontend — DiffViewer hot path**
  - Two-layer cache for syntax highlighting: `_hlCache` in `highlight.ts` (content + language → hljs output) plus `_dvHlCache` in `DiffViewer.vue` (content + language → safeHtml-ready HTML). No more re-tokenisation per render tick.
  - `wordDiff` now computed once per diff in a single pass producing both `sbsByHunk` (side-by-side mode) and `inlineMap` (inline mode). Previous code ran `wordDiff()` twice on the same hunks.
  - `CommitGraph.vue` adds deep-equality on props and viewport culling.
  - `SearchPalette.vue` query input now debounced at 150 ms.

- **Polling and IPC**
  - All polling consolidated into a single `useRepoPoller` timer in `App.vue` with callbacks `onStatusChange`, `onConflictDetected`, `onFetchTick`, `onNightlyTick`. Replaces the 3 independent timers that contributed to the v2.6 → v2.8 regression.
  - Polling now pauses on `visibilitychange` when the GitWand window goes to the background, and resumes immediately on refocus.
  - The 3-second rebase-detection poll only runs while a rebase is actually in progress (was running unconditionally — root cause of the regression).
  - `tauriInvoke()` now has a default 30-second timeout, plus `IPC_TIMEOUT.NETWORK` (5 min for push/pull/fetch/clone) and `IPC_TIMEOUT.NONE` (AI prompts) presets. No more indefinitely-blocking IPC promises.

- **Backend Rust**
  - `Cargo profile.release` tuned: `lto = "fat"`, `codegen-units = 1`, `strip = true`, `panic = "abort"`. Smaller binary, faster execution.
  - `git_status` migrated to a libgit2 fast-path (`git2::Repository::open` + in-process branch ahead/behind + statuses). Falls back to the CLI parser on libgit2 errors. Probe measurement: CLI 41 ms → libgit2 32 ms; in-app gain extrapolated to 2-3× without the fork-exec overhead of the probe.
  - `workspace_*_all` commands (`status_all`, `fetch_all`, `pull_all`, `wip_all`, `prs_all`, `issues_all`) parallelised with `rayon::par_iter` — N repos run as N tasks in parallel (bounded by core count).
  - `workspace_*_all` also moved to libgit2 helpers for branch ahead/behind, modified count, WIP status, last commit timestamp.
  - `resolve_git_dir` memoizes `git rev-parse --git-dir` per `cwd`. No more fork on every poll.
  - `git_diff` defensively caps output at 5 MB per file, slicing at the last `\n` to never cut a hunk header. New `truncated_from_bytes` field on the response so the UI can surface a notice.

- **Backend Rust — architecture (§3.4 split)**
  - `apps/desktop/src-tauri/src/lib.rs` shrunk from ~3 254 to ~670 lines. The rest is now split by domain:
    - `commands/ai.rs` (384 LOC) — Claude + Codex CLI detection / prompt / login.
    - `commands/files.rs` (272 LOC) — `read_file`, `write_file`, `read_file_at_revision`, `folder_diff`, `list_dir`.
    - `commands/gh.rs` (360 LOC) — 8 `gh_*` commands (issues, PRs, view, comment).
    - `commands/ops.rs` (2193 LOC) — write side (stage, unstage, commit, push, pull, merge, rebase, discard).
    - `commands/read.rs` (1187 LOC) — `git_status`, `git_diff`, `git_log`, `git_repo_state`, `git_show`, `git_blame`, `git_file_log{,_pickaxe,_range}`, `preview_merge`.
    - `commands/workspace.rs` (268 LOC) — `workspace_read/write` + 6 `*_all` aggregates.
    - `git/cmd.rs`, `git/libgit2.rs`, `git/parse.rs` — shared helpers.
    - `types.rs` — every shared struct (consolidated from app).
  - Parity wrappers (`pub fn *_parity`) remain in `lib.rs` and delegate to `commands::read::*`. Zero IPC surface change — Tauri command names are identical.

- **Dependencies**
  - `git2` 0.19 → 0.20.4 (fixes GHSA security advisory). `libgit2-sys` 0.17 → 0.18.4+1.9.3.

### Added

- **Bench suite** (`apps/desktop/perf/bench.mjs`) — measures CLI vs libgit2 on a deterministic fixture; "vs CLI" column shows the delta. Probe entry `git-status-fast` added to `parity_probe` for isolated libgit2 measurement.
- **Bundle size budget in CI** (`apps/desktop/scripts/bundle-budget.mjs`) — breaks the build if initial JS exceeds the budget. Prevents silent regressions post-merge.
- **Performance invariants** documented in `AGENTS.md` (`polling discipline`, `tauri-bundler [[example]]` rule, settings duplicate-interface rule, watch-immediate TDZ pattern).

### Fixed

- **Windows — terminal flashes after the §3.4 split** — `CommandExt::creation_flags()` was silently a no-op on Windows because the trait import got lost during the module split. Re-imported in `git/cmd.rs` so `CREATE_NO_WINDOW` is honoured again. (Regression from v2.8.1's fix, surfaced by GitHub issue #6.)
- **Settings panel no longer pings AI CLIs at boot** — `detect_claude_cli` / `detect_codex_cli` previously ran an unsolicited prompt to verify authentication on every Settings open. Both now return a `detected` status without firing a prompt; auth is only verified when the user explicitly uses the provider. Privacy + cost win. (GitHub issue #6.)
- **CommitLog TDZ crash** — `watch(() => rows.value.length, ..., { immediate: true })` was declared before its transitive sources (`displayedEntries`, `isSearchActive`), causing a `ReferenceError: Cannot access 'displayedEntries' before initialization` on first render. Watcher moved below the source declarations.
- **CommitLog section labels height** — the virtualizer's `estimateSize: () => 72` used the commit-row height for `"non pushé" / "pushé"` section dividers, leaving them at 72 px. Now index-aware (`SECTION_ROW_H = 24` vs `COMMIT_ROW_H = 72`).
- **GitHub badge slow load on Dashboard** — first paint of the homepage README was blocked ~15 s waiting on a TLS handshake to `img.shields.io` on some networks. Badges now lazy-load and decode asynchronously so the rest of the README renders immediately.

### CI

- **Linux build dependencies** — `.github/workflows/{ci,release}.yml` now install the full Tauri 2 Linux prereq set explicitly: `libwebkit2gtk-4.1-dev` + `libglib2.0-dev` + `libsoup-3.0-dev` + `libayatana-appindicator3-dev` + `librsvg2-dev` + `libxdo-dev` + `libssl-dev` + `build-essential` + `file` + `patchelf`. Fixes recurring `glib-sys` build failures on the GitHub Actions Ubuntu 22.04 image, which no longer pulls `libglib2.0-dev` transitively via `libwebkit2gtk-4.1-dev`. `libappindicator3-dev` replaced by its supported successor `libayatana-appindicator3-dev`.

## [2.8.1] - 2026-05-04

Patch release addressing regressions reported after v2.8.0.

### Fixed

- **Windows — CMD console flash** — Every Git/gh/claude/codex child process was spawning a visible black CMD window on Windows. Added `CREATE_NO_WINDOW` flag (`0x08000000`) to all child processes via a new `hidden_cmd()` helper. The only intentional exception is the `claude login` interactive flow which requires a visible terminal.
- **Auto-updater infinite spinner** — On macOS, `relaunch()` could throw while Gatekeeper verifies the new binary signature, leaving the update modal stuck on "Installation…" forever. A 3-second post-download delay is now applied before relaunch, and any remaining failure is caught and surfaced as a readable error with a manual-reopen instruction instead of hanging indefinitely.
- **PRs not loading when app opened from Finder/Dock (macOS)** — The Tauri process inherits a minimal `PATH` when not launched from a terminal, so Homebrew-installed `gh` (`/opt/homebrew/bin/gh`, `/usr/local/bin/gh`) was not discoverable. `hidden_cmd()` now enriches `PATH` with the four common Homebrew/MacPorts prefixes on macOS before every spawn.
- **CI release — intermittent asset upload 500 error** — GitHub Releases API occasionally returns a 500 on one of the last assets when parallel matrix jobs upload simultaneously. A post-build verification step now detects and re-uploads any missing asset with up to 3 retries.

## [2.8.0] - 2026-05-01

Desktop product track v2.8: Agent Sessions View and Scheduled AI tasks — GitWand now sees the AI agents working on your repos, and can run lightweight automation tasks on your behalf without any external daemon.

### Added

- **Agent Sessions View** (`AgentSessionsPanel.vue` + 3-layer backend)
  - New **Agents** button in the repo sidebar (robot icon) — opens a modal listing all agent sessions detected across the current repo's worktrees.
  - Each card shows: tool badge (Claude Code / Cursor / Windsurf / other), active/configured status, branch, ↑ ahead / ↓ behind / ~ modified pills, and shortened path.
  - **Active detection** cross-platform: `lsof -a -d cwd -c <tool>` on macOS/Linux + `/proc/<pid>/cwd` Linux fallback; graceful no-op when unavailable.
  - **Launch session**: one-click to start Claude Code (`claude .`) on any worktree, or open a worktree in a GitWand tab.
  - Active sessions sort first; animated green pulse badge on active cards.
  - Rust commands (`agent_session_list`, `agent_session_launch`) + dev-server endpoints + typed `backend.ts` wrappers (`AgentSession`, `agentSessionList`, `agentSessionLaunch`).

- **Scheduled AI tasks** (`useScheduler.ts` composable)
  - New `useScheduler()` composable — pure TypeScript, no external daemon; uses `setInterval` + `visibilitychange` + `beforeunload` events. Completely silent when all tasks are disabled.
  - Four opt-in predefined tasks:
    - **Auto-resolve on conflict** — polls every 5 s for a rising-edge MERGE_HEAD; triggers `resolveConflicts()` automatically and logs the result.
    - **Nightly pull + rebase** — checks the schedule every 60 s; runs `pullAndRebase()` at the configured hour:minute, once per day (guarded by `localStorage` last-run timestamp).
    - **Release notes on tag** — called by `App.vue` after a push that includes `v*` tags; generates CHANGELOG entry via `useReleaseNotes`. Requires AI enabled.
    - **AI commit batch** — on `visibilitychange` (app blur) or `beforeunload`, if staged files are present, focuses the commit panel to suggest an AI message. Requires AI enabled.
  - All tasks respect offline mode — silently skip when `isOffline = true`.
  - Log entries flow to the existing **Logs** tab in Settings via the `onLog` callback.
  - `triggerReleaseNotesIfEnabled()` returned for external callers (used by `App.vue` post-push).

- **Automations Settings tab** (`AutomationsPanel.vue`)
  - New **Automations** tab in Settings (between AI and Hooks) with a card per task: title, description, trigger badge (event or `HH:MM`), last-run timestamp from `localStorage`, and a toggle switch.
  - Nightly pull card expands hour/minute number inputs when enabled.
  - AI-dependent tasks (Release notes, AI commit batch) show a warning label and disabled toggle when AI is off in Settings.
  - `useSettings()` composable now exposes `saveSettings()` so any component can persist settings without duplicating the write logic.

### Fixed

- `useSettings` composable was missing `saveSettings` export — `AutomationsPanel` and any future component can now call `saveSettings(settings.value)` directly without duplicating localStorage write logic.
- `SettingsPanel.vue` local `Settings` interface now mirrors `AppSettings` in `useSettings.ts` for the new `automations` field (per duplicate-interface rule).

### Website

- **Homepage redesign** (`website/.vitepress/theme/HomeLanding.vue`) — complete structural overhaul replacing the flat 20-card feature grid:
  - **Hero terminal animation** — live `gitwand resolve` simulation (9-step, type-in sequence) replaces the static screenshot; ↻ Replay button for repeat demos.
  - **Conflict demo elevated** — before/after block moved immediately after the stats bar so visitors see the payoff before any feature list.
  - **10 Patterns grid** — dedicated section with one card per resolution pattern; each card shows the pattern name, confidence tier (colour-coded: certain / high / medium / low), a one-line description, and auto-resolve status (⚡ or ○).
  - **Tabbed features** — 20 cards reorganised into four navigable tabs: Core Git · AI · Integrations · New in v2.8; active tab underlined in purple.
  - **Benchmarks section** — six metric cards with number-first typography: throughput at 1 / 5 / 50 conflicts, binary size (~8 MB vs ~150 MB Electron), test count (322), and hallucination count (0 — fully deterministic).
  - All sections fully responsive; `vitepress build` clean (4.5 s).

## [2.7.0] - 2026-05-01

Desktop product track v2.7: Workspaces multi-repo, Hooks manager, and Worktree first-class — three independent pillars that together make GitWand the command center for multi-repo engineering workflows.

### Added

- **Hooks manager** (`HooksPanel.vue` + 3-layer backend)
  - New **Hooks** tab in Settings (accessible from any open repo).
  - Lists all hooks found in `.git/hooks/`, showing enable/disable toggle, script preview, and executable warning.
  - Toggle: renames `pre-commit` ↔ `pre-commit.disabled` — no hook runner change, fully compatible with standard Git tooling.
  - Create a new hook via dropdown (18 standard hook names) + textarea editor.
  - Delete with confirmation modal.
  - Rust command (`git_hook_list/toggle/create/delete`) + dev-server endpoints + typed `backend.ts` wrappers.

- **Workspaces multi-repo** (`WorkspacePanel.vue` + 3-layer backend)
  - New **Workspace** button in the repo sidebar (briefcase icon).
  - Create / open a `.gitwand-workspace.json` grouping multiple repos; workspace directory persisted across sessions.
  - Per-repo status badges: branch (monospace), ↑ ahead (purple), ↓ behind (amber), modified (pink), Clean (green), ⚠ error.
  - **Fetch all** / **Pull all** / **Refresh** / **Open all in tabs** bulk operations.
  - Rust commands (`workspace_read/write/status_all/fetch_all/pull_all`) + dev-server + typed wrappers.

- **Worktree first-class** (`WorktreeManager.vue` upgrades)
  - **Quick-create ⌘⇧N** — keyboard shortcut opens the Worktree manager with the quick-create form pre-focused. Type a task name (e.g. `fix/login-bug`), GitWand auto-derives the worktree path (sibling of main worktree) and branch name (`task/<name>`), creates both in one action, and opens the worktree in a new tab.
  - **Cross-worktree status** — each worktree row now shows live status pills: ↑ ahead, ↓ behind, ~ modified, ✓ clean (fetched via `git_worktree_status_all` on load).
  - **Cleanup assisté** — new "Clean up" panel lists non-main, non-locked worktrees with `ahead = 0` (nothing to push). Select one or many, confirm, done.

### Fixed

- Stray closing brace in `en.ts` locale (duplicated `workspace` section close) causing `vue-tsc` parse failure.
- `SettingsPanel` received `currentRepo?.path` (non-existent ref) — corrected to `repoFolderPath ?? undefined`.
- `HooksPanel` dynamic locale key `hooks.${key}` typed as `LocaleKey` cast to pass strict `t()` signature.

## [2.6.0] - 2026-05-01

`@gitwand/core@2.6.0` closes the v2.6 entry of the [CORE-V2-ROADMAP](./CORE-V2-ROADMAP.md): a refactoring-aware merge pipeline that detects concurrent rename / move-method refactorings and resolves the resulting conflicts via an invert → merge → replay strategy (inspired by Ellis et al. TSE 2023). Opt-in via `refactoringAware.enabled: true`. Otherwise fully backward-compatible — the new code path is completely silent by default.

### Added

- **`@gitwand/core@2.6.0` — Refactoring-aware merge (CORE-V2-ROADMAP v2.6)**
  - **`RefactoringKind` / `Refactoring` types** — new exported types describing a detected refactoring: `kind` (`"rename-local" | "rename-top-level" | "move-method"`), `oldName`, `newName`, `scope` (enclosing function for local renames), `sourceClass` / `targetClass` (for method moves).
  - **`refactoringAware` option in `GitWandOptions`** — opt-in flag (`enabled?: boolean`) and quota (`maxRefactoringsPerSide?: number`, default 10). Added to `GitWandrcConfig` for `.gitwandrc` support.
  - **`packages/core/src/refactoring/detect.ts`** — pure-TypeScript refactoring detector. Tokenises base and branch, finds removed/added identifiers, applies simultaneous bijective substitution (with permutation search for same-count ambiguous groups), and confirms via full token-sequence equality. Also parses class method sets for move-method detection via a brace-depth line parser.
  - **`packages/core/src/refactoring/invert.ts`** — applies refactorings in reverse: `rename-top-level` → global identifier replacement; `rename-local` → scoped replacement (signature + body) using `findScopeRange`; `move-method` → no-op (structural only). Multiple refactorings applied in reverse order to handle rename chains.
  - **`packages/core/src/refactoring/replay.ts`** — `mergeRefactorings()` deduplicates detected refactorings from both branches (ours wins on conflict); `replayRefactorings()` applies the merged refactoring set forward on the merged text.
  - **`packages/core/src/refactoring/orchestration.ts`** — `tryRefMerge(input, max)`: Phase 1 detect (ours + theirs), Phase 2 invert both branches to base nomenclature, Phase 3 classic 3-way merge on the inverted versions (`mergeInverted` cascades: same_change → one_side_change → LCS non-overlapping), Phase 4 replay the merged refactoring set. Full try/catch — always safe to call. Exposes `RefMergeResult { lines, reason, oursRefs, theirsRefs }`.
  - **Pattern plugin `refactoring_aware_merge` (priority 970)** — registered in the classifier after all text patterns (10–60) but before `llm_proposed` (998) and `complex` (999). Disabled by default; activated by `resolve()` when `options.refactoringAware.enabled`. Module-level flag/cache pattern (same as `llm-proposed`): `detect()` runs the full RefMerge pipeline and caches the result; `assembleResolution()` reads the cache to avoid recomputation.
  - **21 new tests** — `src/__tests__/refactoring/refactoring-pipeline.test.ts` (F-R01–F-R21) covering `detectRefactorings` (rename-local, rename-top-level, multi-rename, move-method, identical, non-bijective), `invertRefactorings` + `replayRefactorings`, `mergeRefactorings` ours-wins, `tryRefMerge` positive and negative cases, and `resolve()` integration with `refactoringAware.enabled`. **898/898 tests passing.**

### Fixed

- **`packages/vscode` build** — `TYPE_LABELS` and `TYPE_ICONS` in `extension.ts` were missing `llm_proposed` and `refactoring_aware_merge` keys, causing `Record<ConflictType, string>` exhaustiveness errors. Both keys added to both maps.
- **Multi-rename detection** — `detectRenames()` now handles simultaneous same-count renames (e.g. two function parameters renamed in one commit) via permutation search over ambiguous groups, rather than silently skipping them.
- **`rename-local` inversion scope** — `findScopeRange()` now returns the range from the `function` keyword (not just the body `{`) so that parameter names in the function signature are also inverted, not just the body.

## [2.5.1] - 2026-05-01

Desktop patch — PR filter pipeline fixed end-to-end, offline mode, error log tab, and several UX polish items that had accumulated post-v2.5.0.

### Added

- **PR filter — Assignées / Reviews** — new `filterMode` ref (`'all' | 'assigned' | 'reviews'`) replaces the old `filterMine` boolean. Three equal-width buttons in the PR sidebar let you switch between all PRs, those assigned to you, and those requesting your review. `displayedPrs` filters client-side on `pr.assignees` / `pr.reviewRequested` (case-insensitive comparison).
- **PR filter — identity banner** — when a user filter is active but `currentUser` hasn't resolved yet, the sidebar shows a slim loading indicator; on failure it shows an error message with a **Retry** button. `currentUserLoading` and `currentUserError` are now exposed on the `PrPanelState` return object.
- **Offline mode** — new `useNetworkStatus()` composable wires `window online/offline` events to an `isOffline` ref. `SyncSplitButton` disables all remote actions (push, pull, fetch, merge remote) and shows a tooltip when offline. `AppHeader` renders an "Offline" pill and passes `isOffline` down the tree.
- **Error log tab in Settings** — blocking red error banner replaced by a non-blocking slim toast with a "View logs" link. A discrete red dot on the settings button signals unread errors. Settings gains a **Logs** tab with a timestamped, reversed-chronological list (max 200 entries) and a Clear button. `errorLog` is persisted to `localStorage`.

### Fixed

- **`ghCurrentUser()` dev-server URL** — fetch was calling `/api/gh-current-user` (hitting Vite on port 5173, which served `index.html`) instead of `${DEV_SERVER}/api/gh-current-user`. All other endpoints correctly used the `DEV_SERVER` prefix; this one was missed. Result: `currentUser` was always `null` in dev mode, so the Assignées/Reviews filters silently showed all PRs.
- **`ghCurrentUser()` error swallowing** — `.catch(() => {})` replaced by `loadCurrentUser()` which logs to the console and sets `currentUserError`. `displayedPrs` now returns `[]` (not all PRs) when a user filter is active but identity isn't resolved, making failures visible rather than hiding them behind an unfiltered list.
- **PR list limit** — `gh pr list` was capped at 50 results, silently dropping older PRs on busy repos. Raised to `--limit 300` in Rust. Dev-server paginates 3 × 100 via `per_page=100&page=N`, stopping early when the last page has fewer than 100 results.
- **PR list reload on repo switch** — `watch(cwd)` in `usePrPanel` now calls `init()` after resetting state, so switching repos while the PR tab is open correctly reloads the PR list and re-resolves the current user for the new repo.
- **User filter buttons equal width** — `grid-template-columns` fixed from `auto 1fr 1fr` to `repeat(3, 1fr)`.
- **Locale keys alignment** — `filterMineTitle` / `emptyMine` (removed) and `identityLoading` / `identityError` / `identityRetry` (added) synced across all 5 locales (en, fr, es, pt-BR, zh-CN).

## [2.5.0] - 2026-04-30

`@gitwand/core@2.5.0` closes the v2.5 entry of the [CORE-V2-ROADMAP](./CORE-V2-ROADMAP.md): a LLM fallback that resolves `complex` conflicts through a generative model when the deterministic engine cannot. Plus desktop search reliability, PR list stability, and accumulated UX polish.

### Added

- **`@gitwand/core@2.5.0` — LLM fallback for `complex` conflicts (CORE-V2-ROADMAP v2.5)**
  - **`llm_proposed` ConflictType** — new entry added to the `ConflictType` union; appears in traces when a generative model produced the resolution.
  - **`LlmEndpoint` / `LlmFallbackConfig` / `LlmTrace` types** — typed interfaces for injecting a model endpoint, configuring the fallback pipeline (model, maxTokens, temperature, contextLines, minPostMergeScore, minMode), and tracing LLM calls for audit (calledAt, model, latencyMs, promptHash, rawResponseTruncated, validationScore, accepted).
  - **Pattern plugin `llm_proposed` (priority 998)** — registered in the classifier immediately before the `complex` fallback (priority 999). Skipped by the synchronous `resolve()` — only active in `resolveAsync()`.
  - **`tryLlmFallbackResolve()` resolver** — `resolvers/llm-fallback.ts`. Constructs a context-aware prompt (configurable `contextLines`), calls `endpoint.call(prompt)`, validates the response with `validateMergedContent()` (score ≥ `minPostMergeScore` threshold), and falls back to `complex` if the score is below threshold. Accepts if the validation passes.
  - **`resolveAsync()` wiring** — the async resolver calls `tryLlmFallbackResolve()` on every hunk classified as `complex` when `llmFallback.enabled: true`. The synchronous `resolve()` logs a warning if `llmFallback.enabled` but continues without LLM.
  - **MCP tool `resolve_hunk`** — `@gitwand/mcp` gains a `resolve_hunk` tool that exposes the full `resolveAsync()` pipeline (structural merge → pattern classifier → LLM fallback) to any MCP client (Claude Code, Claude Desktop, Cursor, Windsurf). Three parameters: `ours`, `theirs`, `base` (optional). Returns `type`, `confidence`, `resolution`, `explanation`, and `llmTrace` when applicable.
  - **+10 corpus fixtures (F36–F45)** and a dedicated `v2.5-llm-fallback.test.ts` test suite. **841/841 tests passing** (core package).
- **Desktop — repos récents et favoris** — `useRecentRepos` composable stores the last 10 opened repositories and up to 5 pinned favorites. The empty-state view and the repo-switcher dropdown now surface this list with direct open buttons.
- **Desktop — push confirmation pour les tags non poussés** — `SyncSplitButton` détecte si des tags locaux n'ont pas encore de remote counterpart et affiche une modale de confirmation avant le push (« pousser également les N tags en attente ? »).

### Fixed

- **Recherche globale stale au changement de repo** — `useGlobalSearch` ne réinitialisait pas ses résultats quand `cwd` changeait. Un `watch(cwd, reset)` efface maintenant l'index et les résultats stale à chaque changement de dépôt.
- **Liste PR vide + état d'erreur explicite** — `usePrPanel` affichait une liste vide sans feedback quand le chargement échouait. L'état d'erreur est maintenant exposé comme `prError: ref<string | null>` et rendu dans le panneau avec un bouton Retry.
- **Boutons modale Tags plus grands** — les boutons dans la modale Tags utilisent maintenant `size="md"` (padding horizontal 20 px) au lieu du `size="sm"` par défaut, alignant la taille avec les autres modales de l'app.
- **Bouton Rembobiner — fond correct en Light mode** — la couleur de fond du bouton Rembobiner utilisait `var(--color-danger-bg)` qui retournait transparent en Light mode. Remplacé par `var(--color-danger)` avec `opacity: 0.12` pour un fond visible dans les deux thèmes.
- **Design modales Worktree et Submodule harmonisé** — `WorktreeModal` et `SubmodulePanel` migrent vers `BaseModal` (backdrop uniforme, focus-trap, Esc-to-close, footer layout partagé) en remplacement des overlays ad-hoc.

## [2.4.1] - 2026-04-29

Implementation pass on the v2.4 entry of the [CORE-V2-ROADMAP](./CORE-V2-ROADMAP.md) — the resolver gains a parse-tree validation layer, a third validation tier (`off` / `balanced` / `strict`), and a `postMergeRisk` dimension on `ConfidenceScore` that retroactively demotes resolutions whose output doesn't parse. Plus an in-app Help Panel, agent-discovery surfaces on the marketing site, and a fix for the merge-success modal that was offering to delete `master` / `main` / `develop`.

### Added

- **`@gitwand/core@2.4.1` — Semantic post-merge validation (CORE-V2-ROADMAP v2.4)**
  - **Validation tiers** — `ValidationLevel` is now `off | balanced | strict`. `standard` is renamed to `balanced`; the new `off` skips the parse-tree pass entirely for raw-throughput resolves.
  - **Parse-tree validation** — new `validate-parse-tree.ts` runs each candidate resolution through tree-sitter for the file's language and refuses resolutions that introduce parse errors. `ValidationResult` exposes `parseTreeErrors` + `parseTreeErrorRanges` so callers can report which bytes broke.
  - **External validators (`strict` tier)** — new `validate-strict.ts` and `adapters/strict-node.ts` plumb `tsc --noEmit` and `eslint` as opt-in external validators when `validation.level: "strict"` is set in `.gitwandrc`. The previous loose `strictErrors` field is replaced by a typed `ExternalValidationResult { tool, errors, passed }`, so consumers can render per-tool diagnostics instead of concatenating strings.
  - **`postMergeRisk` score dimension** — `makeScore()` accepts a new `postMergeRisk` parameter (weight −0.20). Resolutions whose output fails parse-tree or external validation are retroactively demoted in the confidence score. Closes the v2.4 roadmap target of −50 % parse-tree-broken false positives.
  - **`resolveAsync()` shape** — handles `validationLevel='off'` and populates `externalValidation` on every return path so async consumers always get a complete `ValidationResult` regardless of which tier ran.
  - **+5 corpus fixtures (F31–F35)** per the +5/release principle, plus two new test suites: `v2-core-scenarios.test.ts` (829 lines, end-to-end coverage from v2.1 to v2.4) and `validation-parse-tree.test.ts` (274 lines). **841/841 tests passing.**
- **In-app Help Panel** — header button, menu bar entry, and `Esc` key open a `HelpView` overlay covering Getting Started, Conflicts, Shortcuts, Workflow, AI features, and an FAQ. Translated across all 5 locales.
- **Agent discovery surfaces on the website** — `gitwand.devlint.fr` now publishes the surfaces AI tooling looks for: an MCP server card (`server-card.json`, wired into `bump-version.sh` so the version stays aligned automatically), Agent Skills entries, an RFC 8288 `api-catalog` link in the homepage `<head>`, WebMCP browser-tool declarations, and explicit AI usage signals in `robots.txt`. Agents scanning the site can discover and install `@gitwand/mcp` without a human in the loop.
- **Repository-level AI agent docs** — top-level `AGENTS.md` and `CLAUDE.md`, plus per-package `CLAUDE.md` for `apps/desktop`, `apps/desktop/src`, `apps/desktop/src-tauri`, `packages/core`, `packages/cli`, `packages/mcp`, `packages/vscode`. New `.claude/skills/` for `add-pattern`, `add-resolver`, `add-tauri-command`, `i18n-sync`, and `release` flows.
- **AI settings in the desktop store** — `commitMessageLang`, `aiEnabled`, `aiProvider`, `aiApiKey`, `aiApiEndpoint`, `aiModel`, `aiOllamaUrl`, `aiOllamaModel` added to `AppSettings` with defaults.

### Changed

- **Resolver split** — `resolver/index.ts` reorganised so validation lives in dedicated modules (`validate-parse-tree.ts`, `validate-strict.ts`, `validation.ts`) instead of inline. The entry-point shrinks; new modules are independently testable.

### Fixed

- **Branch-deletion offer guards protected branches** — `MergeSuccessModal` used to propose deleting whatever branch had just been merged, including `master` / `main` / `develop`. The post-merge cleanup now only fires for feature/PR branches; mainline names stay put.
- **`process.env` instead of `import.meta.env` for `GITWAND_DIFF`** — the Histogram-diff opt-out flag was reading `import.meta.env.GITWAND_DIFF`, which isn't typed on `ImportMeta` without Vite types. `tsc --build` was failing in CI. Replaced with a `typeof process !== 'undefined'`-guarded `process.env` lookup so the flag works under Node.js without breaking browser/Tauri builds.
- **`@gitwand/cli` and `@gitwand/mcp` resync to 2.4.1** — both packages were stuck at 2.3.0 because `bump-version.sh` skips packages whose version drifts from `@gitwand/core`. The resync brings them to 2.4.1 alongside core; the publish workflow's `[ version == tag ]` precondition now passes. `server.json`, `server.ts`, and `server-card.json` aligned in the same commit.

## [2.3.0] - 2026-04-27

The v2 core engine sequence. Three back-to-back `@gitwand/core` releases — v2.1 (Histogram diff), v2.2 (format profile registry), and v2.3 (tree-sitter structural merge dispatcher) — bundled under the umbrella `v2.3.0` tag. Plus cherry-pick-from-log with full conflict resolution in the desktop, and a hardened auto-update manifest publish in CI.

### Added

- **`@gitwand/core@2.1.0` — Histogram diff & block-move detection** (CORE-V2-ROADMAP v2.1)
  - **Diff backend switched to Histogram** (rare-anchor splitting with forward/backward extension, JGit-style), replacing the pure DP / Hirschberg backend. Public signatures of `lcs(a, b)`, `computeDiff(base, branch)`, and `mergeNonOverlapping(base, ours, theirs)` are unchanged. Direct gain on `non_overlapping` and `insertion_at_boundary` patterns — corpus fixtures F22/F23/F24 that previously hit `complex` are now auto-resolved end-to-end.
  - **Rollback flag** — `GITWAND_DIFF=lcs` selects the legacy backend at call time. On runtimes without `process.env` (pure browser), Histogram is always used.
  - **New exports** — `histogramDiff(a, b, opts?)`, `lcsLegacy(a, b)`, `detectBlockMove(base, ours, theirs, opts?)` (Rabin-Karp rolling-hash detector for blocks present in `ours`/`theirs` but absent or relocated in `base`; primitive only — consumed by the v2.6 refactoring-aware merge), plus `MovedBlock`, `BlockMoveOptions`, `HistogramOptions` types.
  - **`ConfidenceScore.dimensions`** gains an optional `algorithmStability` (default 0 → numerically identical to v1.4 for all existing patterns); reserved for v2.6.
  - `src/diff.ts` split into `src/diff/{lcs,histogram,block-move,shared,index}.ts`. New tests: `__tests__/diff/{histogram,parity,block-move}.test.ts`, `__tests__/patterns/make-score.test.ts` (~30 new tests). Corpus +F21–F25. New benches in `bench.bench.ts`.
- **`@gitwand/core@2.2.0` — Format profile registry + JSON Patch arrays** (CORE-V2-ROADMAP v2.2)
  - **Format profile registry** annotates JSON Pointer paths with merge strategies (`set` / `ordered-list` / `merge-keys` / `opaque`). The JSON and YAML resolvers consult the registry before falling back to textual conflict markers — closes the long-standing gap on JSON arrays at `/dependencies`, `/scripts`, `/keywords`, etc., and on YAML sequences in `helm/values.yaml` / Kubernetes manifests (containers, volumes, env vars, ports merged by `name` / `port` / `host`).
  - **Five built-in profiles** — `package.json`, `tsconfig.json` (incl. `tsconfig.<variant>.json`), `composer.json`, `helm/values.yaml`, and `kubernetes` (manifests under `k8s/`, `kubernetes/`, `manifests/` or with conventional basenames).
  - **RFC 6902 (JSON Patch) — minimal in-house** — `diffJson(base, target)` produces an op sequence (`add` / `remove` / `replace`); `applyJsonPatch(doc, ops)` applies it immutably; `mergeJsonPatches(ours, theirs)` returns the concat when paths are disjoint or `null` plus a list of conflicting paths. JSON Pointer escapes (`~0`, `~1`) handled. `move` and `copy` deliberately not supported (express via `add` + `remove`). Round-trip property `applyJsonPatch(base, diffJson(base, x)) ≡ x` verified on 100 random inputs.
  - **New exports** — `profileForFile`, `registerFormatProfile` (returns an unregister function for clean teardown), `strategyForPath`, `diffJson`, `applyJsonPatch`, `mergeJsonPatches`, `parseJsonPointer`, `buildJsonPointer`, `jsonStructEqual`, plus `FormatProfile`, `PathStrategy`, `JsonPatchOp` types.
  - **Rollback** — `GitWandOptions.disableFormatProfiles?: boolean` (default `false`) reverts JSON/YAML resolvers to v2.1 behaviour; useful for A/B comparison or when a third-party profile causes silent deletions.
  - YAML resolver gets a parse-merge-serialize fast path that runs only when a profile applies (comments are lost on this path; line-based pipeline remains the default for unprofiled YAML). New module `src/format-profiles/{index,types,json-patch,merge-strategies,profiles/*}.ts`. Tests: `__tests__/format-profiles/{json-patch,registry,integration}.test.ts` (~47 new tests). Corpus +F26–F30.
- **`@gitwand/core@2.3.0` — Tree-sitter structural merge dispatcher** (CORE-V2-ROADMAP v2.3)
  - **AST-based first-pass resolver** for TypeScript, TSX, JavaScript, JSX, Python, Go, and Rust files. Aligned with Mergiraf/Weave: parse `base` / `ours` / `theirs` with `web-tree-sitter`, pair top-level entities (functions, classes, methods, top-level statements) by canonical signature, merge entity-by-entity. Falls back to the existing hunk-based engine when structural merge yields `null`.
  - **Lazy WASM grammars** — `web-tree-sitter` declared as an **optional** peer dependency (`>=0.20.0`); `tree-sitter-wasms` carries the grammar bytes; loader supports both v0.20 and v0.26 API shapes. Three environment adapters in `structural/parsers/adapters/{node,browser,tauri}.ts` keep `packages/core` browser-compatible (Node imports stay dynamic and guarded per the package's adapter pattern).
  - **`resolveAsync()`** — new async entry point that runs the structural pass and falls back to the synchronous `resolve()` when needed. Synchronous `resolve()` keeps its v2.2 contract.
  - **New exports** — `resolveAsync`, `tryStructuralMergeResolve`, `wrapStructuralResult`, `isStructuralLanguage`. New module `src/structural/{entities,matching,merge,reconstruct,index}.ts` (~1,700 lines) plus `parsers/{loader,grammars/*,adapters/*}`. Tests: `__tests__/structural/{structural-index,matching,merge,reconstruct,languages}.test.ts` + a 15-test `grandeur-nature` integration suite (5 scenarios, WASM-optional guards).
- **Cherry-pick from the log with full conflict resolution** — the right-click *Cherry-pick* entry in the commit log now keeps `isCherryPicking=true` when the operation produces conflicts, switches the desktop into the changes view, selects the first conflicted file, and stops auto-fetch/poll while the operation is in flight. New paths through `useGitRepo`: `cherryPickAbort()` and `cherryPickContinue()` (multi-pass, stays in cherry-pick mode until everything is resolved). The conflict banner button reads *Annuler le cherry-pick* / *Annuler le merge* depending on which operation is running. New i18n key `header.abortCherryPick` across all 5 locales.

### Changed

- **CSS resolver bypasses the structural merge dispatcher** — explicit regression tests assert that the CSS resolver's reason string skips the structural merge path (the structural dispatcher is for AST-parseable source code, not stylesheets).
- **Auto-update manifest publish hardened in CI** — the release workflow's auto-update manifest publish step gains a fallback endpoint and tighter retry semantics so a transient hiccup on the primary endpoint doesn't fail the whole release.
- **macOS Gatekeeper workaround removed from docs** — the app is now properly Developer-ID-signed and notarized (since v1.9.0); the README/website no longer mention the manual `xattr -d com.apple.quarantine` step.

### Fixed

- **Diff line counters use signed integers** — fixes a panic in the Rust diff parser when removed-line counts could go negative.
- **`web-tree-sitter` pinned to `~0.20.7`** — ABI-compatible with `tree-sitter-wasms@0.1.13`. The 0.26 API shape is supported by the loader for forward compatibility, but the runtime peer pin avoids loading-path mismatches in CI on older Node versions.
- **Desktop branch list loaded before PR create** — the PR create form's base-branch detection used to fail because the branch list was still empty when the form opened. The form now waits for the list and uses the raw branch name (not the display string) so candidate-base resolution works.
- **Untracked file diffs render in the UI** — desktop now parses the fallback diff output for untracked files, so newly created files appear in the diff panel instead of showing "no changes".
- **Vite alias points at `packages/core` source** — removes the requirement to rebuild the core dist before running the desktop dev server; one less footgun on a fresh clone.

## [2.0.1] - 2026-04-26

### Changed

- **Update modal redesigned, marketing-first** — the in-app update prompt no longer renders the auto-generated release manifest body (download table + raw "see the changelog" link rendered as basic markdown). The modal now shows a sparkle hero, the new version, a localized tagline ("Discover the new features, refinements, and fixes in this release."), and a "Read the full changelog" link that anchors to the version's heading on `gitwand.devlint.fr/changelog`. Two new i18n keys (`update.tagline`, `update.viewChangelog`) across the 5 locales. The `update.body` field is still kept on `UpdateInfo` for a future iteration where we might publish hand-written marketing copy in the manifest.

## [2.0.0] - 2026-04-26

Major release. v2.0 introduces three desktop-first surfaces — a native macOS menu bar, in-app Clone & Fork, and an opt-in beta update channel — plus an OpenAI Codex CLI provider, a shortlog-driven Contributors widget, and a tightened follow-up pass on the menu bar that lights up Find in Log, Merge…, Open in Terminal, Toggle Sidebar, and Undo Last Operation.

### Added — v2.0 surfaces

- **Native macOS menu bar** — full File / Edit / Repository / View / Window / Help via `@tauri-apps/api/menu`. Built entirely from the frontend so labels come from `useI18n()` and rebuild on locale + repo open/close. Predefined OS items (Cut/Copy/Paste/Hide/Quit/Minimize/Fullscreen) keep first-responder routing intact — Cmd+Z stays webview-default for text undo. macOS-only via `navigator.platform` gate.
- **Clone & Fork from the UI** — three entry points for `git clone <url> <dest>` and `gh repo fork <url> --clone --remote-name=upstream`: secondary buttons under the empty state, a `+` dropdown on the tab strip (teleported to body to escape the strip's overflow clip), and File menu items. Backends are 3-layer (Rust + dev-server + TS wrapper) per the project convention; modals are `BaseModal`-based with auto-derived destination paths.
- **Auto-update channels (stable / beta)** — `Settings.updateChannel` ref and a new `fetchBetaUpdate(currentVersion)` that compares semver locally against `latest-beta.json`. Stable keeps the Tauri plugin's auto-install path; beta switches to a manual flow (open the GitHub release page) because `tauri-plugin-updater` doesn't support runtime endpoint override. CHANGELOG note: the GitHub Actions workflow still needs to publish `latest-beta.json` on `v*-beta.*` tags — tracked as a follow-up.
- **OpenAI Codex CLI provider** — `codex-cli` added to `useAIProvider` mirroring the Claude Code CLI flow. Backend has `resolve_codex_binary` + `detect_codex_cli` + `codex_cli_prompt` (uses `codex exec "<prompt>"` — no `--quiet`, that flag doesn't exist on `exec`). Settings UI matches the Claude block: detect on mount, status states (not_found / not_logged_in / connected) with install hint.
- **5 deferred menu items, now wired** — `Find in Log` (Cmd+F focuses the existing `CommitLog.searchQuery` input via a `LOG_FOCUS_SEARCH_KEY` provide/inject bridge after switching `viewMode` to "history"), `Merge…` (opens `AppHeader.openMergePopover()` via `MERGE_POPOVER_REQUEST_KEY`), `Open in Terminal` (Cmd+Shift+T mounts `GitTerminal` in a stash-overlay shell), `Toggle Sidebar` (Cmd+Shift+S, new `showSidebar` ref defaulted true), `Undo Last Operation` (Cmd+Shift+U opens the existing rewind popover via `UNDO_POPOVER_REQUEST_KEY`). Toggle Light/Dark Mode loses Cmd+Shift+T (now claimed by Open in Terminal per spec) — stays in the menu without an accelerator; the header chip remains the primary entry.

### Changed — v2.0 surfaces

- **Dashboard contributors** — backend `git_shortlog` (3 layers) replaces the windowed-log aggregation. `contributorCount` becomes a computed derived from `allContributors.length`, `topContributors` no longer slices to 4. Layout converts to a horizontal scroll rail: cards take `(100% - 2×gap)/3` with `min-width: 180px` and `scroll-snap-align: start`, so a fourth contributor peeks in to cue the scroll.
- **`AIProvider` type unified** — `SettingsPanel.vue` redeclared the union inline and silently drifted from `useAIProvider.ts`. Replaced with a re-export so the canonical declaration has a single home.
- **`@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`, `@gitwand/desktop`, `gitwand-website`** all bumped to `2.0.0` via `scripts/bump-version.sh`. `@gitwand/mcp/server.json` (root + packages[0] version) and `packages/mcp/src/server.ts` aligned.

### Added

- **Commit context menu** — right-click any commit in the Log to get a full action menu. Twelve entries in four groups:
  - *Navigation* — **Checkout commit** (modal with detached-HEAD warning); **Reset to commit** (soft / mixed / hard selector, danger styling and explicit warning on `--hard`, `repoRefresh()` called after to keep the staged/unstaged panel in sync).
  - *Branching* — **Create branch here** (`git checkout -b <name> <sha>`); **Tag this commit** (lightweight or annotated depending on whether a message is supplied); **Cherry-pick onto current branch**.
  - *History* — **Revert commit** (non-destructive, merge commits handled via `-m 1`); **Amend** (HEAD only); **Split** (HEAD only, no merge commits — routes to the existing split-commit modal).
  - *Clipboard & forge* — **Copy short SHA**, **Copy full SHA**, **Copy commit message** (summary + body); **View on GitHub / GitLab / Bitbucket** (URL derived from `gitRemoteInfo`).
- **Four new backend primitives** (Rust + Node dev-server + TypeScript wrapper, three layers each): `git_checkout_commit`, `git_reset_to_commit`, `git_revert_commit`, `git_create_tag`. `git_create_branch` extended with an optional `start_point` parameter (backward-compatible).
- **`useCommitActions` composable** (`composables/useCommitActions.ts`, 244 lines) — encapsulates modal state, all handlers, and confirm callbacks extracted from `App.vue`. App.vue shrinks by 172 lines.
- **37 i18n keys** for the commit context menu translated across all 5 locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`), zero TypeScript errors.

### Changed

- Commit context-menu modals use `BaseModal` (consistent background, border-radius, slide-in animation, close button, footer layout) instead of hand-rolled overlays.
- `RepoSidebar` now forwards the 7 new commit context-menu events (`checkoutCommit`, `resetToCommit`, `revertCommit`, `createBranchFromCommit`, `tagCommit`, `cherryPickCommit`, `viewOnForge`) from its internal `CommitLog` up to `App.vue`.

- **Tags panel** — the ◇ button in the sidebar tab strip opens a `BaseModal`-based panel listing all local tags sorted by semver/date. Per-tag actions appear on hover: push to remote (single tag) and delete local (with optional remote deletion, confirmed via a sub-modal). A "Push all tags" button at the top sends `--tags` to the configured remote. Four new backend primitives (Rust + Node dev-server + TypeScript wrapper): `git_list_tags`, `git_delete_tag`, `git_push_tags`, `git_delete_remote_tag`.
- **Ref badges in CommitLog list view** — branch, tag, and remote ref badges now appear below the commit meta line in the Log sidebar list (not just in the DAG graph). Branch/HEAD badges are accent-purple; tag badges are amber; remote refs are muted grey.
- **AI tag suggestion** (`useTagSuggestion.ts`) — a ✦ Suggest button appears in the "Tag this commit" modal when an AI provider is configured. One click fetches the latest tag, collects commits since it via `git log <lastTag>..HEAD --oneline`, and asks the model to propose the next semver bump (major/minor/patch based on conventional-commit types) plus a one-line annotated tag message. Both fields are filled simultaneously.
- **Commit trailers** — the commit panel in the sidebar now shows two checkboxes below the description: `Signed-off-by` (auto-filled from `git config user.name/email`, loaded eagerly on mount) and `Reviewed-by` (checkbox + free-text input). When checked, the trailers are appended as a conventional trailer block (`\n\n<trailers>`) to the commit message in `useGitRepo.commit()`. The AI commit-message prompts are updated to say trailers are "controlled by the user" rather than categorically banned. Three new i18n keys (`trailerSobTooltip`, `trailerRbTooltip`, `trailerRbPlaceholder`) across all 5 locales.
- **Conventional Commits type picker** — a row of monospace chips (`feat` · `fix` · `docs` · `chore` · `refactor` · `test` · `style` · `perf` · `ci`) appears above the summary input in the commit panel. Clicking a chip injects the prefix (`feat: `, `fix: `, …) at the start of the summary, replacing any existing type prefix. Clicking the active chip again removes it. The `activePrefix` computed detects the prefix in real time so the correct chip is always highlighted, including when the AI generates a conventional commit message.
- **Post-merge branch cleanup** — after a successful merge, `MergeSuccessModal` shows a "Delete «branch»" button alongside the existing Push button. An optional "Also delete from remote" checkbox runs `git push <remote> --delete <branch>` after the local deletion. The merged branch name is captured when `mergeBranch()` is called and passed as a prop to the modal.
- **File history pickaxe & line-range search** — the File History Viewer (Blame / Log / Compare tabs, opened from the clock icon in the diff header) gains two new search modes in the Log tab. A **pickaxe search bar** with S/G mode toggle lets you find every commit where a specific string (literal `-S`) or regex pattern (`-G`) was added or removed in the file. A **clock button** on each blame block runs `git log -L <start>,<end>:<file>` to show only the commits that touched that contiguous group of lines — the view switches to the Log tab automatically and displays a "Lines X–Y" banner. `git_file_log`, `git_file_log_pickaxe`, and `git_file_log_range` are now proper Rust Tauri commands (previously only in the dev-server). Four new i18n keys across all 5 locales.
- **Blame diff algorithm setting** — a new "Blame diff algorithm" selector (histogram / patience / minimal / myers) in Settings → Git tab controls `git blame --diff-algorithm=<algo>`. `git_blame` is now properly implemented as a Rust Tauri command (it was only in the dev-server before). `FileHistoryViewer` reads the setting on each blame load. Default is `histogram` which gives the best blame results for most codebases. Three new i18n keys across all 5 locales.
- **Fork / triangular workflow badge** — `GitStatus` now tracks `push_remote` and `ahead_push` when `@{push}` differs from `@{upstream}`. `SyncSplitButton` shows a subtle "↑N fork" badge in the push button when in a fork setup, making it clear how many commits are ahead of the fork vs. the upstream.
- **MCP Registry CI automation** (`publish.yml`) — a new `publish-mcp-registry` job runs after `smoke-test` on every tag push. It installs `mcp-publisher` from the official pre-built binary (no Homebrew dependency), polls npm for up to 12 minutes until `@gitwand/mcp@<version>` propagates, then runs `mcp-publisher publish` from `packages/mcp/`. Authenticated via `secrets.MCP_PUBLISHER_TOKEN` (GitHub PAT, `read:user` scope). Fixes the registry being frozen at v1.6.1 since no manual publish was run after that release. `packages/mcp/PUBLISH-TO-REGISTRY.md` updated to document the automated flow and the one required secret.

### Fixed

- `isCtxEntryHead` in `CommitLog` now guards against search mode: when a search is active, `idx === 0` no longer implies HEAD, so **Amend** and **Split** are correctly disabled for non-HEAD results.
- Checkout and Reset `--hard` now call `repoRefresh()` after completion so the staged/unstaged file panel reflects the new working-tree state immediately.

## [1.8.0] - 2026-04-23

Design-system foundations — the app header and every overlay now ride on a shared chrome. A new `BaseModal` swallows the backdrop / focus-trap / Esc handling that had drifted across 10 modals, and a companion `AiSparkle` icon retires the ad-hoc SVG copies that had accumulated around AI actions. The refactor let us revisit the surfaces that carry them — PR views, merge editor, sidebar dashboard — with a consistent hand.

### Added

- **AppHeader revamp** — the 1654-line `AppHeader.vue` monolith is split into composable building blocks under `components/header/`: `SyncSplitButton` (primary sync CTA with publish/push/pull variants + split-button menu for less-common sync actions), `BranchSelector` (rich branch popover with search and quick-switch), `BranchMenu` (secondary branch actions), `SearchTrigger` + `SearchPalette` (centered search input opening a full-screen command palette), `RepoTabStrip` (replaces `RepoTabBar` with multi-tab ergonomics), `HeaderLogo`. Each is typed, i18n'd across all 5 locales, and re-wired into `App.vue`.
- **Cmd/Ctrl+K command palette** — the new `SearchPalette` is reachable from anywhere and surfaces branches, commits, and quick actions. Centered search field in the header doubles as the palette trigger.
- **Branch rename / delete modals** — `BranchRenameModal.vue` and `BranchDeleteModal.vue` replace the inline `rename()` / `confirm()` flows in `BranchMenu`. Delete modal includes a type-the-name guard for unmerged branches. Backed by a new `git_rename_branch` primitive (Rust/Tauri + Node dev-server + TypeScript wrapper), exposed via `useGitRepo.renameBranch`.
- **`useSyncAction` composable** — central state machine for publish / push / pull / fetch / mergeRemote variants, with a unit test suite covering the transitions. Consumed by `SyncSplitButton` and `App.vue`.
- **`BaseModal.vue`** — shared overlay wrapper (backdrop, focus trap, Esc-to-close, sized footers with typed primary/danger/ghost button variants, `bm-btn` class scale pinned to (0,1,0) specificity to keep modifiers composable). 367 lines of chrome reused by 10+ modals.
- **`AiSparkle.vue`** — 77-line reusable sparkle icon for AI-powered actions. Replaces the scattered inline SVGs in the PR review modal, split commit modal, and PR intelligence panel.
- **Merge editor line numbers + minimap** — per-line numbering on code and conflict panels, and a right-side canvas minimap that highlights auto-resolvable vs manual conflicts for one-click navigation across large merges.
- **PR detail markdown description switch** — the Description block in `PrDetailView` now renders full markdown (tables, code blocks, links, blockquotes, images) via the existing `renderMarkdown` composable, with a segmented pill switch ("Formatted" / "Raw") matching the Dashboard's readme widget. New i18n keys `dashboard.formatted` / `dashboard.raw` across the 5 locales.
- **PrIntelligencePanel redesign** — emoji section icons replaced with 28px accent-soft tile + inline SVG; scope grid upgraded to `.pi-stat` cards with radial hover gradient and lift; file rows / hotspot rows / AI flag rows unified with a `border-left: 3px solid` severity strip; conflict summary became a success/danger banner; "Analyser" button is now a primary CTA with play-triangle SVG and hover lift. Loading states use a 10px `.pi-dot-spinner`. `@media (prefers-reduced-motion)` disables all transforms + spin animations.
- **PR create view polish** — `PrCreateView` restyled with an icon hero, segmented template pills, accent AI button, and highlighted draft card for a consistent PR flow with `PrDetailView`.

### Changed

- **10 modals migrated to `BaseModal`** — `EditCommitOverlay`, `MergeSuccessModal`, `PrReviewModal`, `RebaseEditor`, `SettingsPanel`, `SplitCommitModal`, `StashManager`, `BranchRenameModal`, `BranchDeleteModal`, `SearchPalette`. Net impact: duplicated backdrop/focus logic removed, accessibility fixes apply everywhere at once.
- **Sidebar dashboard refresh** — `RepoSidebar.vue` gets more padding and gaps for breathing room, icon badges, and hover lifts on branch / activity / quick-action items.
- **Folder history pill chips** — `FolderPicker.vue` switches from a vertical list to wrapping pill-shaped chips, hiding the path and shrinking pin/remove controls for a denser layout.
- `@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`, `@gitwand/desktop`, and `gitwand-website` bumped to `1.8.0`. `@gitwand/mcp` server-reported handshake version and `packages/mcp/server.json` (MCP Registry manifest) aligned to `1.8.0`.

### Docs

- ROADMAP: new **Tags management** section (UI-driven tag creation, push, log badges) and **Log commit context menu** plan (checkout / reset / revert / create branch / tag / cherry-pick / amend / copy SHA / open on forge / compare with).

## [1.7.0] - 2026-04-21

### Added

- **Split commit by hunks** — a new "Split this commit…" entry in the commit log's context menu opens a dedicated modal that lets you break a single commit in two by picking individual lines across files. Each file shows as a collapsible summary row (chevron, short name, path, +/- stats, hunk count, selected-lines badge); click to expand the full diff and pick lines to keep in the first commit. The rest of the changes flow into the second commit automatically. Selections persist across collapse/expand. Large commits (> 3 files) get a "Expand all / Collapse all" toolbar. A new `git_split_commit` backend primitive ships in both the Rust/Tauri (`lib.rs`) and Node (`dev-server.mjs`) paths with full parity, plus a TypeScript wrapper (`gitSplitCommit`) and a `useSplitCommit` composable.
- **Split integrated into interactive rebase** — pick a commit in the rebase editor and switch its action to `split` (alongside `pick`, `edit`, `squash`, `fixup`, `drop`). The rebase halts at that commit via a synthetic `edit` step, the split modal opens with the commit preloaded, and after you confirm the split the rebase resumes. The progress banner now stays up on `edit` / synthetic-`split` halts (they exit 0 with no conflict, which used to wrongly close the editor).
- **Merge-commit guard (defense in depth)** — splitting a merge commit would silently drop the second parent and flatten history. The guard blocks the operation at every entry point: Rust backend (`git_split_commit`), Node dev-server, TypeScript composable, the `App.vue` dispatcher, and the context-menu entry in `CommitLog.vue` (disabled with tooltip). Error message translated across all 5 locales.
- **Correct patch headers for added / deleted / renamed files** — `GitDiff` now carries `status` (`added | modified | deleted | renamed`) and `oldPath` from `git_show`. `patchBuilder` emits the matching extended header (`new file mode` + `--- /dev/null`, `deleted file mode` + `+++ /dev/null`, or `rename from/to`) so `git apply --cached` stops failing with "does not exist in index" when the split touches a file creation or deletion.
- **i18n** — 6 new strings for the split flow (`errorMergeCommit`, `filesCount`, `expandAll`, `collapseAll`, `hunksCount`, `linesSelectedSuffix`) translated across all 5 locales: `en`, `fr`, `es`, `pt-BR`, `zh-CN`.

### Changed

- Rebase-result types (`startRebase`, `rebaseContinue`, `rebaseSkip`) now carry an explicit `inProgress` flag. `conflict` is reserved for merge conflicts; `inProgress` is the authoritative "rebase still running" signal so UI callers stop conflating the two.
- `@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`, `@gitwand/desktop`, and `gitwand-website` bumped to `1.7.0`. `@gitwand/mcp` server-reported handshake version and `packages/mcp/server.json` (MCP Registry manifest) aligned to `1.7.0`.

### Fixed

- `git_show` parser: the final context-line detection site (line 1811) still used `!starts_with('\\')` instead of `starts_with(' ')`, which misclassified empty strings as context lines. Matches the fix previously applied in the primary diff parser.

## [1.6.3] - 2026-04-20

### Added

- **Worktree manager** — create, list, and remove Git worktrees from a dedicated overlay panel (header button "Worktrees"). Each worktree shows its branch, HEAD SHA, path, and status badges (main / locked / bare). "Open in tab" opens any worktree as a first-class repo tab — enabling parallel work on two branches without stashing or switching. "Prune" cleans up stale administrative files. The "New worktree" form lets you check out an existing branch or create a new one directly at the worktree.
- **Quick worktree from branch list** — every non-current branch in the branch popover now has a worktree shortcut button (⧉ icon). Clicking it opens the worktree manager with the branch pre-selected and the creation form pre-filled, so the "open this branch in a new tab without touching my working tree" flow is two clicks total.
- **Submodule panel** — new "Submodules" header button opens an overlay listing all submodules declared in `.gitmodules`, with live status badges (clean / modified / not initialized). "Init & Update all" runs `git submodule update --init --recursive`. "Open in tab" opens any initialized submodule as a standalone repo tab. "Add submodule" form (URL + local path). An inline warning banner counts uninitialized submodules and doubles as a one-click init trigger.
- **Auto-update infrastructure fixes** — `createUpdaterArtifacts: true` in `tauri.conf.json` (was missing, preventing `.sig` file generation); `updater:default`, `process:default`, `process:allow-restart` permissions added to `capabilities/default.json`; updater endpoint simplified to static `latest.json`; `release.yml` now downloads the `tauri-action`-generated manifest (with real cryptographic signatures) instead of hand-crafting one with empty signature fields.
- **i18n** — all new strings translated across all 5 locales: `en`, `fr`, `es`, `pt-BR`, `zh-CN`.

### Changed

- `tauri.conf.json` updater endpoint: `{{target}}/{{arch}}/{{current_version}}` → `latest.json` (static GitHub Pages, no dynamic server needed).

## [1.6.2] - 2026-04-20

### Added

- **Image diff viewer** — binary image files (PNG, JPG, WebP, GIF, SVG) now render in the commit diff with four comparison modes:
  - **Side-by-side** — before/after framed with dimension + size metadata
  - **Overlay** — stacked images with opacity control
  - **Blink** — alternates the two images to reveal pixel-level deltas
  - **Slider** — draggable reveal between before/after
  Includes a 20 MB per-side guardrail (oversize images are skipped with an explicit notice), safe rendering for SVG (text content, not raster), and an "animated" metadata badge for GIF. New `read_file_at_revision(path, rev)` backend command — available in both the Rust/Tauri and Node dev-server paths — fetches file bytes at any git revision so the viewer can compare `HEAD^` against `HEAD`, across branches, across stashes, etc.
- **Folder tree view in commit diff** — the file list in `CommitDiffViewer` gets a flat ↔ tree toggle. Tree mode shows an expandable folder tree with per-folder aggregates (files changed, additions, deletions) and lets you click any folder to filter the list down to its descendants — a breadcrumb + clear (×) button surfaces the active filter. The sidebar column is now **resizable by dragging its left edge**, with double-click to reset; width is clamped 180–600 px and persisted in `localStorage` (`gitwand.cdv.filelistWidth`). Full keyboard navigation (arrow keys, Enter, Esc) on the tree. New `folder_diff` backend command (3 layers: Rust/Tauri + Node/dev-server + TypeScript wrapper) builds the aggregated tree. i18n across all 5 locales (en, fr, es, pt-BR, zh-CN).

### Changed

- `@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`, `@gitwand/desktop`, and `gitwand-website` bumped to `1.6.2`. `@gitwand/mcp` server-reported protocol version and `packages/mcp/server.json` (MCP Registry manifest) aligned to `1.6.2` so registry consumers see a consistent version.

### Docs

- `packages/mcp/README.md` — document the two supported install paths for `mcp-publisher` (Homebrew and prebuilt binary) so new contributors aren't blocked on the registry-publish step.

### Internals

- `.gitignore` ignores Vite's `*.timestamp-*.mjs` temp files and the `.release-notes-*.md` scratch notes so they stop surfacing in `git status`.

## [1.6.1] - 2026-04-20

### Fixed

- **`@gitwand/mcp` missing `mcpName` field** — the MCP Registry rejects submissions whose referenced npm package lacks the `mcpName` field (ownership-verification mechanism preventing squatting). `@gitwand/mcp@1.6.0` was published without it, so the initial registry submission failed with HTTP 400. Fix: add `"mcpName": "io.github.devlint/gitwand"` to `packages/mcp/package.json` and re-publish as `1.6.1`.
- **`@gitwand/mcp` server-reported version** — `src/server.ts` hardcoded the protocol handshake version to `1.6.0`, now bumped to `1.6.1` in sync with package.json.

### Changed

- `packages/mcp/server.json` (MCP Registry manifest) bumped to `1.6.1` accordingly. `@gitwand/core` and `@gitwand/cli` remain at `1.6.0` — no code change needed there.

### Docs

- Root README and `packages/mcp/README.md` show an **MCP Registry** badge pointing to `registry.modelcontextprotocol.io`.
- Website (`HomeLanding.vue`, 5 locales) — MCP badge updated to surface the registry listing, FAQ answer for MCP install now leads with the `claude mcp add gitwand -- npx -y @gitwand/mcp` one-liner, and the CLI platform card fixes the stale `npm i -g gitwand` (was never a valid package name) to `npm i -g @gitwand/cli`.
- Root README roadmap — the `published to npm + MCP Registry` line is checked off with a ship date.

## [1.5.1] - 2026-04-19

### Fixed

- **CI release — tauri-bundler failing on every platform** — the `parity_probe` test binary was declared as `[[bin]]` with `required-features = ["parity-probe"]`. tauri-bundler auto-discovers **every** `[[bin]]` entry in `Cargo.toml` and tries to embed it as a sidecar in the final bundle, regardless of whether the feature was enabled — so release builds failed with `Failed to copy binary from .../target/release/parity_probe: does not exist`. Fix: move the probe from `[[bin]]` to `[[example]]` (examples are ignored by tauri-bundler and aren't built by default). Source moves from `src-tauri/src/bin/parity_probe.rs` to `src-tauri/examples/parity_probe.rs`; build command becomes `cargo build --example parity-probe`; output path becomes `target/debug/examples/parity-probe`. Parity harness default path updated accordingly.
- **macOS permission dialog prompting 50× on home folder** — opening the home directory triggered a `.join(".git").exists()` probe on every entry, which hit macOS TCC for `Documents`, `Desktop`, `Downloads`, `Pictures`, `Movies`, `Music`, and `Library`. Unsigned/ad-hoc dev builds don't persist TCC decisions, so the dialog reappeared for every child access. Fix: `MACOS_TCC_PROTECTED` guard in both the Rust (`list_dir`) and Node (`dev-server.mjs`) backends skips the `.git` probe for these well-known system folders when listing the home directory — they're never git repos anyway.
- **Unused variable warning** — `shortcut` → `_shortcut` in the global-shortcut closure at `src-tauri/src/lib.rs` (silences the clippy warning in release builds).

### Changed

- `@gitwand/core`, `@gitwand/desktop`, and `gitwand-website` bumped to `1.5.1`.

### Internals

- **i18n sweep — composable errors** — the remaining hardcoded French error strings in the AI-powered composables (`useCommitMessage`, `useBranchName`, `useReleaseNotes`, `useStashMessage`, `usePrDescription`, `useSquashSuggestion`, `usePrHunkCritique`, `useBlameContext`, `useMergeRisk`, `useCommitSearch`, `useHunkExplanation`, `useAIProvider`) now route through the `errors.*` namespace populated in all 5 locales. A standalone `t` helper is exported from `useI18n` so non-component modules can translate without instantiating the composable.

## [1.5.0] - 2026-04-19

### Security

- **XSS hardening across 10 views** — all `v-html` usage now routes through a shared `useSafeHtml` / `useMarkdown` composable that sanitizes output with DOMPurify (markdown-it for the markdown path). README rendering, PR bodies, commit-message previews, and every other bit of user- or Git-authored markup is filtered through a conservative DOMPurify profile with a URI allow-list, `target="_blank" rel="noopener noreferrer"` hardening, and `javascript:` protocol blocking.
- **Dev-server CORS + filesystem path enforcement** — the Node dev-server now refuses requests from unexpected origins and validates every repo/file path against a safe root, preventing path traversal on the desktop app's local HTTP bridge.

### Added

- **English-first UI** (P3.1) — the desktop app now defaults to English, with French as a secondary locale kept in sync. The locale registry's source of truth moves from `fr.ts` to `en.ts`, and the public website landing page mirrors the same default. French is automatically picked up when the browser / OS prefers it, and the Settings panel still lets users force either language.
- **`.gitwandrc` — `generatedFiles` option** (P2.4) — users can now declare extra glob patterns (e.g. `"dist/**"`, `"**/*.generated.ts"`) that GitWand treats as generated when applying the `generated_file` resolver. Patterns are additive on top of the built-in list.
- **Post-merge validation — YAML + TOML** (P2.5) — the `validateMergedContent` contract is extended with format-specific parsers. Invalid YAML / TOML after a merge is surfaced as a `syntaxError` with a `YAML: …` / `TOML: …` prefix, matching the existing JSON behaviour.
- **3 new parity-tested Tauri↔Node commands** (P2.3) — the Rust/Tauri and Node/dev-server backends now share a parity probe harness to catch drift; 3 commands are validated end-to-end on every build.

### Changed

- `@gitwand/core` and `@gitwand/desktop` bumped to `1.5.0`.
- `@gitwand/cli` and `@gitwand/mcp` bumped to `1.3.0` (parallel CLI loop, module split).
- `gitwand-website` bumped to `1.5.0` and aligned with the app release tag.

### Performance

- **LCS memory — O(n·m) → O(min(n, m))** (P2.1) — the diff engine's LCS now runs a hybrid `Int32Array` DP under 4M cells and switches to Hirschberg's divide-and-conquer above. Measured on 3000×3000 inputs: ~36 MB → ~1 MB, a ~35× reduction. Tie-break behaviour is preserved so existing diffs are byte-identical.
- **Parallel conflict loading in the desktop app** (P1.2) — conflicted files are read in parallel instead of one-by-one, with bounded concurrency. Same concurrency model applied to `saveAllFiles`.
- **Parallel CLI file loop** (P1.3) — `gitwand resolve` walks the conflict set concurrently (bounded) rather than serially. Throughput scales with file count on big merges.

### Internals

- **Shared markdown pipeline** (P1.4) — every view that used to call markdown-it / DOMPurify directly now goes through a single `useMarkdown` composable.
- **Resolver refactor** (P1.1) — the monolithic `resolver.ts` was split into 6 focused sub-modules (`validation`, `policy`, `generated-detection`, …), keeping the public API identical.
- **CLI refactor** (P2.2) — `cli/index.ts` split into sub-modules, one per command concern.
- Removed deprecated `@types/dompurify` — DOMPurify 3.x ships its own types.

## [1.4.0] - 2026-04-17

### Added

#### AI Everywhere (Phase 1.3.x)

- **AI branch-name suggestion** (1.3.1) — generate `feat/…` / `fix/…` branch names from a description or the staged diff.
- **AI PR title & description** (1.3.1) — `PrCreateView` analyses the `currentBranch..base` diff and produces a structured title + body (summary, test plan, breaking changes).
- **Hunk-level AI critique in PR Review** (1.3.1) — the Intelligence panel now surfaces per-hunk feedback (risks, regressions, concrete suggestions) instead of static heuristics.
- **Natural-language conflict explanation** (1.3.2) — the DecisionTrace is translated into plain English inside the merge editor ("this hunk changes the `login()` signature on both sides — manual resolution required").
- **Pre-merge AI risk summary** (1.3.2) — `MergePreview` complements the `merge-tree` simulation with an AI summary of risk ("3 files touch auth, high regression probability if untested").
- **AI stash message** (1.3.3) — the stash flow (including the switch-branch modal) proposes a message from the unstaged diff.
- **AI semantic squash grouping** (1.3.3) — interactive rebase groups candidate commits by intent and proposes a combined message.
- **AI-ranked Absorb target** (1.3.3) — when lines span multiple commits, the best candidate is picked from a semantic ranking rather than the first `git blame` hit.
- **Natural-language commit search** (1.3.4) — query the log with plain-English questions ("when did we introduce log pagination?").
- **AI blame context** (1.3.4) — "why did this line change?" button on each blame block, with context from neighbouring commits.
- **AI release notes generator** (1.3.4) — structured markdown (Added / Changed / Fixed) from `git log <tag>..<tag>`, ready to paste into a GitHub release.
- **Rotating feature tips on the empty state** (1.3.5) — a pool of ~20 localised tips cycles every 30 s on the dashboard before repo selection.

#### Conflict engine — v1.4

- **Pattern registry** — classification pipeline rewritten around a prioritised pattern registry; each pattern declares its `priority`, `requires` (`diff3` / `diff2` / `both`), `detect`, `confidence`, and `explanation`.
- **New resolver: `reorder_only`** — detects pure permutations (same lines on both sides, different order). Auto-resolved.
- **New resolver: `insertion_at_boundary`** — detects pure insertions on both sides with an intact base. Auto-resolved.
- **Refined confidence scoring** — boosters, penalties, and dimensions tuned for the two new patterns and for stricter guarding on `complex`.

#### Desktop

- **Auto-update check** — background check against the GitHub Releases feed on app launch, with a toast + changelog link when a new version is available.
- **App version display** — current version now visible in the footer / About section.

#### Branding

- Shared hex-cube favicon across desktop app and website.

### Changed

- `@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`, `gitwand-vscode`, `gitwand-website`, `@gitwand/desktop` versions aligned to `1.4.0`.
- `ConflictType` union extended with `reorder_only` and `insertion_at_boundary`.
- Replaced hardcoded CSS values with design tokens across desktop views.

## [1.2.0] - 2026-04-16

### Added

- **Interactive rebase** (Phase 1.2.1) — drag-and-drop reorder in the log, per-commit actions (squash, edit message, drop, fixup), multi-select squash with combined message, rebase onto branch from the UI, in-flight conflict handling (continue/abort/skip).
- **Absorb** (Phase 1.2.2, inspired by GitButler) — right-click a modified file to absorb it into an existing commit, automatic candidate detection via `git blame`, partial absorb through hunk selection (`useAbsorb.ts`).
- **AI commit messages** (Phase 1.2.3) — dropdown in the commit area analyses the staged diff and produces summary + description. Provider-agnostic: Claude Code CLI, Claude API, OpenAI-compatible, Ollama. Regenerate, shorten, expand, switch language.
- **Universal Undo** (Phase 1.2.4) — operation stack covering commit, merge, rebase, cherry-pick, stash, discard. One-click undo via `git reset` / `git reflog`. History panel lets you jump back to any prior state.
- `gh-merge-pr` endpoint in the desktop dev-server plus a TypeScript wrapper.
- Website homepage: new LLM/MCP section and FAQ.

### Changed

- `@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`, `gitwand-vscode`, `gitwand-website` versions aligned to `1.2.0`.
- Desktop app (`@gitwand/desktop`) and Tauri bundle bumped to `1.2.0`.

## [1.1.0] - 2026-04

### Added

- **MCP server** (`@gitwand/mcp`) — 5 tools (`gitwand_status`, `gitwand_resolve_conflicts`, `gitwand_preview_merge`, `gitwand_explain_hunk`, `gitwand_apply_resolution`) and 3 resources, stdio transport, compatible with Claude Code, Claude Desktop, Cursor, Windsurf.
- **Claude Code slash commands** — `/resolve` and `/preview` workflows.
- **Enriched CLI JSON output** — confidence scores, decision traces, `pendingHunks` with ours/theirs/base, post-merge validation.
- **Partial resolution** in the desktop app — apply resolvable hunks even when others remain manual.
- **Merge success modal** with Close and Push actions, light/dark themed via design tokens.
- **Dashboard README improvements** — GitHub-style header parsing, GFM tables, checkboxes, anchor navigation, relative image handling.
- **Website MCP Server page** and FR/EN homepage toggle.
- **New 3D hexagonal cube logo**; Tauri app icons regenerated (ico, icns, multi-size PNG).

## [1.0.0] - 2026

### Added

- Core conflict resolution engine: 8 patterns (same_change, one_side_change, delete_no_change, whitespace_only, non_overlapping, value_only_change, generated_file, complex), LCS 3-way, diff2 + diff3.
- Composite confidence scoring (`ConfidenceScore` 0–100), configurable merge policies via `.gitwandrc`, decision trace, explain-only mode.
- Format-aware resolvers: JSON/JSONC, Markdown, YAML, Vue SFC, CSS/SCSS, TS/JS imports, npm/yarn/pnpm lockfiles.
- CLI (`gitwand resolve`, `gitwand status`) with `--ci` / `--json` structured output.
- VS Code extension: diagnostics, CodeLens, status bar, `resolveFile` / `resolveAll` commands.
- Desktop app (Tauri 2 + Vue 3): complete Git workflow — staging, commit, push/pull, branches, merge editor, advanced diff, history, DAG graph, file history, blame, time-travel diff, merge preview, cherry-pick, stash, amend, repo switcher, multi-tabs, terminal, PR workflow via `gh` CLI, inline code review, intelligence panel, AI suggestions (Claude / OpenAI / Ollama), i18n FR/EN, theme dark/light/system.
- 332 tests, 20 fixtures corpus, benchmarks (249k ops/s on single conflict).
- CI/CD multi-OS (macOS universal, Linux, Windows), Tauri updater, VitePress documentation site.

## [0.0.1] - 2026-04-03

### Added

- **Core engine** (`@gitwand/core`) with 5 automatic conflict resolution patterns:
  - `same_change` — both branches made the exact same edit (certain)
  - `one_side_change` — only one branch modified a block (certain)
  - `delete_no_change` — one branch deleted, the other didn't touch (certain)
  - `whitespace_only` — same code, different formatting (high)
  - `non_overlapping` — additions at different locations, LCS-based 3-way diff (high)
- **CLI** (`@gitwand/cli`) with commands:
  - `gitwand resolve` — auto-resolve trivial conflicts
  - `gitwand status` — show conflict status
  - `--ci` / `--json` mode with structured JSON output and exit codes
  - `--dry-run`, `--verbose`, `--no-whitespace` options
- **VS Code extension** (`gitwand-vscode`) with:
  - DiagnosticsProvider — inline warnings on each conflict
  - CodeLensProvider — clickable annotations above each conflict marker
  - StatusBarItem — conflict count with auto-resolvable ratio
  - Commands: `resolveFile`, `resolveAll`
- **Desktop app placeholder** (Tauri + Vue 3, Phase 4)
- CI pipeline via GitHub Actions (Node 18, 20, 22)
- 28 tests covering all patterns + real-world scenarios (package.json, Laravel routes, Vue SFC, CSS, .env files)

[Unreleased]: https://github.com/devlint/GitWand/compare/v2.4.1...HEAD
[2.4.1]: https://github.com/devlint/GitWand/releases/tag/v2.4.1
[2.3.0]: https://github.com/devlint/GitWand/releases/tag/v2.3.0
[2.0.1]: https://github.com/devlint/GitWand/releases/tag/v2.0.1
[2.0.0]: https://github.com/devlint/GitWand/releases/tag/v2.0.0
[1.4.0]: https://github.com/devlint/GitWand/releases/tag/v1.4.0
[1.2.0]: https://github.com/devlint/GitWand/releases/tag/v1.2.0
[1.1.0]: https://github.com/devlint/GitWand/releases/tag/v1.1.0
[1.0.0]: https://github.com/devlint/GitWand/releases/tag/v1.0.0
[0.0.1]: https://github.com/devlint/GitWand/releases/tag/v0.0.1
