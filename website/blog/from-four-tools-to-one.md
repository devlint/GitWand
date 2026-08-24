---
title: "From four tools to one: rebuilding the Git workflow you already have"
description: "Most people run Git across four tools: a desktop cockpit, a terminal, an IDE merge editor, and a browser tab. This is a tool-by-tool map of what each one does for you and where that same job lives in GitWand, with the same PHP rebase played twice: once the four-tool way, once end-to-end in GitWand."
date: 2026-08-24
head:
  - - meta
    - property: og:title
      content: "From four tools to one: rebuilding the Git workflow you already have"
  - - meta
    - property: og:description
      content: "A tool-by-tool map from the classic GitHub Desktop + terminal + PhpStorm + browser workflow to an end-to-end GitWand one, including the rebase loop that collapses into a single button, and the one job that should stay in your IDE."
  - - meta
    - name: twitter:title
      content: "From four tools to one: rebuilding your Git workflow in GitWand"
---

# From four tools to one: rebuilding the Git workflow you already have

Ask anyone where GitWand fits into an existing setup and you'll get a sensible, careful answer: *keep what you have, and slot GitWand into the one place where your workflow is inefficient: between `git rebase` and "ugh, I'll open the IDE".*

That's good advice. It's also how most people should start, and there's a whole section at the end of this post about doing exactly that. But it describes a first step, not a destination, and it quietly accepts a premise worth questioning: that running Git across four different applications is the natural state of things and the only fixable part is the worst seam.

This post takes the other question seriously. Not "where does GitWand plug in?" but **"what would it take to do all of it in GitWand, and where does that genuinely fall down?"**

---

## The workflow almost everyone actually has

Here's the setup, described fairly, because every piece of it is there for a reason:

**A desktop cockpit**, GitHub Desktop usually. It answers the questions you ask twenty times a day without thinking: what branch am I on, what changed, am I behind `main`, is there a PR for this. It's genuinely excellent at that. It's deliberately not built to be your Git plumbing.

**The terminal**, where the real work happens. `git rebase origin/main`, `git cherry-pick`, `git reflog`, `git reset --hard @{u}`. Explicit, predictable, scriptable. Nobody sane gives this up because a GUI has a pretty button.

**The IDE, as a merge editor**: PhpStorm in this example, and it earns its place. Its merge editor is one of the best pieces of software in the category: three panes, syntax-aware diffing, real navigation, and a *Resolve All Simple Conflicts* action across the whole changeset. When a conflict is genuinely about the code, this is where you want to be.

**A browser tab**, for the PR: the diff, the review comments, the CI logs.

Four tools, four good reasons. So what's the problem?

---

## The problem isn't the tools, it's the seams

Each tool holds its own picture of the repository, and **none of them knows what the others are doing**. The cost isn't in any one application. It's in the transitions between them, and it shows up in three specific ways.

**You are the integration layer.** GitHub Desktop can tell you a rebase is in progress. It can't drive it. The terminal can drive it but won't show you a graph. PhpStorm can resolve the conflict but has no opinion about the rebase you're twelve commits into. The state that ties all of that together (*which* rebase, *why*, what you were going to do after) lives in your head, and it evaporates every time you switch windows.

**You discover the shape of the work in the worst possible order.** Git tells you `CONFLICT (content)` four times. It does not tell you that three of them are trivial and one is real. You find that out by opening all four in the IDE, one at a time. The expensive tool gets launched to answer a question a cheap tool could have answered first.

**The loop multiplies everything.** A rebase replays commit by commit. Conflicts don't happen once, they happen *per commit*. So the sequence isn't `terminal → IDE → terminal`: it's that sequence, `N` times, with a full context switch at every hop. This is the part that makes a rebase feel expensive out of all proportion to the actual thinking involved.

None of that is a criticism of GitHub Desktop, the terminal, or PhpStorm. It's the arithmetic of running four tools that don't share state.

---

## The map: what you did, where it lives in GitWand

| What you're doing | Before | In GitWand |
|---|---|---|
| "What's going on across my repos?" | GitHub Desktop, one repo at a time | **Today** (`⌘L`): cross-repo triaged inbox, WIP, PRs, issues, team, sorted by urgency, each row with a state-aware action (Merge · Review · Resolve · Reply · See failure) |
| Reading history | GitHub Desktop's commit list | **Git Tree**: full-resolution DAG, filter mode, `#<PR number>` lookup, right-click to checkout/reset/branch/tag/cherry-pick |
| Staging a messy change | `git add -p` and hoping | Line- and hunk-level staging with inline diffs, folder tree or flat list |
| "Will this merge hurt?" | Merge it and find out | **Merge preview**: `git merge-base` + `git merge-file --diff3` on temp blobs, per-file verdict, zero writes to your working tree |
| `git rebase -i` | Terminal, `$EDITOR`, todo file | Interactive rebase editor, plus a rebase progress banner with **Auto-resolve** |
| Resolving conflicts | IDE merge editor, file by file | Deterministic engine first (13 classified conflict types, per-hunk confidence score, decision trace), then a three-pane merge editor for what's left |
| Understanding *why* a resolution was chosen | Reading the diff and trusting yourself | `trace.selected`, `trace.steps[]`: which patterns were tried, which passed, and why |
| PR review | Browser tab | In-app PR review across GitHub, GitLab, Bitbucket, Azure DevOps: inline comments, threading, `suggestion` blocks, CI check annotations overlaid on the diff |
| Juggling branches | `git stash` / `git switch` / `git stash pop` | Worktrees as a first-class concept, plus a throwaway **scratch worktree** for resolving in isolation |
| Running tests | Separate terminal window | Integrated terminal (WebGL, typed tabs) in the same window as the diff |
| Asking an AI about a conflict | Copy-paste into a chat tab | MCP server: the agent gets `ours`, `theirs`, `base`, the confidence score and the classification trace as structured data |

Two rows in that table are doing most of the work. Let's play them out.

---

## The same rebase, twice

Setup: a Symfony-ish PHP project. You're on `feature/payment`, `main` has moved, and you rebase.

```bash
git fetch origin
git rebase origin/main
```

```
CONFLICT (content): Merge conflict in src/Payment/PaymentService.php
CONFLICT (content): Merge conflict in src/Payment/StripeGateway.php
CONFLICT (content): Merge conflict in config/services.yaml
CONFLICT (content): Merge conflict in tests/PaymentTest.php
```

### Take 1: the four-tool way

`git status` to see the list. Switch to PhpStorm, wait for indexing if it's cold. *VCS → Resolve Conflicts*. Open `PaymentService.php`: three hunks, all of them a method signature that only one side touched. Accept, accept, accept. `services.yaml`: two hunks, one of them pure whitespace. `PaymentTest.php`: one hunk, a new test case each side, non-overlapping. Then `StripeGateway.php`, and *this* one is real: both sides restructured the same error-handling block.

You've now spent four file-opens and a context switch to arrive at the only file that ever needed you. You resolve it properly, because PhpStorm is very good at this. Back to the terminal:

```bash
vendor/bin/phpunit
git add .
git rebase --continue
```

And then the next commit replays, and Git says `CONFLICT (content)` again, and you do the whole thing over.

### Take 2: end to end in GitWand

**Before you start, ask.** The conflict predictor simulates the rebase without touching your working tree, your index, or `HEAD`. It reads blobs with `git show`, merges them with `git merge-file` in a temp directory, and runs the result through the same engine the resolver uses:

```bash
gitwand preview --onto=origin/main
```

```
Rebase onto: origin/main
Risk: HIGH

  src/Payment/PaymentService.php — 3/3 auto-resolvable (100%)
  src/Payment/StripeGateway.php — 0/1 auto-resolvable (0%)
  config/services.yaml — 2/2 auto-resolvable (100%)
  tests/PaymentTest.php — 1/1 auto-resolvable (100%)

  Total: 6/7 conflicts auto-resolvable
```

Note that risk is `HIGH` even though 6 of 7 conflicts resolve themselves. The risk model is deliberately **status-based, not count-based**: one file where *nothing* is auto-resolvable is high risk, full stop. That file is going to need a human, and no amount of easy wins elsewhere changes it. The same computation backs the desktop merge preview and the `gitwand_preview_merge` MCP tool, so all three surfaces agree on identical input.

You now know, before starting, that this rebase costs you exactly one file's worth of thinking. That single fact is most of what the four-tool workflow was making you pay to discover.

**Then let the loop run itself.** In the desktop app, start the rebase and hit **Auto-resolve** on the rebase progress banner. It resolves every step and continues the rebase automatically until it either finishes or hits something it won't decide on its own. The `terminal → IDE → terminal` loop, `N` times over, collapses into one button, and it stops precisely at `StripeGateway.php`.

Prefer the terminal? The CLI does the same work one step at a time. Dry-run first: it analyses and writes nothing.

```bash
gitwand resolve --dry-run
```

```
  ✨ GitWand — Git's magic wand

4 conflicted file(s) detected

  ✓ src/Payment/PaymentService.php — 3/3 resolved
  ◐ src/Payment/StripeGateway.php — 0/1 resolved
  ✓ config/services.yaml — 2/2 resolved
  ✓ tests/PaymentTest.php — 1/1 resolved

─── Summary ───
✨ 6 conflict(s) auto-resolved out of 7
1 conflict(s) remaining — manual resolution needed

(dry-run — no files modified)
```

Drop `--dry-run` and it writes. Files are processed in a bounded concurrent pool (`--concurrency=N`, default 8), and output order stays deterministic regardless of which worker finishes first, so the same repo state always prints the same report.

**The safety rails are not decorative.** After resolving, GitWand validates before it writes: if residual conflict markers survive in a fully-resolved file, the write is **blocked**, not warned about. Writing that file would leave your repo looking conflicted for reasons nobody could later reconstruct. Syntax errors warn but don't block. Files with unresolved hunks keep their markers on purpose.

**Then, and only then, the one real conflict.** It opens in the merge editor with `ours` / `theirs` / `base`, the decision trace rendered in plain English, and (opt-in, never automatic) an *Explain* and an AI *suggest* action per hunk.

**Then verify, in the same window.** The integrated terminal is right there, in the same app as the diff you just resolved:

```bash
composer validate
vendor/bin/phpunit
vendor/bin/phpstan analyse
```

This part is non-negotiable and worth saying plainly: *"GitWand resolved the conflict"* and *"my code is correct"* are different claims. GitWand checks for residual markers and syntax validity. Your test suite checks whether the merge made sense. Nothing replaces the second one.

---

## "Deterministic" is a claim, so here's the receipt

The reason this workflow is worth trusting with a `--continue` loop isn't that the engine is smart. It's that it's **auditable and boring**. Each hunk gets classified into one of [thirteen documented types](/guide/conflict-resolution) (`one_side_change`, `same_change`, `non_overlapping`, `whitespace_only`, `delete_no_change`, `generated_file`, `value_only_change`, `reorder_only`, `insertion_at_boundary`, `token_level_merge`, `refactoring_aware_merge`, `llm_proposed`, `complex`), then gets a composite confidence score with named dimensions rather than a vibe.

Two of the thirteen are deliberately outside the automatic path, and it's worth being precise about it: `token_level_merge` is always *proposed* and never auto-applied, whatever its confidence, and `refactoring_aware_merge` is off unless you turn it on (it's forced on when the LLM fallback is enabled, so a deterministically recoverable rename never reaches a model).

A couple of the others are quietly load-bearing for a PHP project specifically. `generated_file` recognises `composer.lock` (alongside `package-lock.json`, `yarn.lock`, `Cargo.lock`, `dist/`, `.min.js` and friends) and takes theirs, because the file is going to be regenerated anyway. That's the conflict everyone resolves wrong at least once. And `value_only_change` handles the case where both sides bumped the same version string or timestamp: comparable semver and ISO tokens resolve to the higher one deterministically, rather than becoming a coin flip.

**And the hit-rate is measured, not asserted.** [`scripts/replay-conflicts.mjs`](https://github.com/devlint/GitWand/blob/main/scripts/replay-conflicts.mjs) replays a repository's real merge history with `git merge-tree --write-tree`, pushes every conflicted hunk through the same `resolve()` the CLI calls, and prints the tier breakdown. On the corpus we use for pattern decisions, a PHP/Vue monorepo with short-lived branches, 2,000 historical merges replayed:

| | Hunks |
|---|---|
| `value_only_change` alone | 1,598 |
| Residual after the trivial passes | **104** |
| … genuinely `complex`, i.e. human territory | **96** |

The interesting part is what that measurement is mostly used for: **refusing to build things.** The bar for shipping a new pattern is 5% of the residual. Cherry-pick echo detection measured 1% and was not built. Grammar-driven commutative list merging, the Mergiraf/Spork approach, looked like a 51% opportunity by shape and turned out to be 0.5% in reality, because everything genuinely disjoint is already absorbed upstream by `non_overlapping` and `insertion_at_boundary`; not built either. What *did* change the engine was a tokenizer bug the same replay surfaced: quoted timestamps like `'2026-07-06 11:42:00'` were split on their inner space, so `value_only_change` was missing the single most recurrent residual hunk of the entire corpus. Fixing that halved the residual, 214 hunks down to 104.

That's the whole reason to trust a `--continue` loop with this. Not a benchmark chosen to flatter the engine, but a script that has vetoed two of the last three patterns proposed for it.

`gitwand resolve --json` emits the whole thing as a stable contract, carrying a top-level `version` field so a CI parser can pin it (trimmed here):

```jsonc
{
  "summary": { "files": 4, "totalConflicts": 7, "autoResolved": 6, "remaining": 1, "allResolved": false },
  "files": [
    {
      "path": "src/Payment/PaymentService.php",
      "totalConflicts": 3, "autoResolved": 3, "remaining": 0,
      "validation": { "isValid": true, "hasResidualMarkers": false, "syntaxError": null },
      "resolutions": [
        {
          "line": 42,
          "type": "one_side_change",
          "resolved": true,
          "confidence": { "overall": 97, "typeClassification": 100, "dataRisk": 0, "scopeImpact": 20 },
          "trace": {
            "selected": "one_side_change",
            "hasBase": true,
            "steps": [ { "type": "same_change", "passed": false, "reason": "…" } ]
          }
        }
      ],
      "pendingHunks": []
    }
  ]
}
```

That's the difference between `97 · one_side_change · deterministic` and *"🤖 the AI thinks this is probably fine."* One of those you can put in CI, which is what the semantic exit codes are for: `0` clean, `1` conflicts remaining, `2` error. They come from `resolve --ci` (`status` is a read-only overview and always exits `0`), and `--dry-run` keeps the check from writing anything:

```yaml
- name: Check conflicts
  run: npx @gitwand/cli resolve --ci --dry-run
```

And when a model *is* involved (the opt-in `--llm-fallback`), it doesn't get to hide. The CLI prints a warning to stderr on every single invocation naming the provider and model your code is about to be sent to, the resolution is tagged `llm_proposed` rather than blended in with the deterministic ones, and it carries a full `llmTrace` audit record. Opt-in means opt-in, visibly, every time.

---

## What should not move into GitWand

An honest map has to include the parts that don't transfer, and there's one that matters.

**Understanding the code stays in your IDE.** When the question is *"which of these two error-handling rewrites is correct for this class?"*, you need the type system, the interfaces, the usages, the call sites, the static analyser. PhpStorm has all of that and GitWand does not: its Files panel is a CodeMirror editor, not a PHP language server, and pretending otherwise would be silly. GitWand has an external-editor setting for exactly this reason.

But notice what changed. In the four-tool workflow, PhpStorm is where you *discover* that six of the seven conflicts were trivial and one was real. In this workflow, PhpStorm is where you go *knowing* there's exactly one real one, because the predictor told you before the rebase started. Same tool, same strength, called at the right moment instead of used as a search function.

**The terminal doesn't disappear either.** It moves inside the window. `phpunit`, `phpstan`, `composer`: same commands, same output, no longer a different application.

---

## How to actually get there (in three stages, not one leap)

Nobody should replace four tools on a Tuesday. This ladder is designed so you can stop at any rung and still be better off than you started.

**Stage 1: the conflict reflex.** Change nothing else. Keep GitHub Desktop, keep the terminal, keep PhpStorm. Add exactly one habit: when Git says `CONFLICT`, run `npx @gitwand/cli resolve --dry-run` *before* reaching for the IDE.

```bash
npx @gitwand/cli resolve --dry-run   # what would happen
npx @gitwand/cli resolve             # do it
```

Then measure the only thing that matters: **how often does it stop you needing the IDE at all?** If it's not a clear majority on your real conflicts, none of the rest of this post applies to you, and that's a perfectly good outcome for a week's experiment.

You don't have to wait a week for that answer, either. The same script that produced the numbers above runs against *your* history, so you can get your own residual before changing a single habit (clone GitWand, `pnpm install && pnpm -r run build`, git 2.38+):

```bash
node scripts/replay-conflicts.mjs /path/to/your/repo --max-merges 500
```

It replays your merges without touching your working tree, your index, or any ref: `git merge-tree` writes unreferenced, garbage-collectable objects and nothing else. What comes back is your `residual` and your `recoverable-before-model`, on your code, in one command. If your residual looks like ours, the rest of this post is a decent bet. If it doesn't, you've learned that for the price of one coffee break.

**Stage 2: the whole Git operation, not just the conflict.** Move merges, rebases, and cherry-picks into the desktop app: preview first, Auto-resolve through the loop, merge editor for the residue. Keep GitHub Desktop as your cockpit. This is the stage where the *loop* cost disappears, which is a bigger win than the per-file cost from Stage 1.

**Stage 3: close the seams.** Today replaces the cockpit. In-app PR review replaces the browser tab. The integrated terminal replaces the separate window. Your IDE goes back to being an IDE: where you write code, not where you go to find out how bad a rebase was.

And if you work with coding agents, Stage 3 has a fourth piece: `claude mcp add gitwand -- npx -y @gitwand/mcp` gives Claude Code, Cursor, or Windsurf access to seven tools (`gitwand_status`, `gitwand_preview_merge`, `gitwand_resolve_conflicts`, `gitwand_explain_hunk`, `gitwand_apply_resolution`, `gitwand_resolve_hunk`, `gitwand_resolve_hunk_llm`) plus three resources (`gitwand://repo/conflicts`, `gitwand://repo/policy`, `gitwand://hunk/{file}/{line}`). The agent stops guessing at `<<<<<<<` markers and starts reading structured hunks with a confidence score attached: deterministic patterns handle the trivial mass, the model only sees what actually needs judgement.

---

## The one-sentence version

The four-tool workflow isn't wrong: every tool in it is good at its job. It's just that nobody ever chose it. It accumulated, one reasonable decision at a time, and the tax it charges is invisible precisely because it's spread evenly across every single merge you've ever done. Collapsing it isn't about GitWand having more buttons than GitHub Desktop or a better merge editor than PhpStorm. It's about the repository, the history, the conflicts, the PR, the tests, and the agent all being *the same context*, instead of something you reassemble in your head at every window switch.

---

GitWand is free, MIT-licensed, and runs entirely on your machine. Download it for macOS, Linux, or Windows from [GitHub Releases](https://github.com/devlint/GitWand/releases), try the CLI with `npx @gitwand/cli status`, or read how the engine classifies a hunk in the [conflict engine guide](/guide/conflict-resolution).
