# GitWand — Roadmap

> Full release details: [CHANGELOG.md](./CHANGELOG.md)

---

## What's Next

_Ordered by priority, last verified 2026-08-24 (current after v3.8.0 shipped Time Machine, which laid the safety net the auto-apply work needed). The thread: make the app reactive and fast (v3.9), close the resolution loop (v3.10), then workflow & comparison primitives (v3.11–v3.12), experimental voice input (v3.13), and the v4.0 code-intelligence headline. Full renumbering history: `git log -p -- roadmap.md`._

| Version | Codename | Why now |
|---------|----------|---------|
| **v3.9.0** | Live Repo | Reactive & fast — FS events replace polling, libgit2 phase 1 |
| **v3.10.0** | Merge preview-to-apply | Close the resolution loop — apply straight from preview, editable diff |
| **v3.11.0** | Stacked Branches | Native stacked PRs, sequenced after v3.10 (leans on preview→apply) |
| **v3.12.0** | Combined Diffs | Multi-commit, non-contiguous aggregated diff |
| **v3.13.0** | Voice Input | Experimental — local dictation via embedded Whisper |
| **v4.0.0** (candidate) | Blast Radius | Code-graph impact before merge — the code-intelligence headline |

### v3.9.0 — Live Repo: filesystem events + libgit2 phase 1

_Inspired by GitUp's Live Map. Replace the 2s status poll with real FS events, and start the shell-out → libgit2 migration on the cheap-refresh path._

**Today's baseline** — `useRepoPoller.ts` polls every 2s (visibility-gated); no file watcher (`notify` crate absent). Backend: ~150 `git_cmd()` shell-outs vs 4 libgit2 fast-paths (`git/libgit2.rs`); `git_status` already has a libgit2 fast-path with CLI fallback. Frontend: `packages/core` diff/parse still runs synchronously on the main thread — no Web Worker, no `comlink` (orphaned §5.2 lever from `PERFORMANCE_PLAN.md`, never picked up by a shipped version).

- **FS watcher** — `notify` crate on `.git/` + working tree, debounced/coalesced Tauri events; Git Tree, status and sidebar refresh in real time, including changes made outside the app
- **Polling demotion** — the 2s poll becomes a low-frequency fallback (watcher failure, network mounts); consistent with the polling-discipline rule (no unconditional intervals)
- **libgit2 phase 1: `git_diff` + `git_blame`** — migrate the two read paths with the best effort/risk ratio (per backend audit); CLI fallback kept, covered by the parity harness (`tests/parity/`); phases 3-4 (`git_log`/`git_show` revwalk, `git_file_log` rename tracking — the real 40k-commit win) evaluated once this lands, see the veille note below
- **Web Worker for diff/parse** — move `packages/core`'s diff/parse hot path off the main thread via `comlink`, browser-safe like the rest of the package; lands here because it's on the same hot path as the FS-watcher refresh and the libgit2 migration above, and because the CPU load on that path is only going up — `token_level_merge` (already shipped, v3.4.0), Combined Diffs multi-commit aggregation (v3.12.0) and the v4.0 tree-sitter code graph all add main-thread work to it
- **Channels for progress streaming** — migrate `clone`/`fetch` progress off the global `app_handle.emit("clone-progress", …)` broadcast (v2.11.0) onto a scoped `tauri::ipc::Channel<T>` per invoke, the pattern already proven by the terminal's PTY output (v3.2.0); closes the other orphaned lever from `PERFORMANCE_PLAN.md` (§5.4)
- **Event-driven invalidation** — post-command manual refreshes replaced by watcher events (single code path)
- **Today Phase 3 — active mutations** — deferred remainder of the Today inbox (v3.0.0): real nudge / auto-merge actions from the inbox cards, and a direct jump from "Resolve" into the conflict resolver (today routes to in-app PR review); leans on v3.8's undo safety net, since an inbox "auto-merge" nudge is itself the "more auto-apply" that v3.8 exists to make safe, and on this version's event-driven refresh so an action's result is reflected instantly instead of on the next poll
- **Dock PR-count staleness indicator** — the app-dock "prs" badge (PR #125) currently refreshes only on repo-open and manual refresh; watcher-driven refresh finally gives it an always-fresh count without reopening the v2.8.5 boot-perf risk that ruled out periodic polling
- **Indexing hook** — the watcher API is designed with a second consumer in mind: incremental update of the v4.0 code graph (re-index only the changed files, Greptile-style hot index, fully local); this is also the first real consumer that will lean on the Worker above once tree-sitter parsing moves off the main thread

---

### v3.10.0 — Merge preview-to-apply + editable diff

_Inspired by Aurees. Close the loop between the Conflict Predictor (v2.20.0) and execution, and make the diff a place you can fix things._

**Today's baseline** — `preview_merge` / `preview_rebase` / `preview_cherry_pick` + `useMergePreview.ts` already compute per-hunk auto-resolvability side-effect-free, but the preview is display-only: the user then merges blind or detours via scratch worktree. `DiffViewer.vue` is read-only; `MergeEditor.vue` edits via a bare textarea. CodeMirror 6 ships in-app since v3.2.0 (File Explorer/Editor).

- **Apply from preview** — "Apply N auto-resolutions & merge" straight from `MergePreviewPanel`: run the operation, apply the engine's resolutions, stop only on the residual manual hunks
- **Hunk-level opt-out + confidence threshold** — untick individual auto-resolutions, or set a global bar ("apply only ≥ 90% confidence") surfacing the engine's per-hunk confidence (audit-trail preserved, cf. v2.5.0)
- **History-aware LLM fallback** — enrich `llm_proposed` prompts with the blame/history of the conflicting lines (Greptile-style multi-hop context, computed locally)
- **Editable diff** — inline editing in the diff view (CodeMirror 6, reusing the v3.2 editor setup): fix a typo or resolve a trivial conflict where you see it, without switching to the merge editor
- **MergeEditor upgrade** — replace the textarea with the same CodeMirror 6 component (syntax highlighting, line numbers already themed); while in this code, re-surface the "Split this commit…" / edit affordance after a mid-rebase conflict handoff (#128 follow-up) — today only Continue/Skip/Abort survive once `RebaseEditor` unmounts for the conflict banner
- **Finder-like folder navigation** — a real working-tree folder tree (tree left, inline diff right, keyboard-operable, per-file status badges), reusing this version's CodeMirror integration; the `FolderDiffTree` inherited from v2.21.0 Monorepo Scope is diff-only and the wrong substrate, so this finally lands right-click "Scope here" on real ground, and gives macOS users a Finder-like mode to counter RelaGit/Strand's more rigid UIs
- **libgit2 phase 2: stage/unstage** — index-level `git2` staging (hot UI path), parity-tested, CLI fallback

---

### v3.11.0 — Stacked Branches (native)

_A differentiating feature: stacked PRs workflow without an external CLI (Graphite, ghstack…). Sequenced after v3.10.0 on purpose: Restack leans on the conflict preview → apply flow._

The paradigm: short stacked branches (`feat/step-1` → `feat/step-2` → `feat/step-3`), each with its own PR targeting the previous one.

**Visualization** — The DAG automatically identifies stacks; a "Stack" banner in the sidebar; a "Stacks" tab in Today

**Creation** — "Stack a branch" button in the context menu; `⌘⇧S` shortcut from the commit area

**Restack** — Automatic detection when the base has moved; one-click "Restack" button (cascading `git rebase --onto`); conflict preview before execution (v3.10.0 preview-to-apply)

**PRs** — "Submit stack": creates or updates GitHub PRs for each layer; automatic retarget when a layer is merged

**Implementation** — Metadata in `.gitwand-workspace.json`; no external CLI dependency. Cascading Restack and per-layer Submit-stack progress stream via `tauri::ipc::Channel` (v3.9.0 pattern) rather than a new global `emit()` broadcast

---

### v3.12.0 — Combined Diffs (multi-commit, non-contiguous)

_Inspired by GitBlade. A comparison primitive we lack: one aggregated diff across several commits, even non-consecutive — review scattered work as a single change._

**Today's baseline** — `getGitFileDiff(from, to)` and `folderDiff(refA, refB)` compare exactly two points; `CommitGraph.vue` is single-select; file history / split commit / fork point don't cover "these 3 commits together".

- **Multi-select in the Git Tree** — `⌘`-click / `⇧`-click commit selection, selection chip ("3 commits selected → Combined diff")
- **`combined_diff` Tauri command** — Rust-side aggregation of the selected commits' patches into one virtual diff (per-file hunk merge, conflict-free since same-history)
- **Combined viewer** — standard DiffViewer rendering + per-hunk commit attribution (gutter badge → jump to commit)
- **Entry points** — Git Tree context menu, file history ("combine these versions"), PR review (subset of commits)
- **Optional AI summary** — "what these N commits do together" (what/why/affected areas) via `useAIProvider`, reusing the v3.5.0 PR-summary prompt

---

### v3.13.0 — Voice Input (experimental)

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
- **Review ordering** — blast radius reused in the PR review (v3.5.0): files ranked by impact, "start with these 2 files"
- **Feedback loop** — rejected impact predictions / auto-resolutions lower the pattern's confidence (extends `useResolutionMemory`), the local analog of Greptile v4's false-positive reduction
- **Agents too** — exposed via `@gitwand/mcp` (`gitwand_blast_radius`) and CLI, so AI agents can check impact before committing a resolution. Positioning: Greptile sells this as a paid API ("Genius API", $0.45/req) — ours is local, free, open source
- **Opt-in & lazy** — computed post-preview, never blocking the merge flow; enabled in Settings

---

### For reflection — competitive scan (GitUp · Aurees · Snipara · Strand · GitComet · RelaGit)

_Competitive scan from 2026-06-24 across 6 clients/tools (Snipara, GitDriv, GitUp, GitX-dev, Aurees, GitBlade), updated 2026-07-20. High-signal leads were promoted into the versioned sections above after a code audit — PR Review 2.0 (inspired by Greptile) → **v3.5.0 (shipped)**, Commit Review (inspired by git-lrc) → **v3.7.0 (shipped)**, global snapshots/undo → **v3.8.0**, Live Map + libgit2 phase 1 → **v3.9.0**, editable diff + merge preview-to-apply → **v3.10.0**, Combined Diffs → **v3.12.0**, code graph/blast radius → **v4.0.0 (candidate)**. Discarded leads (GitDriv = beginner web drag-and-drop, GitX-dev = near-dead fork, GitBlade = parity only, abandoned since 2019) bring nothing advanced._

**2026-07-09 scan** — three serious new competitors (all post-dating v2.15.0), now folded into the [Competitive landscape](#competitive-landscape) table above: **Strand** ([strand/0.5.0](https://github.com/danielss-dev/strand), agent workspaces via worktrees), **GitComet** ([gitcomet/0.1.15](https://github.com/Auto-Explore/GitComet), pure Rust+GPUI perf), **RelaGit** ([relagit/0.16](https://github.com/relagit/relagit), design/SolidJS).

_Synthesis: none of the three addresses structured conflict-resolution AI (Strand = agent workspaces, GitComet = perf, RelaGit = design) — GitWand's moat (auto-resolve + multi-repo Launchpad + extensible CLI/MCP) stays intact. Worth cultivating: the v3.8–v3.10 pipeline (preview-to-apply) + v4.0 code graph to widen the gap. Worth borrowing from their respective strengths: published a11y/perf baselines (Strand, → v3.9 benchmark pass), SolidJS vs Vue 3 benchmark on heavy diffs (RelaGit, → v3.9 perf pass)._

**Still watching:**

- **`GitUpKit`** ([gitup.co](https://gitup.co/)) — their SDK for building Git clients, worth studying.
- **libgit2 phases 3-4** — migrate `git_log`/`git_show` (revwalk, the real win on 40k commits — but the object-fetch loop needs optimizing first) then `git_file_log` (`--follow`/rename tracking to reimplement). To schedule once phases 1-2 (v3.9/v3.10) are validated. `gix` as an alternative to be re-evaluated at that point.
- **Verification Plans attached to handoffs** (Snipara) — every PR/change carries the checks it must pass; overlaps with the CI annotations (v2.18.0).
- **Greptile ([greptile.com](https://www.greptile.com/))** — largely absorbed into the plan (2026-07-02): multi-hop pre-review + confidence scores → **v3.5.0 (shipped)**, hot index → **v3.9.0**, LLM-fallback historical context → **v3.10.0**, local code graph + co-change + feedback loop → **v4.0.0**. Still watching: their public AI-reviewer benchmark (reusable for the v3.5.0 benchmark work) and how the Genius API evolves.
- **git-lrc / LiveReview ([HexmosTech](https://github.com/HexmosTech/git-lrc))** — concept absorbed in **v3.7.0** (Commit Review). Still watching: their LiveReview team offering (dashboards, org policies, review analytics) — if the `GitWand-Review` trailer catches on, a cross-repo rollup in Today/Dashboard would be the local equivalent.
- **FinderGit** — UX worth borrowing (file-tree first), macOS-only today; the Finder-like sidebar concept has been promoted to **v3.10.0**. Cross-platform via Tauri is a structural advantage over FinderGit's solo-dev status.

---

### Later (unscheduled)

- **Snapshot rebase/cherry-pick state** — v3.8 restores `MERGE_HEAD` but not `.git/rebase-merge/` or `.git/sequencer/`, so restoring a snapshot taken mid-rebase or mid-cherry-pick brings the files and index stages back without the in-progress sequence. Restoring those is a directory copy rather than a plumbing call, which is why it was left out of the first pass. Revisit if users report rewinding mid-rebase.
- **Snapshot cost on very large working trees** — each snapshot runs `git add -A` into a scratch index, which is O(worktree) on a cold cache. Fine on normal repos, unmeasured on a 100k-file monorepo. Benchmark alongside the v3.9 FS-watcher work, where the same walk gains a second consumer.
- **Snapshot refs are visible to a bare `git log --all`** — GitWand excludes them from every traversal it runs, but any ref under `refs/` is by definition part of `--all`, so a user typing it in a terminal sees snapshot commits, exactly as they see `refs/stash`. Nothing to fix short of abandoning refs entirely (which would let `gc` eat the snapshots); documented here so it is a known property rather than a surprise.

- **Multi-forge PR-freshness signal parity** — follow-up to the branch-badge background-prefetch/cache work (PR #125): GitLab/Bitbucket/Azure already get the breadth fix (background drain past the first page), but not the cheap freshness-signal instant-cache-restore fast path — GitHub-only today, since the other three don't yet have an equivalent cheap "most-recently-updated PR" query built. Deferred until there's real non-GitHub usage pressure.
- **Cursor-based PR-list pagination (Rust)** — already flagged in-code as Phase 2/v2.9 (`gh_list_prs_inner`/`rest_list_prs` comments, predates PR #125): replace the naive offset+limit re-fetch, which re-walks from the start on every page, with a cursor-based `gh api graphql` query. Removes the quadratic re-fetch cost for repos with very large open-PR counts; most repos stay well under the current 300-PR prefetch ceiling, so this is scalability hardening, not an urgent fix.
- **Commit Review "Fix with agent" in a scratch worktree** — follow-up to v3.7.0: the originally-planned "optionally in an AI-task scratch worktree" variant was cut after manual QA against real `claude`/`codex` CLIs found a brand-new scratch worktree always hits a first-run "trust this directory?" onboarding screen that misinterprets the piped prompt as menu navigation (drove a real `brew upgrade --cask codex` in testing). Revisit once there's a real fix — pre-trusting the directory before launching the agent, or detecting the onboarding screen before writing.
- **Decide the fate of the `explainOnly` option** (follow-up to the v3.7.2 predictor fix): it short-circuits `resolveHunk()` before the format-aware dispatch and the confidence gate, so any caller that reads `stats.autoResolved` after using it gets a structural `0`. That is exactly how `gitwand preview` and two MCP tools shipped broken. After the fix the option has zero consumers in the monorepo while staying part of the public `GitWandOptions` contract, so it is now a footgun with no user. Either remove it (breaking change for external consumers, if any) or redefine it as "classify and resolve, but do not assemble merged content", which is what every call site actually wanted.
- **Commit Review coverage on a content-only restage** — v3.7.0's staged-set watcher fingerprints staged file paths + statuses, not content, so editing an already-staged file's content without changing which files are staged doesn't retrigger a coverage/finding recompute automatically (the pre-commit gate still recomputes coverage honestly right before the trailer is written, so the record itself stays accurate — this is a UI-staleness gap between review passes, not a data-integrity one).

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
| **Strand** | Tauri 2 + React | Free/OSS | Agent-native worktree sessions (parallel agent workspaces), full worktree lifecycle (merge+archive+recovery), WCAG 2.1 a11y, published perf baselines | No conflict AI, mono-repo only, no Launchpad equivalent |
| **GitComet** | Rust + GPUI | Free/OSS | Zed-level responsiveness, dual GUI+headless (difftool/mergetool), Linux-first, documented perf on Chromium-scale repos | No AI, no worktrees, no multi-repo, no conflict resolution (strategy algo only) |
| **RelaGit** | Electron + SolidJS | Free/OSS | Fine-grained reactivity (SolidJS), native AI SDK (`@ai-sdk/anthropic`) for commit suggestions, community theme ecosystem, popout windows | Electron (heavy), fragile beta, no worktree/launchpad, no structured conflict AI |

---

## Shipped

> Full change details per version: [CHANGELOG.md](./CHANGELOG.md)

| Version | Highlights |
|---------|-----------|
| **v3.8.0** | **Time Machine** — repo snapshots & global undo. Every destructive operation (discard, reset, checkout, branch switch, bulk resolution apply) first captures a restorable snapshot of the working tree (untracked included), the index and conflict stages 1/2/3, written with git plumbing under `refs/gitwand/snapshots/` and restored via `read-tree` so it never refuses on a dirty tree · **undo offered where the action happened** — a single-slot toast with an Undo button and a `⌘Z` hint, since a discard previously gave no feedback at all · **global `⌘Z` / `⇧⌘Z`** now rewind and replay repo operations, reporting through that same toast · the existing rewind popover (`⌘⇧U`) **lists snapshots merged with git's reflog** instead of the reflog alone, with a full-history modal behind its footer link; restoring is itself undoable via a `pre-restore` snapshot · retention settings (age + count caps, pruned on repo open) and opt-in AI snapshot labels · snapshot refs excluded from every `--all` traversal, and every ref move a restore makes carries an explicit reflog message |
| **v3.7.0** | **Commit Review** — micro AI reviews in the Changes panel (inspiration [git-lrc](https://github.com/HexmosTech/git-lrc), fully local instead of a cloud+browser detour). "Review staged changes" runs the pre-review engine against the staged diff (inline findings, severity badges, `n`/`p`/`x` navigation) · **Fix with agent** pipes findings into a terminal AI agent session against the current repo (the scratch-worktree variant was cut after manual QA found it could hit a CLI's first-run "trust this directory?" screen and misfire a real command — tracked as a follow-up) · **Iterations & coverage** tracking bound to HEAD · **Review / Vouch / Skip** commit-time decision recorded as a `GitWand-Review:` trailer · per-repo **`.gitwandrc` opt-in** overriding the app Setting in either direction · a composable **pre-commit hook** merging the shipped v3.5.0 secrets section with a new warn-only review reminder · a real focus trap added to `BaseModal`, fixing a foundational a11y gap inherited by every modal in the app · fixed a core reactivity bug where routine background polling silently wiped findings, plus a dozen smaller findings from a dedicated product/code review round |
| **v3.6.6** | **Dev loop & CI build times** (pure tooling/perf chore, no product surface) — `ci.yml`'s 3-bundle-per-push `desktop` job replaced by a fast `rust-check` (fmt/clippy/check/test, now on PRs too) + a path-filtered `bundle-smoke` job (~230 billed CI min saved/push); Rust cache across all 3 workflows; `[profile.ci]`/`[profile.dev]` cut a post-edit `cargo build` from ~21s to ~6.5s; measured `cargo llvm-lines`/`--timings` to rule out the previously-planned `gitwand-git` crate split; Vitest defaults to `environment: "node"` instead of global `jsdom` (setup time ~96s→~17s); secrets-scanner ignore-regex precompiled (~24x Rust/~2.5x TS); `@gitwand/core`'s resolution engine lazy-loaded out of the boot chunk (main bundle −185 KB raw); deduped `reqwest` (dropped `native-tls`/`openssl-sys`, removed `libssl-dev` from CI); anonymous telemetry gated behind an explicit `telemetry` Cargo feature with a build-time guard against a telemetry-less release |
| **v3.6.0** | Post-checkout **"Update branch" prompt** — one-click fast-forward (with stash/restore) or "Continue on local branch" when checking out a branch that's behind its upstream with no divergent commits, per-branch mute · **Non-blocking rebase-conflict handoff** (#128) — an interactive rebase conflict now closes the blocking `RebaseEditor` modal and hands off to the existing rebase banner + inline `MergeEditor` instead of trapping resolution behind an overlay; also fixes a UI freeze on very long/minified conflicting lines (word-diff now guards against pathological line lengths) · **CommitGraph animation polish** (#127) — no more layout shifts/flicker during pagination loading |
| **v3.5.0** | **PR Review 2.0** — GitHub-standard keymap (`J`/`K`/`⇧J`/`⇧K`/`V`/`⇧V`/`T`/`C`/`N`/`P`/`⌘Enter`), viewed-file tracking, pending-review persistence, dismiss review/request reviewers, local opt-in AI pre-review pipeline (multi-hop, confidence-scored findings), PR summary block, unified `LineAnnotation` gutter model, GitLab review completion, lazy per-file diff loading + virtualized rendering (PR detail hot path 6→3 forge calls) · **Pre-commit secrets scanner** — zero-network local scanner (AWS/GCP/Azure/GitHub/GitLab/Slack/Stripe/OpenAI/Anthropic/RSA/JWT/high-entropy), non-blocking commit-area badge, `.gitwandrc` extensible patterns, dual Rust+TS implementation, CLI `gitwand scan`, opt-in pre-commit hook · **PR badges: background prefetch & cache** (git-log style) past the first page, plus a real open-PR count on the dock badge · Repo-tab reordering via pointer events (mouse/touch/pen) + keyboard a11y · File Explorer Save button moved next to the lock toggle |
| **v3.4.0** | **Conflict-engine bundle** — `token_level_merge` pattern (line/token decomposition, never auto-applied, user-confirmed via `TokenMergePanel`) · **2-way base recovery** from the git index (unlocks diff3-only patterns on default-conflictstyle repos, guarded against clobbering manual edits) · **`ResolutionPreviewPanel`** + per-hunk "Resolve auto" confirmation · **recoverable-before-model metric** (`summarizeTiers`, surfaced in CLI/desktop/MCP + local cumulative stats in Settings, backed by a corpus regression guard + golden-funnel CI gate) · `value_only_change` extended to diff3 with semver/timestamp-max resolution · deterministic recoverers forced before the LLM path · **data-loss fixes** (imports resolver emptying hunks, `insertion_at_boundary` dropping duplicate-line insertions, `whitespace_only` false positive in string literals, rename detection matching inside strings/comments) · git log pagination/caching fixes. Measured: manual residual halved on a 2000-merge production corpus (5.6%→2.7% of hunks) |
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
