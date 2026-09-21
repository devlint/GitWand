---
title: "Three outcomes, not two: what went into GitWand v3.11"
description: "The Conflict Predictor now runs the merge instead of describing it. Along the way, v3.11 fixed a class of bug that had been hiding in plain sight — operations that reported success they had not earned — and an audit that found the development server was telling manual QA a different story from the shipped app."
date: 2026-09-21
head:
  - - meta
    - property: og:title
      content: "Three outcomes, not two: what went into GitWand v3.11"
  - - meta
    - property: og:description
      content: "v3.11 makes the Conflict Predictor apply the merge it predicts, and fixes the reason an abort could report success it had not earned: an operation ends three ways, not two."
---

# Three outcomes, not two: what went into GitWand v3.11

The headline of v3.11 is that the Conflict Predictor stopped predicting and started doing. But the work that took the longest, and that changed the most code, came out of a two-line bug report about a button that lied.

This release has a spine, and it is not a feature. It is the difference between a tool that reports what happened and a tool that reports what it assumed happened.

---

## The Conflict Predictor now does the merge

Until now the predictor told you what a merge *would* do and then left you with two bad options: merge blind, or detour through a scratch worktree to try it.

"Merge and auto-resolve" now runs the real operation, re-runs the engine against what git actually produced, applies every resolution that clears the gates, stages them, and stops with the operation still in progress on whatever needs a person.

What it does not do matters as much. It never aborts on your behalf, because an abort discards hand resolution that no snapshot can give back. It never continues past a residual. And the button says "Estimated N" rather than a promise, because the preview is a simulation over three blobs — no index, no `MERGE_HEAD`, no rename detection, no `.gitattributes` merge drivers. When the estimate and the outcome disagree, which they can by construction, the report says so instead of quietly rounding.

Alongside it, the engine's confidence score became something you can act on: `minConfidenceScore`, 0 to 100, settable from the desktop app, `.gitwandrc`, the CLI and the MCP tools. It is combined with the existing label gate rather than replacing it. That is a design decision, not an implementation detail — `complex` scores 60, so a numeric gate that *replaced* the label gate would have silently started applying complex hunks under any bar below 60. Being purely subtractive, no setting of the bar makes GitWand apply more than it would with the bar switched off.

## "Merge aborted" was not true

Issue #197 was small: clicking "Abort merge" showed "Merge aborted" and the conflict was still there.

The cause is worth spelling out, because the shape of it is common. The backend command returned `Ok` with a `success: false` field when git refused — `error: Entry 'a.txt' not uptodate. Cannot merge.`, exit code 128. The frontend only treated a *rejected promise* as failure. A refusal that arrived as a successful call carrying a negative result read as a success.

So the app announced an abort that had not happened, cleared the view, and left the merge on disk.

Fixing the button was an afternoon. The interesting part was what the fix uncovered.

## An operation ends three ways, not two

GitWand has four sibling git operations — merge, cherry-pick, revert, rebase — and it modelled each one differently. Four abort/continue pairs, three different conventions for reporting failure between them, and revert with no abort or continue at all: the app could start a revert it had no way to finish.

Consolidating them surfaced the thing that had actually been missing everywhere. **An operation action ends in three ways, not two.** It completes. It halts on a further conflict. Or it fails.

Collapsing the last two is what produces both symptoms at once. Treat a halt as a failure and `git cherry-pick --continue`, landing on the second conflicting commit exactly as it should, surfaces an error toast for an operation that was simply making progress. Treat a refusal as a completion and you get "Merge aborted" over a merge that is still there.

One command now covers all four operations and returns that three-way answer. A revert can be abandoned. An abort that would discard resolution work asks first. Nothing auto-continues when the last conflict is resolved — the banner's Continue button is the one way forward, for every operation, which is the policy a paused rebase already had for good reasons.

One small detail from that work, for anyone doing something similar: the check for "did git halt on a conflict" reads git's own words (`CONFLICT`, `could not apply`), which makes it depend on how git was built, since git ships translations. Measured on the development machine, a git with no translation data answers identically in French and in C — so this was never a reproduced bug, only a dependency on a build option. It is pinned with `LC_ALL=C` anyway, because the fix costs nothing and the dependency was not worth keeping.

## The development server was telling QA a different story

GitWand runs in a browser during development, against a Node development server that stands in for the Rust backend. That is where most manual testing happens. If a command has no route there, or behaves differently, then manual testing quietly checks something other than what ships.

That had already cost real bugs. A broken `glab` flag survived in production because the only environment that could have caught it never ran that code. A file-reading command rejected non-UTF-8 input on one side and silently substituted `U+FFFD` on the other — the two agreed on every success and disagreed only on failure, which is the shape that hides best.

So v3.11 made the correspondence explicit. Every command the interface calls now declares either its development-server route or the reason it cannot have one, and a test fails when that stops being true.

There is no rule mapping a command name to a route name — `get_conflicted_files` is served by `/api/conflicted-files`, `git_add_to_gitignore` by `/api/git-gitignore` — which is exactly why the drift was invisible: no heuristic could tell you a route was missing.

The audit found eleven gaps. Two were live defects, now fixed: two commands fetched routes the development server never declared, so in the browser one silently returned nothing and the other threw. A further pass, comparing how both sides *fail* rather than how they succeed across 27 commands that write to a repository, found a third: a submodule update that discarded git's exit code and reported success whatever happened.

The remaining nine are recorded in the file rather than dressed up as deliberate choices. They are commands that have no route and no reason not to have one — not active defects, just unavailable in the browser, which you notice the moment you use them.

One note from building the guard, since it nearly defeated its own purpose. The first measurement counted 122 commands. The real number is 139. A regex over the call's type parameter stopped at the first `>` and missed every invocation with a nested generic — including `git_status`, `git_diff`, `git_log` and `git_blame`, four of the most-used commands in the app. **A guard that under-counts passes while auditing nothing**, which is worse than no guard, so the parser is now specified rather than left to whoever writes it, and a floor assertion pins the count.

## The rest of the release

**Gitea and Forgejo.** Sign in with a personal access token and the pull request surface works on any self-hosted Gitea or Forgejo server: list, detail, diff, CI status, comments, create, merge, checkout, draft to ready. Verified against a live Gitea 1.27.3, which corrected two things the documentation had led us to believe, and exposed a comment endpoint that ignores pagination and served the same comment three hundred times.

**Merges that arm themselves.** A pull request whose checks have not finished can be told to merge itself once they pass, on GitHub, GitLab and Azure DevOps. Bitbucket has no such capability on its API and says so plainly instead of pretending. The action only ever appears on a pull request that is *not* already mergeable, because when one is clean the plain merge sitting next to it is what you want.

**A real editor in the merge view.** The bare textarea is gone, replaced by CodeMirror 6 — syntax highlighting, line numbers, real undo. And an inline diff hunk can be edited where you read it, deliberately bounded to unstaged, non-conflicted files, one hunk at a time, writing back through a layer that reconstructs from the original bytes so trailing newlines and CRLF endings survive.

---

Two lots planned for v3.11 did not make it and were not quietly dropped: history-aware LLM fallback and a Finder-like folder tree are now v3.11.1 and v3.11.2, named in the roadmap with what is left to do.
