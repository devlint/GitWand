---
title: "Why GitWand is Rust, not Electron: what native performance actually buys a Git client"
description: "A tour of what's shipped since v3.5 (Commit Review, dev-loop and CI performance work, small UX fixes) seen through the architectural bet that makes them possible: Tauri 2 + Rust, plus a deliberately portable TypeScript core, and what that combination is actually worth in a market still dominated by Electron and paid cloud AI."
date: 2026-08-21
head:
  - - meta
    - property: og:title
      content: "Why GitWand is Rust, not Electron: what native performance actually buys a Git client"
  - - meta
    - property: og:description
      content: "Real numbers behind the Tauri 2 + Rust bet: a 750ms to 30ms multi-repo status fetch, a portable TypeScript core kept out of Rust on purpose, and why local-first AI review beats a paid cloud API."
  - - meta
    - name: twitter:title
      content: "Why GitWand is Rust, not Electron: GitWand's architecture, explained"
---

# Why GitWand is Rust, not Electron: what native performance actually buys a Git client

It's been a while since the last post here (v3.5, July 10). Since then, three releases have shipped: v3.6.0 (a handful of workflow polish items), v3.6.6 (a pure dev-loop and CI performance pass, no product surface), and v3.7.0 (Commit Review, a local AI pass over your staged changes). A straight changelog recap would cover all three, but it would miss the thing that actually connects them.

Every one of those releases is a direct consequence of a decision made on day one: build on Tauri 2 and Rust instead of Electron, and keep the actual conflict-resolution logic in a deliberately portable, zero-dependency TypeScript package instead of folding it into the Rust backend. That split sounds like an implementation detail. It isn't. It's the reason a 5-repo Launchpad refresh takes 30ms instead of most of a second, the reason a 30-second timeout bug fixed a few days ago (#166) had a one-line fix instead of a rewrite, and the reason the new Commit Review feature never has to touch a GitWand server. This post is about that decision, with real numbers pulled straight from the codebase instead of the usual "native is faster, trust us."

---

## The bet, and who else made it

GitWand ships as roughly an 8 MB installed binary. GitKraken, built on Electron, ships in the ~150 MB class: a full bundled Chromium plus a full bundled Node.js runtime, running alongside each other, for an app that mostly renders text and spawns `git`. GitHub Desktop is the same story. The gap shows up at startup (GitWand is sub-1 second) and it shows up on large repos, where an Electron app's single JS heap has to hold and garbage-collect everything the UI touches.

To be fair to the field: GitWand isn't the only one making this bet anymore. GitButler is Tauri + Rust too. GitComet skips the webview entirely and goes pure Rust with GPUI. Strand is Tauri + React. Being native, in 2026, is closer to table stakes for a new Git client than a differentiator; RelaGit is the interesting counter-example, choosing Electron even with a SolidJS frontend for its fine-grained reactivity. The real question isn't "who avoided Electron," it's what each of these tools actually does with the native layer once it has it. That's the part worth walking through.

---

## What Rust buys: fearless concurrency, with a number attached

Rust's ownership model turns a whole class of concurrency bugs into compile errors instead of production incidents. That's a nice sentence to put in a pitch deck. Here's what it looks like in a file that ships in the app today.

GitWand's multi-repo dashboard (Launchpad) needs the status of every repo in your workspace: branch, ahead/behind, modified-file count. The naive version spawns four `git` subprocesses per repo, one after another. GitWand's Rust backend does two things instead: each repo's status comes from a single in-process `libgit2` call rather than four subprocess spawns, and every repo in the workspace gets processed in parallel via `rayon`'s `into_par_iter()`, one core per repo instead of one core doing all of them in sequence. The comment sitting next to that code in the source states the measured result plainly: a 5-repo workspace listing went from about 750ms wall-clock to about 30ms in the typical case. That's not a marketing number, it's a comment next to a `#[tauri::command]` that ships today.

The same pattern shows up all over the backend, because once the tool exists, using it costs nothing extra: PR `+/-` stat enrichment across GitHub, GitLab, Azure DevOps, and Bitbucket all fan out per-PR diff computation across cores instead of looping; submodule status checks across a repo's submodules run in parallel; per-branch top-author lookups for the branch picker do too. A few days ago, a regression brought back a 30-second `gh_list_prs` timeout: the per-PR stats loop had gone back to running one `git diff --numstat` at a time. The fix wasn't a rewrite or a new thread pool, it was swapping a `for` loop for `.par_iter_mut()`. None of these needed hand-rolled synchronization or a bespoke worker pool. The parallel version and the serial version are the same number of lines, and if two of those parallel closures ever raced on the same mutable data, that's a compile error, not a bug report from a user with a corrupted status badge.

---

## What Rust doesn't need to buy: the conflict engine stays TypeScript, on purpose

Here's the part a "Rust is fast" pitch usually skips: the actual pattern-classification engine, the code that decides `same_change` versus `one_side_change` versus `complex` and merges JSON, YAML, and lockfiles key by key, is not written in Rust. It lives in `@gitwand/core`, and that package is deliberately zero-Node, browser-safe TypeScript.

That's not a compromise, it's a second, equally deliberate architectural line. Classifying a few hundred lines of diff text against nine pattern rules finishes in single-digit milliseconds no matter what language it's written in; Rust's raw throughput wouldn't move that number in any way a user could feel. What Rust *would* have cost is portability: because the engine has no Node dependency, the exact same code runs inside the desktop app, in the CLI (`npx @gitwand/cli resolve`), inside the MCP server that AI agents call, and could run directly in a browser tomorrow with no changes. The rule GitWand actually follows isn't "everything is Rust." It's narrower and, we think, more useful: Rust owns the boundary with the operating system (spawning `git`, walking the filesystem, talking to forge APIs, the whole app shell), and the deterministic algorithmic core stays a small, dependency-light, portable package that isn't tied to any one runtime.

---

## The unglamorous release: v3.6.6

v3.6.6 shipped no new product surface at all, just a dev-loop and CI performance pass, and it's the release that best shows the bet compounding on itself. Because the entire backend is one Rust crate, the same profiling discipline used to make the app fast also applies to making the *build* fast: a `[profile.dev]` tuned for lighter debug info cut a post-edit `cargo build` from about 21 seconds to about 6.5. On the CI side, a `desktop` job that produced three fully-signed release bundles on every single push to `main`, bundles nobody downloaded, was replaced with a fast `rust-check` job (fmt, clippy, check, test) that finally runs the app's 217 Rust unit tests in CI for the first time, saving roughly 230 billed CI minutes per push. On the TypeScript side, Vitest's global `jsdom` environment (needed by maybe a fifth of the test files, paid by all of them) was scoped down per-file, cutting environment setup time from about 96 seconds to about 17 across the suite.

Worth mentioning: before touching any of it, every claim in the plan for this work got re-measured against the actual codebase, not assumed. Several turned out to be wrong. "Any edit recompiles and relinks everything" wasn't true, `cargo check` after a real edit came back in under 2 seconds; the real cost was in the codegen-and-link step of a full `cargo build`. "The old `jsdom` setup costs 100 to 300ms per file" was an underestimate by roughly 10x once actually profiled. That's the same discipline the conflict engine's confidence scores are built on: don't ship a number you haven't checked.

---

## Commit Review, and why local-first is the real differentiator

v3.7.0's headline feature, Commit Review, runs an AI pass over your staged changes right in the Changes panel before you commit, with inline findings and a "Fix with agent" action that hands them to a terminal AI session (Claude Code, opencode, or Codex) already running against your repo. What matters about it architecturally is what it *doesn't* do: it never calls a GitWand-run server. The review runs against whichever AI CLI you already have installed, on your machine, over your own already-open agent session.

That's the same "zero mandatory cloud" value the conflict engine already embodies, applied to review instead of merge. It's also the sharper contrast with where a chunk of the market is headed: tools positioning code-intelligence features as a metered cloud API (Greptile's own "Genius API" is priced at $0.45 per request) are betting that developers will pay per call for something GitWand ships as a local, free, opt-in feature built on tools you already run. Being local-first for conflict resolution and local-first for review isn't two separate decisions, it's the same one, applied twice.

---

## The small stuff: v3.6.0

Between the two, v3.6.0 shipped things that don't need an architecture section to justify: a one-click "Update branch" prompt when you check out something behind its upstream, and a non-blocking handoff when an interactive rebase hits a conflict (issue #128), so the conflict editor no longer traps you behind a modal. These are the kind of small interactions that only feel good because there's no Electron process and no garbage-collector pause standing between the click and the result. The architecture doesn't just enable the big numbers, it's also why the boring stuff feels instant.

---

## Where the bet goes next

The roadmap's next stop, v3.9.0 (Live Repo), applies the same philosophy one layer up: a Rust `notify` crate watcher replaces the current 2-second status poll with real filesystem events, more read paths move to in-process `libgit2`, and separately, the portable TypeScript core's diff/parse hot path gets moved off the main thread into a Web Worker. Same rule, two languages: Rust handles OS-level events natively and cheaply, and the portable core gets pushed off the render thread the way any JavaScript does it. One architecture, one non-negotiable: the UI thread never waits on either of them.

---

## The market read

The Git GUI space is splitting into two camps: Electron incumbents charging a subscription for cloud AI features (GitKraken at $8/mo, with its advanced and AI features gated behind an account), and a newer wave of native, mostly free, often open-source tools built on Rust or a comparable native stack (GitButler, GitComet, Strand, and GitWand, with RelaGit staying on Electron by choice). Being native is fast becoming the price of entry for that second group, not what sets any one of them apart. What actually differentiates GitWand inside it is what the native layer gets used for: a conflict-resolution engine that classifies instead of guesses, multi-repo workflows that get genuinely (and measurably) faster because of how the backend is built, and an AI layer that never assumes your code should leave your machine.

---

Download GitWand for macOS, Linux, or Windows from [GitHub Releases](https://github.com/devlint/GitWand/releases), read the [full changelog](/changelog), or see how the numbers stack up against specific tools on the [compare pages](/compare/).
