---
title: "Letting an AI agent resolve Git conflicts without risk: what it must do, and what it must never do"
description: "A short rulebook for agents that touch merge conflicts: never abort for the human, never continue past a residual, let a deterministic resolver that explains itself go first, set the confidence bar explicitly, preview before applying. Each rule mapped to the GitWand MCP tool that supports it, and the gaps we found in our own server while writing it."
date: 2026-11-10
head:
  - - meta
    - property: og:title
      content: "Letting an AI agent resolve Git conflicts without risk: what it must do, and what it must never do"
  - - meta
    - property: og:description
      content: "Nine concrete rules for agents that touch merge conflicts, each mapped to a real GitWand MCP tool — and the gaps we found in our own server while writing them down."
---

# Letting an AI agent resolve Git conflicts without risk: what it must do, and what it must never do

An agent that can edit files can resolve a merge conflict. That was never the hard part. The hard part is that a conflict lives inside an operation that has *state* — a half-finished merge, a rebase paused on its third commit, resolution work a person has already done by hand — and an agent that treats it as "remove the markers, make the build pass" can destroy that state or bury a wrong decision in a commit that looks fine.

This article is a rulebook. Nine rules, each one tied to what the [GitWand MCP server](/guide/mcp) (`@gitwand/mcp`, 3.13) actually exposes, checked against `packages/mcp/src/tools` rather than against what we remembered it doing. Setup and the general workflow with Claude Code are in [Pairing Claude Code with GitWand](/blog/claude-code-gitwand-ai-agents); this one is only about the boundaries. Writing it turned up four gaps in our own server, which are listed at the end rather than smoothed over.

---

## What the server can and cannot touch

Worth knowing before any rule: the MCP server exposes seven tools — `gitwand_status`, `gitwand_preview_merge`, `gitwand_resolve_conflicts`, `gitwand_explain_hunk`, `gitwand_apply_resolution`, `gitwand_resolve_hunk` and `gitwand_resolve_hunk_llm` — and three resources (`gitwand://repo/conflicts`, `gitwand://repo/policy`, `gitwand://hunk/{file}/{line}`).

The only git commands it runs are reads: listing unmerged paths, `rev-parse`, `merge-base`, `show`, and `merge-file -p`, which prints to stdout. Three tools write *file contents* in the working tree. None of them stages a file, continues an operation or aborts one. That is a deliberate shape: everything that changes the operation's state stays with the agent's shell, where it is visible, and the rules below are mostly about how the agent should use that shell.

---

## Rule 1 — Read the state before touching anything

Call `gitwand_status` first. It lists the conflicted files, the conflict count per file, the types the engine classified and how many it would resolve. It writes nothing.

The agent should also know *which* operation it is in (`git status` says it plainly: merge, rebase, cherry-pick, revert). The engine uses that context too — during a merge or rebase, a version bumped on both sides resolves to the target branch's — but the agent needs it for a simpler reason: the way out of each operation is different, and rule 8 depends on it.

## Rule 2 — Preview before you apply

`gitwand_preview_merge` is side-effect-free: no working tree, index or HEAD changes. It returns a risk level — `high` if any file has conflicts and none resolved, or one side deleted it; `medium` if a file is only partly resolved; `low` otherwise — plus per-file counts.

Two details change how an agent should read it:

- In `merge` mode (the default) it analyses the conflicts **already on disk**. It does not simulate a merge you have not started. In `rebase` and `cherry-pick` modes it does simulate, by running `git merge-file` on blobs in memory, before anything starts.
- For the exact number of hunks that would be written, `gitwand_resolve_conflicts` with `dry_run: true` runs the full resolution and writes nothing. That is the preview to show a human before the real call.

The rule is not "always call the preview tool". It is: **no write the human has not been able to see coming.** An agent that says "10 of 12 hunks resolve automatically, 2 in `src/api/users.ts` need a decision" before acting gives the person a chance to say "stop".

## Rule 3 — Let a deterministic resolver go first, and report what it decided

Before the model reasons about anything, `gitwand_resolve_conflicts` applies the patterns that are not decisions: the same change on both sides, a change on one side only, non-overlapping edits, and the rest of the [taxonomy](/blog/trivial-conflicts-taxonomy). The point is not speed. It is that the same input gives the same output, and every hunk comes back with a type, a plain-language explanation, a confidence score with its dimensions, and a `DecisionTrace` of the steps that led there.

That gives the agent something it does not otherwise have: a reason it can repeat. The rule that follows from it is that the agent's summary must carry those reasons, not just "resolved 10 conflicts". A human reviewing "`one_side_change`, labelled `certain`: only theirs modified the block, ours kept the base" can check that in five seconds. A human reviewing "I merged both versions" cannot.

## Rule 4 — Set the confidence bar explicitly

Every tool that resolves or predicts takes `min_confidence_score`, 0 to 100. Three properties matter to an agent:

- **It can only subtract.** The bar is combined with the policy's label gate, never instead of it. No value makes GitWand apply *more* than it would with the bar off — including for `complex` hunks, which score 60 and would otherwise slip under any lower bar. The [v3.11 article](/blog/v3-11-three-outcomes-not-two) explains why that is structural.
- **Precedence is argument, then `.gitwandrc`'s `minConfidenceScore`, then no bar.** An out-of-range value is dropped, not clamped — so an agent that passes `150` gets the repo's setting, not 100. Pass a valid number or none.
- **The policy is separate, and the MCP server does not read it from `.gitwandrc`.** `gitwand_resolve_conflicts` takes `policy` as an argument (`prefer-theirs` by default; `prefer-safety` skips whitespace and value-only hunks; `strict` keeps only the three most obvious patterns). If the repository declares a policy, read `gitwand://repo/policy` and pass it explicitly.

For an agent working unattended on a shared branch, a sensible starting point is `policy: "prefer-safety"` with a bar of 90 and above. You will get more pending hunks. That is the bar doing its job.

## Rule 5 — Explain before you guess

For each pending hunk, `gitwand_explain_hunk` returns the classification steps, the score's dimensions, its boosters and penalties, and the ours, theirs and base text. It does not resolve anything — `resolved` is always `false` there — it tells you why the engine stopped.

That is the input an agent should reason from. A `complex` hunk whose trace shows both sides changing the same lines relative to the base is a real decision. A hunk whose trace says `hasBase: false` may not be: without the base section, "one side changed" and "both sides changed" look identical, and the fix is to redo the conflict with `merge.conflictStyle diff3` (or `zdiff3`), not to have a model guess.

## Rule 6 — When the agent writes, write through the door that validates

There are two ways for an agent's own resolution to reach disk, and they are not equivalent:

- `gitwand_resolve_hunk_llm` replaces the block, then checks the answer for residual conflict markers and, for JSON files, parses the whole file once no other hunk remains in it. It supports `dry_run`, returns an audit record, and refuses to write if a check fails.
- `gitwand_apply_resolution` replaces the block and writes. No validation. It reports how many conflicts remain in the file afterwards, and that is all.

Use the first, with `dry_run: true` before the real call. Be clear about what the check is: a pass/fail gate scored 0 or 100, not a grade of the merge's correctness. It catches the mechanical failures — markers pasted back in, a broken JSON file — not a wrong decision.

`gitwand_resolve_hunk` is easy to misread: it calls no model. It formats a prompt from base, ours and theirs, with constraints (no markers, valid for the file's format, don't invent unrelated code), and the agent that called it answers. It is a way of making the agent reason from the three versions instead of from the markers.

## Rule 7 — Never continue with a residual

`gitwand_resolve_conflicts` returns `allResolved` and a `remaining` count; both write tools return `remainingConflicts` for the file. The agent continues only when every conflicted file is at zero — not when the build passes, not when the hunk it was working on is done.

Since the server never stages, the sequence is the agent's: `git add` the resolved files, check `git diff --cached --check` (Git reports leftover conflict markers there), then continue. If anything is still pending, the agent stops and hands over (rule 9). Continuing past a residual is how a marker ends up in a commit, or a half-merged function compiles and ships.

## Rule 8 — Never abort for the human

An abort throws away every resolution made since the operation started, including the ones a person did by hand, and no snapshot gives them back. The MCP server has no abort tool for that reason; the desktop app asks before any abort that would discard resolution work.

So an agent should not run `git merge --abort`, `git rebase --abort` or `git cherry-pick --abort` on its own initiative. Not when it is stuck, not when the tests fail, not to "start clean". Stuck is a reason to stop and ask.

The other half of this rule is reading outcomes correctly. After `git rebase --continue`, the operation can complete, halt on the next conflicting commit, or fail. A halt is progress, not an error: go back to rule 1. Treating it as failure is exactly what tempts an agent to abort. The [v3.11 article](/blog/v3-11-three-outcomes-not-two) is about that distinction.

## Rule 9 — Stop loudly, with the context a human needs

When the agent stops, the handover should be specific: file, line, the type GitWand assigned, its explanation, and why it declined — label gate, score bar, or a file deleted on one side (the rebase and cherry-pick previews mark those `addDelete`, "requires manual decision"). Plus what the agent would do and why, clearly labelled as a proposal.

"I could not resolve some conflicts" makes the human redo the whole investigation. "`src/api/users.ts:142`, `complex`, both sides changed the return expression differently; I would keep theirs because ours' `generateId()` was removed upstream, not applied" lets them decide in one read.

---

## The rules, in a form an agent can follow

This block can go in a `CLAUDE.md` or `AGENTS.md` as it is:

```markdown
## Merge conflicts (GitWand MCP)
- Start with gitwand_status. Know which operation is in progress (merge, rebase, cherry-pick, revert).
- Before writing anything, run gitwand_resolve_conflicts with dry_run: true and tell me what it will do.
- Pass min_confidence_score explicitly (90 unless I say otherwise). Read gitwand://repo/policy and pass its policy.
- For pending hunks, call gitwand_explain_hunk before proposing anything.
- Write your own resolutions with gitwand_resolve_hunk_llm (dry_run first), never gitwand_apply_resolution.
- Continue only when every conflicted file reports zero remaining and `git diff --cached --check` is clean.
- Never run merge/rebase/cherry-pick/revert --abort. If stuck, stop.
- When you stop, list file, line, type, GitWand's explanation, and your proposal — unapplied.
```

---

## What we found in our own server while writing this

Checking each rule against the code turned up four things that do not match how we had been describing the server. None of them makes an agent apply something wrong without saying so, but an agent author should know them.

- **`rebase` and `cherry-pick` previews are pessimistic.** They classify the simulated hunks without running the resolution, so every conflicting hunk counts as remaining and any conflicting file reads as `high` risk. The error is in the safe direction, but the counts are not comparable with `merge` mode. Fixing this is now on our list.
- **`gitwand_apply_resolution` does not validate.** An earlier post said it did. It does not, which is why rule 6 says to use the other tool.
- **YAML is not syntax-checked by `gitwand_resolve_hunk_llm`.** Only JSON is. The core engine validates YAML on its own resolutions; the MCP write path does not.
- **An empty resolution is rejected by both write tools.** When the right answer is to remove the block entirely, the agent has to edit the file itself — and then rules 7 and 9 apply to that edit like any other.

The rules above do not depend on these being fixed. They are what keeps an agent safe with the server as it ships today: preview, let the deterministic part go first, write through the validating door, and leave the two irreversible moves — continuing past a residual and aborting — out of the agent's hands unless a person says otherwise.
