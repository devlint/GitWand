# GitWand — Roadmap

> Full release details: [CHANGELOG.md](./CHANGELOG.md)

---

## What's Next

_Ordered by priority (2026-07-03). The thread: secure the commit path (v3.3), rebuild the two review surfaces on one shared AI pipeline (v3.4–v3.5), lay the safety net before shipping more auto-apply (v3.6), make the app reactive and fast (v3.7), close the resolution loop (v3.8), then workflow & comparison primitives (v3.9–v3.10), experimental voice input (v3.11), and the v4.0 code-intelligence headline._

### v3.3.0 — Safety Bundle: pre-commit secrets scanner

_Inspired by GitSquid. A "safety" feature with zero network dependency — everything local._

- **Scanner integrated in the staging area**: AWS, GCP, Azure, GitHub tokens (`ghp_`, `github_pat_`), GitLab (`glpat-`), Slack, Stripe, OpenAI, Anthropic, RSA/OpenSSH/EC keys, JWTs, high-entropy literals
- **Extensible patterns** via `.gitwandrc`: `secrets.patterns[]` + `secrets.ignore[]`
- **Non-blocking UX**: orange badge in the commit area — the user can commit with confirmation or ignore the pattern
- **Zero network**: local matching via Rust (`regex` crate)
- **Opt-in pre-commit hook** in Settings > Hooks

---

### v3.4.0 — PR Review 2.0: faster, keyboard-first, AI-assisted

_Rebuild of the in-app PR review (v2.24.0) around performance, review flow and a Greptile-style AI layer — benchmark-driven._

**Today's baseline** — `PrDetailView.vue` (2.3k lines) + `PrInlineDiff.vue` + `PrIntelligencePanel.vue` + `usePrPanel.ts` already cover pending-review batches, multi-line comments, GitHub-native suggestions, CI annotations (v2.18.0), SWR cache (v2.19.0) and on-demand AI hunk critique (`usePrHunkCritique.ts`). Gaps: the whole diff loads at once (no per-file lazy load, no hunk virtualization — scroll lag on 50+ file PRs), no viewed-file tracking, no keyboard navigation, AI is on-demand only and scattered, no PR summary, GitLab/Bitbucket review methods are stubs.

- **Benchmark first** — score the current review against GitKraken, Tower, Graphite, GitButler and the AI reviewers (Greptile, CodeRabbit, Copilot code review) on a task grid: time-to-first-comment, big-PR navigation, AI signal/noise. Deliverable: a target-UX spec that drives the rest
- **Performance rebuild** — per-file lazy diff loading + hunk virtualization; slim down the 6-call detail revalidation
- **Review flow** — viewed-file state (with `SubmitReviewOptions` extension), `J`/`K` hunk navigation + keyboard-first actions, pending-review state surfaced (badge + resume), dismiss review, request-reviewers workflow
- **AI pre-review pass** — Greptile-style multi-hop, computed in background on PR open: diff → touched dependencies (import parser from `@gitwand/core`) → blame/history of changed lines → line-level findings **with confidence scores** and a user threshold. Local-first via `useAIProvider` (CLI agents), opt-in, cached SWR-style
- **PR summary** — what changed / why / affected areas at the top of the Info tab; reused as review handoff
- **Unified Intelligence pipeline** — merge the scattered AI pieces (hunk critique, Intelligence-tab static flags, pre-review findings) into one pipeline with shared cache and one settings surface
- **Multi-forge reviews** — complete the GitLab review methods (largest stub gap); Bitbucket/Azure follow

---

### v3.5.0 — Commit Review: micro AI reviews in the Changes panel

_Inspired by [git-lrc](https://github.com/HexmosTech/git-lrc) (HexmosTech). Commit-time is the review sweet spot: early enough to catch AI-generated regressions before they enter history, dependable because everyone commits. git-lrc does it with a cloud service + a browser detour — we do it in-panel, fully local._

**Today's baseline** — the Changes section (`RepoSidebar.vue`) + `DiffViewer.vue` render the staged diff read-only; per-hunk AI critique exists but is PR-only (`usePrHunkCritique.ts`); commit trailers ship since v1.9.0 (`useCommitMessage.ts`); CLI agents are launchable in-app (Agent Sessions v2.8.0, terminal + AI-task scratch worktrees v3.2.0).

- **Review staged changes** — one button in the commit area: AI pass over the staged diff, inline findings with severity badges anchored in the diff + a short summary. Generalize `usePrHunkCritique` from PR hunks to any `GitDiff` — the same engine as the v3.4.0 pre-review pass, pointed at the index
- **Issue navigation** — cycle finding-to-finding (reuses the v3.4.0 keyboard model), per-file finding counts in the staged list
- **Fix with agent** — git-lrc makes you copy-paste issues back to your agent; we pipe them: "Fix with agent" sends the findings to Claude Code / opencode / Codex (Agent Sessions), optionally in an AI-task scratch worktree; re-review triggers on the next staging change
- **Iterations & coverage** — track review→fix→review cycles and the share of the final staged diff already reviewed (`iter:N`, `coverage:X%`)
- **Review / Vouch / Skip** — explicit three-state decision at commit time, non-blocking (same UX contract as the v3.3.0 secrets scanner): reviewed by AI, vouched personally, or skipped — recorded as a commit trailer `GitWand-Review: ran|vouched|skipped (iter:N, coverage:X%)` via the existing trailers support (v1.9.0), so the team sees review status right in `git log`
- **Opt-in & scoped** — per-repo enable in `.gitwandrc` + Settings; optional pre-commit hook wiring via Settings > Hooks alongside the v3.3.0 scanner

---

### v3.6.0 — Time Machine: repo snapshots & global undo

_Inspired by GitUp's snapshot history. Extends the Undo stack (v1.2.0) from "undo the last ref move" into a true safety net covering the working tree and the resolution engine._

**Today's baseline** — `useUndoStack.ts` is reflog-based (50 entries), covers commit / amend / merge / cherry-pick / rebase / pull. Gaps: the working tree is never snapshotted, reset / checkout / discard are not undoable, and an auto-applied resolution has no rollback.

- **Working-tree snapshots** — before every destructive op (reset, checkout with changes, discard, bulk resolution apply), capture an unreferenced snapshot commit (`git stash create`-style, no stash-list pollution); referenced from a local snapshot journal
- **Undo auto-resolutions** — every resolution applied by the engine (incl. "Accept all" bulk from v2.22.0) becomes an undoable snapshot — one-gesture rollback of a bad auto-merge
- **Global `⌘Z`** — extend the existing undo stack to reset / checkout / discard; redo via `⇧⌘Z`
- **Time Machine panel** — chronological timeline of all repo operations (not just commits), one-click restore to any point
- **Retention policy** — snapshot GC (age + count caps), zero impact on `git log` / push
- **Optional AI labels** — one-line snapshot summaries in the timeline via `useAIProvider` (same pattern as Quick Stash labels, v2.15.1)

---

### v3.7.0 — Live Repo: filesystem events + libgit2 phase 1

_Inspired by GitUp's Live Map. Replace the 2s status poll with real FS events, and start the shell-out → libgit2 migration on the cheap-refresh path._

**Today's baseline** — `useRepoPoller.ts` polls every 2s (visibility-gated); no file watcher (`notify` crate absent). Backend: ~150 `git_cmd()` shell-outs vs 4 libgit2 fast-paths (`git/libgit2.rs`); `git_status` already has a libgit2 fast-path with CLI fallback.

- **FS watcher** — `notify` crate on `.git/` + working tree, debounced/coalesced Tauri events; Git Tree, status and sidebar refresh in real time, including changes made outside the app
- **Polling demotion** — the 2s poll becomes a low-frequency fallback (watcher failure, network mounts); consistent with the polling-discipline rule (no unconditional intervals)
- **libgit2 phase 1: `git_diff` + `git_blame`** — migrate the two read paths with the best effort/risk ratio (per backend audit); CLI fallback kept, covered by the parity harness (`tests/parity/`)
- **Event-driven invalidation** — post-command manual refreshes replaced by watcher events (single code path)
- **Indexing hook** — the watcher API is designed with a second consumer in mind: incremental update of the v4.0 code graph (re-index only the changed files, Greptile-style hot index, fully local)

---

### v3.8.0 — Merge preview-to-apply + editable diff

_Inspired by Aurees. Close the loop between the Conflict Predictor (v2.20.0) and execution, and make the diff a place you can fix things._

**Today's baseline** — `preview_merge` / `preview_rebase` / `preview_cherry_pick` + `useMergePreview.ts` already compute per-hunk auto-resolvability side-effect-free, but the preview is display-only: the user then merges blind or detours via scratch worktree. `DiffViewer.vue` is read-only; `MergeEditor.vue` edits via a bare textarea. CodeMirror 6 ships in-app since v3.2.0 (File Explorer/Editor).

- **Apply from preview** — "Apply N auto-resolutions & merge" straight from `MergePreviewPanel`: run the operation, apply the engine's resolutions, stop only on the residual manual hunks
- **Hunk-level opt-out + confidence threshold** — untick individual auto-resolutions, or set a global bar ("apply only ≥ 90% confidence") surfacing the engine's per-hunk confidence (audit-trail preserved, cf. v2.5.0)
- **History-aware LLM fallback** — enrich `llm_proposed` prompts with the blame/history of the conflicting lines (Greptile-style multi-hop context, computed locally)
- **Editable diff** — inline editing in the diff view (CodeMirror 6, reusing the v3.2 editor setup): fix a typo or resolve a trivial conflict where you see it, without switching to the merge editor
- **MergeEditor upgrade** — replace the textarea with the same CodeMirror 6 component (syntax highlighting, line numbers already themed)
- **libgit2 phase 2: stage/unstage** — index-level `git2` staging (hot UI path), parity-tested, CLI fallback

---

### v3.9.0 — Stacked Branches (native)

_A differentiating feature: stacked PRs workflow without an external CLI (Graphite, ghstack…). Sequenced after v3.8.0 on purpose: Restack leans on the conflict preview → apply flow._

The paradigm: short stacked branches (`feat/step-1` → `feat/step-2` → `feat/step-3`), each with its own PR targeting the previous one.

**Visualization** — The DAG automatically identifies stacks; a "Stack" banner in the sidebar; a "Stacks" tab in Today

**Creation** — "Stack a branch" button in the context menu; `⌘⇧S` shortcut from the commit area

**Restack** — Automatic detection when the base has moved; one-click "Restack" button (cascading `git rebase --onto`); conflict preview before execution (v3.8.0 preview-to-apply)

**PRs** — "Submit stack": creates or updates GitHub PRs for each layer; automatic retarget when a layer is merged

**Implementation** — Metadata in `.gitwand-workspace.json`; no external CLI dependency

---

### v3.10.0 — Combined Diffs (multi-commit, non-contiguous)

_Inspired by GitBlade. A comparison primitive we lack: one aggregated diff across several commits, even non-consecutive — review scattered work as a single change._

**Today's baseline** — `getGitFileDiff(from, to)` and `folderDiff(refA, refB)` compare exactly two points; `CommitGraph.vue` is single-select; file history / split commit / fork point don't cover "these 3 commits together".

- **Multi-select in the Git Tree** — `⌘`-click / `⇧`-click commit selection, selection chip ("3 commits selected → Combined diff")
- **`combined_diff` Tauri command** — Rust-side aggregation of the selected commits' patches into one virtual diff (per-file hunk merge, conflict-free since same-history)
- **Combined viewer** — standard DiffViewer rendering + per-hunk commit attribution (gutter badge → jump to commit)
- **Entry points** — Git Tree context menu, file history ("combine these versions"), PR review (subset of commits)
- **Optional AI summary** — "what these N commits do together" (what/why/affected areas) via `useAIProvider`, reusing the v3.4.0 PR-summary prompt

---

### v3.11.0 — Voice Input (experimental)

- **Local dictation**: microphone button in the commit panel — transcription via embedded Whisper (`whisper-rs` Rust) — zero cloud
- **Optional AI enrichment**: pass dictated text through `useAIProvider` for conventional commit formatting
- **Models**: `tiny` or `base` downloaded on demand, stored locally
- **Multilingual**: Whisper auto-detects the language
- **Graceful fallback**: clear message if microphone access is denied by macOS TCC

---

### v4.0.0 (candidate) — Blast Radius: code-graph impact before merge

_Inspired by Snipara's project-intelligence layer. Before a merge/rebase, answer: "what does this operation risk breaking?" — the natural extension of Conflict Predictor + `postMergeRisk` (v2.4.1), and a headline differentiator._

**Today's baseline** — `packages/core` already embeds tree-sitter (TS/JS/Python/Go/Rust WASM grammars), an ES/CJS import parser (`resolvers/imports.ts`) and parse-tree validation (`validate-parse-tree.ts`), but no dependency graph, caller discovery, or test mapping.

- **Import graph** — `packages/core/src/codeanalysis/`: tree-sitter queries build the module adjacency graph (browser-safe, incremental, cached per repo)
- **Reverse dependencies** — for each file touched by the operation: who imports it, which exported symbols changed
- **Probable-test detection** — heuristic mapping (`*.test.*` / `*.spec.*` naming + import edges) → "these 12 tests likely cover the changed code"
- **Co-change analysis** — "these files historically change together" mined from local `git log` (zero cloud, cheap); a second impact signal complementing the static import graph, exactly the history hop Greptile does server-side
- **Blast Radius panel** — new tab in `MergePreviewPanel`: impacted files ranked, affected symbols, suggested test scope; feeds a `blastRadius` dimension alongside `postMergeRisk`
- **Review ordering** — blast radius reused in the PR review (v3.4.0): files ranked by impact, "start with these 2 files"
- **Feedback loop** — rejected impact predictions / auto-resolutions lower the pattern's confidence (extends `useResolutionMemory`), the local analog of Greptile v4's false-positive reduction
- **Agents too** — exposed via `@gitwand/mcp` (`gitwand_blast_radius`) and CLI, so AI agents can check impact before committing a resolution. Positioning: Greptile sells this as a paid API ("Genius API", $0.45/req) — ours is local, free, open source
- **Opt-in & lazy** — computed post-preview, never blocking the merge flow; enabled in Settings

---

### For reflection — competitive scan (GitUp · Aurees · Snipara)

_Veille du 2026-06-24 sur 6 clients/outils (Snipara, GitDriv, GitUp, GitX-dev, Aurees, GitBlade). **Mise à jour 2026-07-03** : les pistes à fort signal ont été promues en sections versionnées ci-dessus après audit du code — PR Review 2.0 (inspiration Greptile) → **v3.4.0**, Commit Review (inspiration git-lrc) → **v3.5.0**, Snapshots/undo global → **v3.6.0**, Live Map + libgit2 phase 1 → **v3.7.0**, diff éditable + merge preview-to-apply → **v3.8.0**, Combined Diffs → **v3.10.0**, Code Graph/blast radius → **v4.0.0 (candidate)**. Les pistes écartées (GitDriv = web drag-and-drop débutant, GitX-dev = fork quasi-défunt, GitBlade = parité, abandonné depuis 2019) n'apportent rien d'avancé._

**Reste en veille :**

- **`GitUpKit`** ([gitup.co](https://gitup.co/)) — leur SDK pour bâtir des clients Git, à étudier.
- **libgit2 phases 3-4** — migration `git_log`/`git_show` (revwalk, le vrai gros gain sur 40k commits — mais boucle de fetch d'objets à optimiser) puis `git_file_log` (`--follow`/rename tracking à réimplémenter). À planifier après validation des phases 1-2 (v3.7/v3.8). Alternative `gix` réévaluée à ce moment-là.
- **Verification Plans attachés aux handoffs** (Snipara) — chaque PR/changement porte ses checks à passer ; recoupe les CI annotations (v2.18.0).
- **Greptile ([greptile.com](https://www.greptile.com/))** — largement absorbé dans le plan (2026-07-02) : pre-review multi-hop + scores de confiance → **v3.4.0**, index à chaud → **v3.7.0**, contexte historique du LLM fallback → **v3.8.0**, code graph local + co-change + feedback loop → **v4.0.0**. Reste en veille : leur benchmark public de reviewers AI (à réutiliser pour le volet benchmark v3.4.0) et l'évolution de la Genius API.
- **git-lrc / LiveReview ([HexmosTech](https://github.com/HexmosTech/git-lrc))** — concept absorbé en **v3.5.0** (Commit Review). Reste en veille : leur offre équipe LiveReview (dashboards, politiques org, analytics de review) — si le trailer `GitWand-Review` prend, une agrégation cross-repo dans Today/Dashboard en serait l'équivalent local.

---

### Later (unscheduled)

- **In-app folder-browser + right-click "Scope here"** — follow-up to v2.21.0 Monorepo Scope: a recursive working-tree folder panel where right-clicking a folder scopes to it. Ad-hoc scoping already ships via the picker's "Custom folder…"; this in-tree gesture is deferred (the existing `FolderDiffTree` is a *diff* tree — the wrong substrate — and is unmounted).
- **Today Phase 3 — active mutations** — deferred remainder of the Today inbox (shipped v3.0.0): real nudge / auto-merge actions from the inbox, and a direct jump from "Resolve" into the conflict resolver (today routes to in-app PR review). Note: Phase 2's filter-chips + group-by model was superseded by the fixed-section inbox (see `useLaunchpadInbox.ts`).

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
| **v3.3.0** | **Blame gutter** in the File Explorer's CodeMirror editor — opt-in author/date gutter, deduped per commit run, hover tooltip · **Telemetry moved to Aptabase** — Umami Cloud was silently dropping every launch ping (non-browser User-Agent filtering); replaced with App-Key-authenticated Aptabase, including a self-hosted upstream crash fix (`tokio::spawn` → `tauri::async_runtime::spawn`) · Azure DevOps PR base-branch picker now lists server-side branches, not just local refs |
| **v3.2.0** | **Integrated terminal** (WebGL rendering, inline search, clickable links, typed tabs with unread dot, real PTY agent launch, "New AI task" scratch-worktree button) · **File Explorer / Editor panel** (gitignore-aware tree, CodeMirror 6 editor, lock/undo/save toolbar) · **Git Tree** (filter mode, branch/author quick-toggles, date-bucket separators, branch autocomplete + `#PR` search) · Per-project worktree submenu + AI-task worktree management · Submodule update checking/applying · Per-author line churn stats · Antigravity CLI provider · Rebase onto any ref + branch reset · Sidebar unified Changes section · Tauri 2.11 |
| **v3.1.0** | Customizable dock & startup view, PR create unpublished-branch warning, customizable release-note templates, anonymous GDPR-compliant launch ping, website screenshot slideshow & lightbox, pnpm 11.9.0 |
| **v3.0.0** | **Today** (triaged action inbox, urgency tiers, state-aware primary actions, Launchpad → Today rename) · **VS Code extension on the Marketplace** (esbuild bundle, `publish-vscode.yml` CI, 4 extension bug fixes, CLI validation surfacing) · **Dashboard** (contributor modal, activity tooltips, fortnight stats, Git-Tree commit navigation) · **Branches** (top-contributor avatars, pinned section, move uncommitted changes on switch, force-delete prompt) · Fullscreen markdown image viewer · Website hero toggle + clickable platform cards |
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
