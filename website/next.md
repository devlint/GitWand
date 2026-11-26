---
title: What's next — GitWand v4
description: Where GitWand is going. v4 turns the Git client into one working environment where coding agents are supervised and controlled, and their work is integrated with proof. What changes, what does not, and what happens to 3.x.
head:
  - - meta
    - property: og:title
      content: What's next — GitWand v4
  - - meta
    - property: og:description
      content: v4 turns GitWand into one working environment where coding agents are supervised, controlled and integrated with proof. What changes and what does not.
---

# What's next: GitWand v4

_Last updated 2026-11-26. This page describes a direction, not a schedule. It carries no dates, and it says plainly what is decided and what is not._

GitWand v4 is a break with the Git client you know. It becomes one working environment where coding agents are **supervised and controlled**, and where their work is **integrated with proof**.

## Why

More and more code is written by agents, often several at a time, each in its own worktree. Writing is no longer the slow part. Integrating and verifying is: nobody can read everything five agents produce, and Git clients were all designed for one person making their own commits.

GitWand has spent three major versions on the question that matters here: what a machine may settle in a merge, and what only a person may decide. v4 puts that question at the centre of the whole application, not only of the merge editor.

## What changes

**The work is organised by task, not by Git object.** A task is a worktree and its branch, whoever is working in it. The list of tasks, across all your repositories, is always on screen, with the one waiting for your answer on top.

**A task has three modes.**

- **Session**: the agent's terminal, as the main surface.
- **Files**: the file explorer, editor and diff that exist today, opened on what the task changed.
- **Integration**: the merge, on one screen, with what was resolved, why, and what is left for you.

**Integrate, across tasks.** Before anything lands, GitWand predicts the conflicts between parallel tasks and against the target branch, proposes an order, resolves what carries no decision, and shows you only the hunks where two branches genuinely disagree, with the number of lines left for you to read.

**The repository becomes a set of instruments.** The graph, restore points, guardrails, pull requests and CI stop being places you navigate to. They open beside the task, for control and for visualization. Occasional tools (stash, tags, submodules, bisect) move to the command palette.

**Control happens at the Git boundary first.** Every agent ends up committing and pushing, whatever its CLI. That is where GitWand can hold a push until a commit review is validated, lock a worktree while an agent runs, or take you back to before a session, without depending on any one agent vendor.

## What does not change

- **Local first.** No account, no mandatory cloud. Your code does not leave your machine unless you configure a provider that receives it.
- **Open source, MIT.** Core and desktop.
- **The engine stays deterministic.** No model touches a resolution unless you turn the LLM fallback on, and a hunk the engine classifies as a real disagreement is never applied without you.
- **You can still work by hand.** Committing yourself is a task like any other, with you as its author. The full history, diff and blame stay one step away.
- **No lock-in to an agent.** Claude Code, Codex, Gemini, opencode: GitWand supervises the session, it does not replace the CLI.
- **macOS, Linux, Windows**, as today.

## What happens to 3.x

3.x finishes the work in progress, then receives fixes only. v3.15 is its last feature release. Nothing is removed from 3.x, and it stays the recommended version until v4 is ready for daily use.

## Decided, and not yet

| | |
|---|---|
| **Decided** | The direction above. The order of the 4.x releases: the workspace, the resolution engine, the view across tasks, code intelligence, then workflows and forges. |
| **Not decided** | Dates. How previews will be distributed. The exact shape of the screens: what exists today are working mockups, not a design. |
| **Dropped** | Voice input, and a few follow-ups that had no real case behind them. Each is listed in the roadmap with what would bring it back. |

## About data

GitWand will keep a local journal of the resolutions it applies, so the engine's accuracy can be shown to you on your own machine. Sharing anything from it will be opt-in, asked after you have seen the numbers, and limited to aggregated counts. No file content, no paths, no repository names. The design is in the roadmap before a line of it is written, so it can be discussed first.

## Have a say

The complete plan, with the reasoning, is in the [roadmap](https://github.com/devlint/GitWand/blob/main/ROADMAP.md). If you rely on something in GitWand today and want to know where it goes in v4, or you think this direction is wrong, say so in the [discussions](https://github.com/devlint/GitWand/discussions). That is more useful now than once it is built.
