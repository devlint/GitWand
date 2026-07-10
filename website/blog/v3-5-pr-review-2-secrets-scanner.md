---
title: "PR Review 2.0, a local secrets scanner, and smarter PR badges: GitWand v3.5"
description: "v3.5 rebuilds in-app PR review around a keyboard-first flow and a local AI pre-review pipeline, adds a zero-network pre-commit secrets scanner, and fixes branch badges that only ever saw the first page of open PRs."
date: 2026-07-10
head:
  - - meta
    - property: og:title
      content: "PR Review 2.0, a local secrets scanner, and smarter PR badges: GitWand v3.5"
  - - meta
    - property: og:description
      content: "Keyboard-first PR review with a local AI pre-review pass, a zero-network pre-commit secrets scanner, and PR badges that finally see past the first page."
  - - meta
    - name: twitter:title
      content: "PR Review 2.0 + local secrets scanner: GitWand v3.5"
---

# PR Review 2.0, a local secrets scanner, and smarter PR badges: GitWand v3.5

`@gitwand/desktop@3.5.0` bundles two chunks of work that were originally planned as separate releases, shipped together instead: a ground-up rebuild of in-app PR review, and a new pre-commit secrets scanner. Both were benchmark- and audit-driven, both are entirely local by default, and both target the same thing — catching what matters before it becomes a problem, without getting in your way.

Alongside them: branch badges that finally see past the first page of open PRs, a real PR count on the dock, and a couple of small UI fixes.

---

## PR review, rebuilt around keyboard and speed

The in-app pull request review (last touched in v2.24) gets a ground-up rebuild. A GitHub-standard keymap now drives the whole flow — `J`/`K` to move hunk by hunk, `⇧J`/`⇧K` to jump file to file, `V` to mark something viewed, `⇧V` to hide what you've already seen, `C` to comment where your cursor sits, `N`/`P` to cycle AI findings, `⌘Enter` to submit. A review that used to mean constant mouse trips can now happen almost entirely from the keyboard.

Files you've reviewed stay marked as viewed — invalidated honestly at the whole-PR level when the head SHA changes, so a re-push resets your progress instead of silently keeping stale marks. A draft review's comments now survive you navigating away and back, visible as a running count before you submit. Dismissing a review or requesting reviewers is one click from the Info tab instead of a trip to GitHub, on forges that support it — GitLab, which has no direct review-dismissal equivalent, just hides the action instead of throwing.

Big pull requests were the pain point this rebuild targeted directly: diffs now load per file instead of all at once, and even a single huge file renders through a virtualized view instead of dumping every line into the DOM. Reopening a PR you already had cached now costs three calls to the forge instead of six.

## An AI reviewer that reads the whole picture, not just the diff

GitWand can now run a local, opt-in AI pass over a pull request the moment you open it — not just line by line over the diff, but by first tracing which files import the changed code and pulling the history of the touched lines, the same multi-hop trick tools like Greptile charge for. Findings come back with a confidence score and a threshold you control, capped and remembering your per-finding dismissals, computed in the background so opening a PR never blocks on it. Switch PRs mid-run and the in-flight pass aborts cleanly.

A generated summary — what changed, why, which areas it touches — sits at the top of the Info tab before you read a single line of diff, and doubles as a review handoff. Underneath, CI check-run annotations, the AI's findings, and the existing static heuristic flags now render through one shared gutter-overlay model instead of three separate code paths bolted together over time.

GitLab's review methods, the largest remaining stub gap, are now real: inline batch comments anchor correctly via a dedicated diff-refs lookup, `listReviews` reflects actual approval/changes-requested state, and per-path comment counts are real instead of placeholder zeros.

## A secrets scanner that never leaves your machine

Inspired by GitSquid's pre-commit scanner — but with zero network dependency, everything local. Before you commit, GitWand can now scan every added line for the shape of a secret: AWS, GCP, Azure and GitHub tokens (`ghp_`, `github_pat_`), GitLab (`glpat-`), Slack, Stripe, OpenAI and Anthropic keys, RSA/OpenSSH/EC/PGP private-key headers, JWTs, and high-entropy literals that just look too random to be real code.

It's deliberately non-blocking by default: find something, and you get an orange badge in the commit area and a confirmation you can bypass, not a wall. Turn it into a hard stop with an opt-in pre-commit hook (Settings → Hooks) if your team wants one — always escapable with `git commit --no-verify` when you really mean it. Extend or quiet specific patterns per-repo through `.gitwandrc`'s `secrets.patterns[]` / `secrets.ignore[]`.

The matcher itself is dual-implemented on purpose: Rust's `regex` crate for the packaged desktop app, a pure TypeScript mirror in `@gitwand/core` for `pnpm dev:web` and the CLI, locked in sync by a parity test so the two never quietly diverge. The same engine ships as `gitwand scan [--json] [--strict]` in the CLI.

## Branch badges that see the whole picture

The small `#1234` badge that shows up on a branch with an open PR used to only ever look at the first page of results — a repo with more than ten open PRs could have one and never show a badge for it. GitWand now keeps draining pages quietly in the background after the first paint, the same git-log-style prefetch pattern used for the commit graph, and remembers what it found so reopening a repo restores the list instantly instead of starting cold again. Non-GitHub forges get the breadth fix too; the instant-restore fast path stays GitHub-only for now.

The dock's PR counter, previously stuck at whatever happened to already be loaded (often `0` until you opened the branch popover), now wires the existing forge-abstracted PR-count call and shows a real number on repo open and on manual refresh.

## The rest of the release

- **Repo tabs: reorder with any input** — tab drag-to-reorder was mouse-event-only; it now uses pointer events (mouse, touch, pen), plus keyboard support for accessible reordering.
- **File Explorer: Save button moved** — grouped next to the lock toggle with the other primary edit action, instead of sitting after Undo/Blame.
- **Azure comment safety** — `updateComment`/`deleteComment` aren't supported on Azure DevOps yet; the UI now hides the affordance instead of calling into a forge method that would throw.

---

Download GitWand 3.5.0 for macOS, Linux, or Windows from [GitHub Releases](https://github.com/devlint/GitWand/releases), or read the [full changelog](/changelog). For the complete PR review and security feature set, see the [features page](/features).
