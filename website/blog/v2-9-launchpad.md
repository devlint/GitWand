---
title: "Launchpad: GitWand's cross-repo dashboard"
description: "GitWand v2.9 introduces the Launchpad — a single full-screen view aggregating WIP, PRs, Issues, and Team activity across every repo in your workspace. Four tabs, pin and snooze, ⌘L from anywhere, lazy Team tab, and a design pass that finally aligns the whole panel with the rest of the app."
date: 2026-05-12
head:
  - - meta
    - property: og:title
      content: "Launchpad: GitWand's cross-repo dashboard"
  - - meta
    - property: og:description
      content: "Four tabs (WIP / PRs / Issues / Team) across every repo in your workspace, pin and snooze with localStorage persistence, ⌘L global shortcut, lazy Team tab to keep first open snappy. v2.9 release notes."
  - - meta
    - name: twitter:title
      content: "Launchpad: GitWand's cross-repo dashboard"
---

# Launchpad: GitWand's cross-repo dashboard

`@gitwand/desktop@2.9.0` ships the **Launchpad** — a single full-screen view that aggregates the four signals you actually care about when you juggle five, ten, or twenty repos: what you left uncommitted, which pull requests are waiting on you, which GitHub issues you own, and where your teammates' work is about to overlap with yours.

[Workspaces](/changelog#v2-7-0-may-2026) shipped in v2.7 solved the grouping problem — naming your set of repos, opening them in tabs, running `fetch all` and `pull all`. They did not solve the triage problem. Three weeks into using workspaces day-to-day, the question was no longer "which repos belong together?" but "where is my next PR review? what did I leave staged on the `dendreo` branch Friday afternoon? is anyone else editing the same files as me right now?". The Launchpad answers those four questions in a single view, from anywhere, with `⌘L`.

This post walks through the four tabs, the pin/snooze layer, the performance trade-off that put the Team tab behind a lazy load, and the design pass that finally aligned the panel with the rest of the app.

---

## Four tabs, four angles on the same workspace

The Launchpad opens as a centered card over a dimmed-and-blurred backdrop — same `BaseModal` pattern used by Stash, Tags, and the Rebase editor. Four tabs across the top, each pulling from a different angle of the active workspace.

### WIP — what did I leave on the table?

Every repo in the workspace that has uncommitted changes (staged, unstaged, or untracked) or a branch that's drifted from its upstream. Staged / unstaged / untracked counts, ahead/behind numbers, a "no-upstream" warning for the local-only branches, last commit timestamp.

Backed by the libgit2 fast-path `workspace_wip_all` that landed during the v2.8.2 performance hardening. The aggregate walks every repo's index and worktree in-process via `git2::Repository::open`, parallelised with `rayon::par_iter` — no fork-exec, no subprocess, no per-repo overhead. On a workspace of ten repos the tab fills in well under a second.

### PRs — what's waiting on me, on us?

Every open pull request across the workspace via `gh pr list`, with the v2.8.5 lightweight payload (twelve cheap fields, no `statusCheckRollup` expansion on the initial list). Each row renders a semantic status badge:

- **Approved** + CI Success → `--color-success-soft` / `--color-success`
- **Changes Requested** + CI Failure → `--color-danger-soft` / `--color-danger`
- **Review Required** + CI Pending → `--color-warning-soft` / `--color-warning`
- **Draft** → `--color-bg-tertiary` / `--color-text-muted`

A secondary chip row below the title shows up to three assignees (accent-soft background, accent text) and up to three review-requested users (warning-soft background, warning text), with a `+N` overflow when the count exceeds three. Two visually distinct chip families because they answer two distinct questions: "who owns this?" and "who has to look at this?".

### Issues — three filters that actually mean something

`gh issue list` aggregated across all repos with three filter modes:

- **Assigned to me** — issues where I'm in the `assignees` array
- **Mentioned** — issues where my login appears in the body or in any comment
- **Created by me** — issues I opened

Three filters and not one because the user intents are overlapping but distinct. *Assigned to me* is "what am I expected to ship?". *Mentioned* is "where does my opinion still need to land?" — code review threads on an issue, an architectural debate, a `@laurent please confirm`. *Created by me* is "did anything I opened get answered?" — useful for the bug reports you filed against upstream repos and forgot about. Milestone badges + labels round out each row.

### Team — see overlap before it becomes conflict

This is the tab that did not exist in any other Git client we surveyed. Colleagues' open PRs grouped by author, with **file-level overlap detection**: the intersection between *your* changed files (WIP staged + unstaged, falling back to your un-merged branch commits if WIP is empty) and the files touched by each colleague's PR.

The composable that drives it (`useLaunchpadTeam.ts`) is the most interesting piece of code in the release:

```ts
// 1. Identity (cached module-level — survives across refresh() calls)
if (!_currentUser) _currentUser = await ghCurrentUser();
const me = _currentUser;

// 2. Split workspace PRs into mine and colleagues'
const flat = (await workspacePrsAll(repos))
  .flatMap((r) => r.prs.map((pr) => ({ ...pr, repoName: r.repoName, repoPath: r.repoPath })));
const myPrs = flat.filter((pr) => pr.author === me);
const colleaguePrs = flat.filter((pr) => pr.author !== me);

// 3. My files: WIP first, branch commits fallback
let myFiles = (await workspaceWipAll(repos)).flatMap((w) => w.changedFiles);
if (myFiles.length === 0 && myPrs.length > 0) {
  const lists = await concurrentMap(myPrs, (pr) => ghPrFiles(pr.repoPath, pr.number), 5);
  myFiles = [...new Set(lists.flat())];
}

// 4. Colleague file lists with bounded concurrency
const colleagueFileLists = await concurrentMap(
  colleaguePrs,
  (pr) => ghPrFiles(pr.repoPath, pr.number).catch(() => []),
  5,
);

// 5. Overlap = intersection of my files and theirs
const myFileSet = new Set(myFiles);
// … build memberMap, attach overlappingPrs where overlap.length > 0 …
```

Two details matter. First, `concurrentMap(items, fn, 5)` runs at most five `gh pr view --json files` calls in flight at any time. Without that bound, a workspace with thirty colleague PRs would fan out thirty parallel GitHub API calls and trip the secondary rate limit on the first refresh. Five is empirically the highest stable number we found across the test workspaces (Dendreo's, mine, and a synthetic 50-PR fixture).

Second, the identity cache is module-level on purpose. `ghCurrentUser()` does `gh api user --jq .login` — cheap but not free, and the result never changes within a session. Caching it at the `useLaunchpadTeam.ts` module level means refreshing the tab six times in an afternoon still only calls `gh api user` once. Tests get a `_resetTeamForTesting()` exit to clear the cache between cases.

Members with overlap are auto-expanded at render time and ranked first; the rest sort alphabetically. Overlap PRs render with `--color-warning-soft` background, a warning border, and the conflicting file paths inline so you can stop scrolling and go talk to the person.

---

## Pin and snooze: personal triage

A workspace with fifty open PRs is unactionable noise. The Launchpad ships with a **pin/snooze** layer that lets you cut through it: pin the two or three things you actively own to the top of the list, snooze the ten things you'll deal with next week.

Both work the same way — a `⋮` menu in every PR and Issue row, two actions exposed (Pin / Unpin and Snooze with four presets: 1, 3, 7, or 14 days). The state lives in a module-singleton composable that persists to `localStorage` under `gitwand-launchpad-pins`:

```ts
// useLaunchpadPins.ts — abridged
export function useLaunchpadPins() {
  function pin(url: string, type: "pr" | "issue"): void {
    if (_pins.value.some((p) => p.url === url)) return;
    _pins.value = [..._pins.value, { url, type, pinnedAt: new Date().toISOString() }];
    persist();
  }

  function snooze(url: string, type: "pr" | "issue", days: 1 | 3 | 7 | 14): void {
    const snoozedUntil = new Date(Date.now() + days * 86_400_000).toISOString();
    _snoozes.value = _snoozes.value.filter((s) => s.url !== url);
    _snoozes.value = [..._snoozes.value, { url, type, snoozedUntil }];
    persist();
  }

  function isSnoozed(url: string): boolean {
    const s = _snoozes.value.find((s) => s.url === url);
    return !!s && new Date(s.snoozedUntil).getTime() > Date.now();
  }
}
```

Two design choices worth calling out.

**Snooze wins over pin.** A snoozed-and-pinned item stays hidden until the snooze expires, not the other way around. The user intent of "make this disappear for three days" is stronger than the user intent of "always keep this at the top". The pin reappears at the top of its list the moment the snooze elapses.

**Expired snoozes are lazily pruned.** Every call to `persist()` walks `_snoozes.value` and filters out the entries whose `snoozedUntil` is in the past. No background timer, no `setInterval` — the cleanup rides on the next write. If the user pins something three weeks later, the cleanup happens then; if they never come back, the data sits in `localStorage` doing no harm.

A dismissible bandeau above the list ("3 items snoozed") lets you peek at what's currently hidden and unsnooze any of them — useful when you snoozed something for "a week" and decided the next morning you actually need to look at it.

The composable ships with 8 unit tests covering the singleton, sort order, expiry semantics, and the localStorage round-trip.

---

## The performance trade-off: lazy Team tab

The Team tab does the most work. On a workspace with 50 colleague PRs, even with `concurrentMap(limit=5)`, the cumulative `gh pr view --json files` latency is around ten seconds — not in any individual call, but in the unavoidable end-to-end walk. Loading that eagerly on every Launchpad open made the first open feel sluggish.

The fix is the same pattern we used for `PullRequestPanel.vue` in [v2.8.5](/changelog#v2-8-5-may-2026): **don't fetch on mount, fetch on first interaction**. `refreshTeam(repos)` is no longer called from `LaunchpadView.vue#onMounted`. The three cheap tabs (WIP, PRs, Issues) still eager-load in parallel from mount, but the Team tab shows a placeholder card with a single "Load team activity" button until the user clicks it. Once fetched, the result caches and subsequent refreshes use the bandwidth budget knowingly.

For users on small teams (or solo) who don't need the tab at all, a new Settings toggle — **"Disable Launchpad Team tab"** — hides the tab entirely. The Launchpad becomes a three-tab panel with zero Team-tab cost.

A "Refresh all" button next to the per-tab refresh fans out `refreshWip` / `refreshPrs` / `refreshIssues` / `refreshTeam` via `Promise.all` when you explicitly want a fresh picture across the board. Combined loading state disables both refresh buttons during the run; a homogeneous SVG spinner shows centrally on first load (empty tab) and tucks into the top-right corner on subsequent refreshes (data already on screen).

---

## ⌘L from anywhere

Opening a feature this central through a "Launchpad" button buried in the Workspace panel was the v2.9 first-pass UX, and it was wrong. The Launchpad is workspace-wide context — it deserves a keyboard shortcut.

`⌘L` on macOS, `Ctrl+L` on Linux/Windows. Wired through the native menu bar (**View > Open Launchpad**) and the standard `provide` / `inject` pattern that the rest of the app uses for menu-driven actions:

```ts
// App.vue
const launchpadOpenRequest = ref(0);
provide(LAUNCHPAD_OPEN_REQUEST_KEY, launchpadOpenRequest);

watch(launchpadOpenRequest, () => {
  if (!activeWorkspace.value) {
    toast.warn(t("launchpad.requiresWorkspace"));
    openWorkspacePanel();
    return;
  }
  openLaunchpad(activeWorkspace.value.repos);
});
```

The gating matters: the Launchpad needs a workspace to aggregate across. If you hit `⌘L` without one defined, you don't get a broken empty panel — you get a toast warning and the Workspace panel opens so you can define one in two clicks.

The active tab also persists between opens. `launchpadActiveTab: "wip" | "prs" | "issues" | "team"` joined `AppSettings` and is read back on every open. If your last session ended on Team, that's where the next one starts — and if the persisted tab is Team, the lazy fetch fires on mount instead of waiting for a click (because the user's intent is clear).

---

## Design pass: tokens, modal frame, SVG icons

The Launchpad code had been growing in branches across several previous releases. The first cut shipped working but visibly inconsistent with the rest of the app — hardcoded hex fallbacks (`#3182ce`, `#718096`, `#e53e3e`), references to **non-existent CSS tokens** (`--color-surface-raised`, `--color-surface`) that silently fell through to white in dark mode, twelve emoji glyphs in the template where the rest of the app uses inline SVG.

The v2.9 release wrap included a focused design pass on `LaunchpadView.vue`'s style block. Template and script were left intact so the 95 tests stayed green; only the CSS changed.

**Tokens.** Every colour now resolves through the canonical tokens in `assets/main.css`: `--color-bg{,-secondary,-tertiary}`, `--color-text{,-muted,-subtle}`, `--color-border{,-strong}`, `--color-accent{,-hover,-soft,-text}`, `--color-{success,warning,danger,info}{,-soft}`, `--color-focus-ring`. Every spacing literal converted to `var(--space-N)` (4 px base). Every `border-radius` to `var(--radius-{xs,sm,md,lg,pill})`. Every font size to `var(--font-size-{xs,sm,base,md,lg,xl})`. Dark mode parity is now first-class instead of an afterthought.

**Modal frame.** The Launchpad used to fill the viewport edge-to-edge — opaque, full-screen, hiding the app entirely. It now renders as a centered card with 2 rem inset on every side, over a dimmed-and-blurred backdrop (`var(--color-overlay)` + `backdrop-filter: blur(4px)`), `--radius-2xl` rounded corners, `--shadow-xl` elevation, and a subtle `scale(0.985) → scale(1)` slide-in. The blurred view of the app behind keeps spatial context — you remember which repo you came from, where the menu is.

**Icons.** All 12 emoji glyphs replaced with 14 px inline SVG. Pin and snooze in the `⋮` menu, the snoozed-bandeau icon, the overlap warning marker — every glyph now matches the rest of the app's icon vocabulary. Each menu item uses `display: flex; align-items: center; gap: var(--space-2)` to align icon and label cleanly.

The style block grew from 674 to 962 lines. None of the added volume is duplication — it's hover, focus-visible, and transition declarations that the first pass had skipped, plus comments explaining the token choice on the non-obvious rows. No new dependencies. 95/95 tests still green.

---

## What's next (Phase 2, v2.10+)

Four items deferred to the next milestone, all stemming from cleanly-bounded boot-perf scope decisions in v2.8.5 and v2.9:

- **Cursor-based pagination** — `gh api graphql pullRequests(first:N, after:CURSOR)` to replace the naive `offset+limit` re-walk currently used for paginated PR fetching. Today every "load more" re-fetches the previous pages too; a cursor makes each fetch O(page_size).
- **Batched `gh_pr_status_rollup`** — repopulate CI and merge-state badges on the PR list without requiring the user to click into each PR. Currently the badges only fill in on detail view.
- **`ghMergedSinceCount(cwd, since)`** — for the Dashboard's "N merged this week" stat, currently stuck at zero pending a cheap GraphQL `totalCount` query that respects the `mergedAt > since` filter.
- **Reviews-filter accuracy** — the "Reviews" PR filter (showing PRs where I'm in `reviewRequests`) needs the lazy enrichment to land before its data is fully reliable. Currently it can show an empty list when there should be entries.

A larger restructure is also in scoping: today the Launchpad is reached in two clicks (Workspace modal → "Launchpad" button) or via `⌘L`. The next UX iteration may surface Workspaces directly in the sidebar and make the Launchpad the primary view of the app — the pattern most multi-repo PR-centric workflows converge on. No commitment yet, but the v2.9 closure is the precondition for that conversation.

---

## Try it

`⌘L` from any workspace and the Launchpad opens. If you're new, the [Desktop guide](/guide/desktop) walks through the basics, and the v2.7 [Workspaces section](/changelog#v2-7-0-may-2026) covers how to define your repo set in the first place.

Download links and platform builds on the [GitWand homepage](https://gitwand.app). Source on [GitHub](https://github.com/devlint/GitWand). The full v2.9.0 entry sits in the [changelog](/changelog#v2-9-0-may-2026).

If your workspace is small enough that the Team tab is overkill, the **Disable Launchpad Team tab** toggle in Settings drops it entirely — three tabs, zero per-PR `gh pr view` cost.

---

*Curious about GitWand? [Download it here](https://gitwand.app/) — it is free, open-source, and shipping monthly.*

*Related reading: [Hooks, workspaces, agent sessions, and automations](/blog/agent-sessions-automations-v2-8) (the v2.7–v2.8 release that built the workspace foundation), and the [changelog](/changelog) for everything else.*
