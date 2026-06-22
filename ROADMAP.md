# GitWand — Roadmap

> Full release details: [CHANGELOG.md](./CHANGELOG.md)

---

## What's Next

### v2.25.0 — Terminal tabs & AI workspace

_Inspired by t1gu1's feedback: "How can I code with AI in GitWand?" — GitWand as a native AI workspace._

**Prerequisite fix — "Launch Claude Code" opens no usable session** _(follow-up to v2.8.0 Agent Sessions)_

The Agent Sessions launch action is wired end-to-end but doesn't produce a working session — a blocker for the AI-workspace vision below.

- **Root cause**: `agent_session_launch` spawns the `claude` CLI via `hidden_cmd` with `stdin`/`stdout`/`stderr` redirected to `null` and no terminal window (`hidden_cmd` is the *headless* helper — it sets `CREATE_NO_WINDOW` on Windows). But Claude Code is an interactive TUI requiring a TTY, so the process exits immediately / runs invisibly — the user clicks and nothing happens.
- **Fix**: open a real terminal in the worktree's cwd and run `claude` there, reusing the cross-platform pattern already implemented in `claude_cli_login` (`osascript` → Terminal.app on macOS, `cmd /k start` on Windows, `gnome-terminal`/`konsole`/`kitty`/… on Linux). Factor that terminal-launch logic into a shared helper.
- **Drop the fake "active" state**: the frontend sets `active = true` optimistically after a 1.5 s `setTimeout` with no confirmation the agent actually started — re-poll `agent_session_list` after launch instead.
- **Make Cursor/Windsurf launchable too**: today the Launch button only shows for `claude`/`other`; those GUI editors have no launch path from the panel.

**Terminal with tabs**

- The integrated terminal extended with tabs: multiple simultaneous shell sessions (`⌘T` new, `⌘W` close, `⌘1..9` switch)
- Automatic title from the first command, or editable with a double-click
- Terminal panel anchored at the bottom, resizable height

**AI workspace (exploratory phase)**

- "New AI task" button: opens a blank worktree + launches a Claude Code (or Codex CLI) session in a dedicated terminal tab — the worktree diff displays live in GitWand
- Vision: GitWand as the command center for coding with AI — see what the agent changes, stage what you want, commit — without leaving the app
- User feedback expected to shape v2.25.0+

---

### v2.26.0 — Safety Bundle: pre-commit secrets scanner

_Inspired by GitSquid. A "safety" feature with zero network dependency — everything local._

- **Scanner integrated in the staging area**: AWS, GCP, Azure, GitHub tokens (`ghp_`, `github_pat_`), GitLab (`glpat-`), Slack, Stripe, OpenAI, Anthropic, RSA/OpenSSH/EC keys, JWTs, high-entropy literals
- **Extensible patterns** via `.gitwandrc`: `secrets.patterns[]` + `secrets.ignore[]`
- **Non-blocking UX**: orange badge in the commit area — the user can commit with confirmation or ignore the pattern
- **Zero network**: local matching via Rust (`regex` crate)
- **Opt-in pre-commit hook** in Settings > Hooks

---

### v2.27.0 — Stacked Branches (native)

_A differentiating feature: stacked PRs workflow without an external CLI (Graphite, ghstack…)._

The paradigm: short stacked branches (`feat/step-1` → `feat/step-2` → `feat/step-3`), each with its own PR targeting the previous one.

**Visualization** — The DAG automatically identifies stacks; a "Stack" banner in the sidebar; a "Stacks" tab in the Launchpad

**Creation** — "Stack a branch" button in the context menu; `⌘⇧S` shortcut from the commit area

**Restack** — Automatic detection when the base has moved; one-click "Restack" button (cascading `git rebase --onto`); conflict preview before execution

**PRs** — "Submit stack": creates or updates GitHub PRs for each layer; automatic retarget when a layer is merged

**Implementation** — Metadata in `.gitwand-workspace.json`; no external CLI dependency

---

### v2.28.0 — Voice Input (experimental)

- **Local dictation**: microphone button in the commit panel — transcription via embedded Whisper (`whisper-rs` Rust) — zero cloud
- **Optional AI enrichment**: pass dictated text through `useAIProvider` for conventional commit formatting
- **Models**: `tiny` or `base` downloaded on demand, stored locally
- **Multilingual**: Whisper auto-detects the language
- **Graceful fallback**: clear message if microphone access is denied by macOS TCC

---

### v2.29.0 — Today: triaged action inbox (renamed from Launchpad)

_Evolves the Launchpad (v2.9.0, + in-app review & action inbox in v2.24.0) from a PR/issue table with a generic "Open in GitHub" action into a prioritized, state-aware action inbox — the daily "what do I do next" surface. **Renamed "Launchpad" → "Today"** ("Launchpad" was GitKraken's term; "Today" frames it as the daily-driver). Mockup-driven. The differentiator vs GitKraken/Tower: each item routes to a **native GitWand surface**, not back to the forge._

**Status** — _Phase 1 shipped_: 3 urgency tiers, state-aware primary action per row, local working-state band, reworked card UI (left accent · state pills · avatars · CI/review chips · diff stat · action hierarchy), pill-chip tab bar, centered max-width layout. _Phase 2 (in progress)_: rename Launchpad → Today; counted filter chips + group-by toggle (Priority/Repo/Type) over a unified list; issues / `@`-mentions / dependency PRs as first-class items. _Deferred (Phase 3)_: active mutations — real nudge / auto-merge, and a direct jump from "Resolve" into the conflict resolver (today routes to in-app PR review).

**Urgency tiers** — three collapsible buckets above the current review/changes/ci/merge granularity:
- **À traiter** — needs me now (review requested, changes requested, CI failed, ready to merge, merge conflicts, mention)
- **En attente** — waiting on others / CI running / approved-but-not-mergeable
- **Plus tard** — dependency bumps, auto-mergeable, low-priority

Subtitle shows "N items · M to handle" (inbox-zero signal). Group-by toggle: **Priority** (default) · **Repo** · **Type**.

**State-aware primary action** — the single most relevant next action replaces the generic "Open in GitHub", each routing to an existing GitWand surface:

| Item state | Action | Routes to |
|---|---|---|
| Ready to merge | **Merge** | native merge |
| Review requested | **Review** | in-app PR review (v2.24) |
| CI failed | **See failure** | CI annotations (v2.18) |
| Changes requested / mention | **Reply** | in-app PR/issue thread |
| Merge conflicts | **Resolve** | GitWand conflict resolver — the key differentiator |
| Waiting / CI running | **Follow / Nudge** | — |
| Dependency bump | **Auto-merge** | — |

**Local working state as inbox items** — surface uncommitted changes ("1 uncommitted change on `main` → Commit") and local conflicts at the top, so the inbox spans local + remote. Wires the existing `useRepoActionCards` (commit/publish/push/sync) into the Launchpad header.

**Issues, mentions & dependencies first-class** — extend the inbox beyond *my PRs*: `@`-mentions on issues/PRs, assigned/authored issues, and dependency-update PRs each get their own type, count and action.

**Richer per-row state** — explicit pills (Ready to merge · Review requested · CI failed · Changes requested · Merge conflicts · Mention), CI chip (✓ / ✗ / running), review chip (Approved / Changes requested), read/unread dot, diff stat, labels.

**Counted filter chips** — All · My PRs · To review · Issues · Dependencies · Mentions, each with a live count.

**Implementation** — generalize `useLaunchpadInbox` (today PR-only, 4 buckets) into a tiered classifier over a union item type (PR · issue · mention · dep · local-action card); reuse `useRepoActionCards`, `useLaunchpadScope`, the v2.24 review/issue panels. No new forge round-trips on the hot path — drive off the existing `workspace_prs_all` enriched payload + the Launchpad poller.

---

### Later (unscheduled)

- **In-app folder-browser + right-click "Scope here"** — follow-up to v2.21.0 Monorepo Scope: a recursive working-tree folder panel where right-clicking a folder scopes to it. Ad-hoc scoping already ships via the picker's "Custom folder…"; this in-tree gesture is deferred (the existing `FolderDiffTree` is a *diff* tree — the wrong substrate — and is unmounted).

---

## Vision

GitWand is a native Git client that **understands** code, resolves trivial conflicts on its own, and makes visible what the terminal hides.

Positioning: neither "yet another Git GUI" nor an IDE. A first-class Git navigation tool — fast, local-first, cross-platform — with a unique algorithmic intelligence for conflict resolution, and a surface for interacting with AI agents (MCP, Agent Sessions, terminal).

**Core values**: open source (MIT) · native performance (Tauri 2 + Rust) · zero mandatory cloud · every feature optional and explicit.

---

## Competitive landscape

| Client | Stack | Price | Strengths | Weaknesses |
|--------|-------|-------|-----------|------------|
| **Kaleidoscope** | macOS native | ~€150/yr | Image diff, folder diff, visual 3-way merge | macOS-only, no Git workflow, no auto-resolve |
| **GitHub Desktop** | Electron | Free | Simple, GitHub PR workflow, cherry-pick/rebase | GitHub only, basic diff, no AI, no auto-resolve |
| **GitButler** | Tauri/Rust | Free | Virtual branches, stacked PRs, Agents Tab (Claude Code); MCP server, Series A Apr 2026 | Unfamiliar paradigm, no algorithmic auto-resolve |
| **GitKraken** | Electron | $8/mo | Agent Mode v12.0, multi-forge, Launchpad, cloud Workspaces, AI commit/PR/merge | Paid, Electron, cloud account required for advanced features |
| **GitSquid** | Tauri/Rust | €49/yr | Conflict Predictor, scratch worktree, Monorepo Scope, secrets scanner, multi-forge | Paid, no algorithmic auto-resolve |
| **Fork** | Native | $50 | Fast, clean UI, large repos | No inline PR review, no auto-resolve |
| **Tower** | Native | $69/yr | AI commits (Claude Code + Codex, v16 May 2026), multi-forge | Paid, no resolve engine |
| **Sublime Merge** | Native | $99 | Ultra-fast, configurable `diff_algorithm` | No PR workflow, no AI, no auto-resolve |

---

## Shipped

> Full change details per version: [CHANGELOG.md](./CHANGELOG.md)

| Version | Highlights |
|---------|-----------|
| **v2.24.0** | Full-screen views & in-app Launchpad — the permanent sidebar/Git-Tree strips give way to a floating bottom-center `AppDock`; Dashboard, Changes, History, PRs and a first-class full-screen Git Tree each render full-bleed (`RepoSidebar` gains a `pane` prop; collapsible, persisted commit composer rail). Launchpad gains in-app issue review (`IssueDetailView` + `useIssuePanel`), an action inbox (`useLaunchpadInbox` / `useRepoActionCards`), extracted scope (`useLaunchpadScope`) and internal navigation. The list/tree file-tree toggle extends to the history (commit) sidebar (`useFileTree` generalised over any `{ path }` entry). Plus a Linux AppImage follow-up: URL openers de-pollute `PATH`/`XDG_*` so a spawned `xdg-open` resolves the system browser instead of silently no-opening (#52), with opener stderr/exit captured. `EditCommitOverlay`/`SplitCommitModal` lazy-loaded. Full dev:web parity + 5-locale i18n |
| **v2.23.0** | Changes sidebar & rebase polish — list/tree layout toggle for the changes view (collapsible folders, persisted layout + per-section collapse state, auto-expand to the selected file) via a new `useFileTree` composable; per-file and per-folder stage/unstage/discard fused into an always-visible segmented "action group". Interactive rebase now works in the packaged desktop app (dedicated `git_interactive_rebase` Tauri command replacing a dev-only HTTP endpoint) and branch pickers list branches by most-recent commit (shared `branchSort`). Plus a Linux AppImage fix: external links/OAuth buttons route through a robust multi-opener chain. Full dev:web parity + 5-locale i18n |
| **v2.22.0** | Advanced conflict resolution — file-level bulk resolution ("Accept all: Current · Incoming · Both" in one click, persistent memorize-rule toast, one-click "Apply rule to N hunks"); tree-conflict resolution for markerless conflicts (modify/delete, both-deleted, add/delete) via `get_tree_conflicts`/`resolve_tree_conflict` with a dedicated editor panel + sidebar badge; markerless content-conflict reconstruction (`reconstruct_conflict` rebuilds the 3-way text from index stages when the working tree lost its `<<<<<<<` markers). Plus remote-state reliability fixes: false "Publish branch" on already-published branches (`remote_branch_exists`), false "offline" blocking push/pull (WKWebView spurious events → hysteresis + authoritative `confirmOnline` probe), and `git_remote_info` preferring `origin` (fixes the bogus "unpushed tags" modal). Full dev:web parity + 5-locale i18n |
| **v2.21.0** | Monorepo Scope — pick a sub-workspace and scope the commit graph, search & stats to its file tree. Auto-detects 6 workspace formats (pnpm, npm/yarn, Cargo `[workspace]`, `nx.json`, `turbo.json`, `go.work`), parsed natively in Rust with a documented precedence; scope persisted per repo (additive `scope` field in `.gitwand-workspace.json`, validated on load); `git_log` pathspec filtering + a new `git_rev_count` driving a stable "N commits hidden" badge; sidebar `ScopePicker` (auto-detected packages + "Custom folder…" ad-hoc), active-scope chip & badge in the graph header. Picker shows only on detected monorepos; full dev:web parity via a mock `detect-monorepo` route |
| **v2.20.0** | Scratch worktree + extended Conflict Predictor — "Resolve in scratch worktree" from the merge preview opens a temporary isolated `gitwand-scratch-<timestamp>` worktree as a repo tab (resolve away from the active checkout, bring changes back in one click or discard, auto-cleanup, origin-anchored lifecycle); Conflict Predictor extended to rebase (per-commit replay against `onto`) and cherry-pick — side-effect-free `preview_rebase` / `preview_cherry_pick` Tauri commands, MCP `gitwand_preview_merge` `operation` param, new `gitwand preview` CLI command, operation selector + risk badge (low/medium/high) + hunk-by-hunk preview in the panel |
| **v2.19.0** | GitHub OAuth & Azure DevOps + cross-fork PRs — "Sign in with GitHub" via OAuth device flow (tokens in the OS keychain, tokenless REST path, no `gh` CLI required), Azure DevOps as a first-class forge (`AzureProvider`, Entra ID device flow + auto token refresh, PR list/detail/diff/create/merge/checkout, comments, branch-policy CI checks, reviewer votes), cross-fork pull requests (target-repo selector defaulting to upstream, fork PRs surfaced in the list), and a backend performance pass (async Tauri commands, disk-persisted SWR PR cache, libgit2 `git_status` fast-path) |
| **v2.18.0** | Inline CI Check Annotations — check-run annotations overlaid in the PR diff across the three forges (GitHub check-runs API, GitLab `artifacts:reports:codequality`, Bitbucket Reports API), gutter icons ❌/⚠/ℹ with hover tooltip, clickable "N annotations" badge in the CI tab, per-file ⚠ count in the diff sidebar, forge-agnostic `CIAnnotation` type + `ForgeProvider.getCheckAnnotations()`, lazy one-shot fetch per PR; Copilot CLI as a fourth AI provider (text-only sandbox) |
| **v2.17.0** | opencode provider + per-CLI model picker — `opencode-cli` as a first-class AI provider (`opencode run`, binary discovery, Settings status), second model select under the provider picker for the three CLI agents (opencode enumerates via `opencode models`, Claude Code aliases, Codex free-text), `aiModelByProvider` persisted per provider, `--model` threaded through all three CLIs |
| **v2.16.0** | PR Activity Notifications — background Launchpad poller, zero-network snapshot diff (`useLaunchpadNotifications`) for CI flips / review requests / new comments / merge-close, native OS notifications via `tauri-plugin-notification` (background-only), Settings granularity (All · Reviews & comments · CI failures only · None) + "by people" bot filter, enriched `workspace_prs_all` (CI/review/comment fields) |
| **v2.15.1** | Git Tree polish & quick actions — Force push (branch context menu + protected-trunk/diverged-remote guard), Quick Stash `⌘⇧,` (instant, AI label) + pending badge in the commit area, Submodules in the Git Tree (branch-picker section, per-commit pointed-SHA badge, click-to-navigate) |
| **v2.15.0** | Git Tree multi-branch — Git Tree as primary view, Log panel removed, unified context menus, stash/branch/tag management from the graph, DAG trunk-pinning, WIP node, search bar |
| **v2.14.0** | Forge completeness — GitLab `updateComment`/`deleteComment`/CI checks, complete Bitbucket stubs, forge-agnostic `getConflictPreview`/`getHotspots`, multi-account provider |
| **v2.13.0** | AI & Review — custom AI prompt presets, GitHub-native inline code suggestions in PRs |
| **v2.12.0** | Branch Management & Identity — Archived Branches, Pinned Branches, Multiple Committer Identities, Commit Templates |
| **v2.11.0** | Large-scale performance — `backend.ts` domain split, Fork Point visualization, transparent command log (`⌘⇧L`), real-time clone progress, CommitLog pagination |
| **v2.10.0** | Forge integrations + MCP catalog — GitLab MRs, Bitbucket PRs, multi-account, in-app MCP catalog (Settings > MCP, one-click install) |
| **v2.9.0** | Launchpad — cross-repo PRs/Issues/WIP/Team dashboard, pin/snooze, `⌘L`, lazy Team, 95 green tests |
| **v2.8.0** | Agent Sessions View + Scheduled AI tasks — Agents panel, active MCP sessions, launch Claude Code from GitWand |
| **v2.8.2** | Performance hardening — lazy-load 20 panels, bundle −150 KB, libgit2 fast-path, consolidated polling, `lib.rs` split into 6 domains |
| **v2.7.0** | Multi-repo Workspaces + Hooks manager + Worktree first-class — tab=worktree, quick-create "New task" (`⌘⇧N`), cross-worktree status |
| **v2.6.0** | `@gitwand/core` Refactoring-aware merge — rename/move detection, opt-in via `.gitwandrc` |
| **v2.5.0** | LLM fallback opt-in — `llm_proposed` pattern, `resolveAsync()`, audit trail, desktop+CLI+MCP tie-in |
| **v2.4.1** | Semantic post-merge validation — tree-sitter parse-tree validity, opt-in `tsc --noEmit`, `postMergeRisk` dimension |
| **v2.3.0** | Tree-sitter structural dispatcher — entity-by-entity merge for TS/JS/Python/Go/Rust, +20-30% auto-resolution |
| **v2.2.0** | Format profile registry + JSON Patch arrays — `/dependencies`, `/scripts`, RFC 6902, +10-15% on JSON/YAML |
| **v2.1.0** | Histogram diff & block-move detection — Patience++, Rabin-Karp rolling hash |
| **v2.0.0** | Distribution & polish — Clone & Fork from the UI, Codex CLI provider, native macOS menu bar, Contributors Dashboard |
| **v1.9.0** | Git 2.54 suite — commit context menu (checkout/reset/revert/branch/tag/cherry-pick), Trailers, Blame diff algorithm, File history line-range + pickaxe, Tags panel, Conventional Commits prefixes |
| **v1.8.0** | Design system & modal foundations — AppHeader split, BaseModal, merge editor line numbers + minimap, PR description markdown |
| **v1.7.0** | Split commit by hunks — line-by-line selection, integrated into interactive rebase |
| **v1.6.x** | Folder diff, Image diff, Submodules & Worktrees, `@gitwand/core`/`@gitwand/cli`/`@gitwand/mcp` published on npm + MCP Registry |
| **v1.5.x** | Hardening, performance & English-first — XSS, LCS O(min), CI Rust↔Node parity, macOS TCC fix |
| **v1.4.0** | Pattern registry — `reorder_only`, `insertion_at_boundary`, desktop auto-update |
| **v1.3.0** | AI Everywhere — branch naming, PR writing, hunk review, conflict explanation, commit search, release notes |
| **v1.2.0** | Interactive Rebase, Absorb, AI commits, Undo stack |
| **v1.1.0** | MCP server (`@gitwand/mcp`) — 5 tools, 3 resources, Claude Code slash commands, enriched CLI JSON |
| **v1.0.0** | Full Git client + resolution engine — 8 patterns, diff3 LCS, format-aware resolvers, PR workflow + integrated Code Review |

---

## Design principles

1. **Intelligence first** — Every screen should offer more than the terminal.
2. **Native performance** — Tauri 2 + Rust. Sub-1s startup, smooth on 100k+ commits.
3. **Progressive** — Works immediately for simple cases. Advanced features are discovered naturally.
4. **Cross-platform** — macOS, Linux, Windows. Same quality everywhere.
5. **Free and open source** — Core and desktop under MIT.
