---
title: "The conflicts you resolve by hand that were never decisions: a taxonomy"
description: "A field guide to the merge conflict hunks that look like work but aren't, taken from the patterns GitWand's engine actually implements. One example hunk per type, why each resolution is safe, and the exact point where GitWand stops and hands the hunk back to you."
date: 2026-11-02
head:
  - - meta
    - property: og:title
      content: "The conflicts you resolve by hand that were never decisions: a taxonomy"
  - - meta
    - property: og:description
      content: "Same change, one side changed, deletions, non-overlapping edits, whitespace, reordering, pure insertions, volatile values, imports and lockfiles: an example hunk for each, why it is safe, and what GitWand refuses to touch."
---

# The conflicts you resolve by hand that were never decisions: a taxonomy

A merge conflict is Git saying "I could not decide". It is not Git saying "there is a decision here". Those are different statements, and a good share of the hunks people open a merge editor for fall in the gap between them: Git gave up, but once you read the three versions there was only ever one sensible answer.

This article is a catalogue of those hunks. It is not a list of ideas. Each entry is a pattern that exists in GitWand's engine today (`packages/core`, the `ConflictType` union and the pattern registry), with an example hunk, what the engine does with it, why that is safe, and the conditions under which it stops and leaves the hunk to you. Every example below was run through the engine as it ships in 3.12.4, with default settings, and the outcome reported is what it returned.

If you want the engine's internals (the registry, priorities, the composite confidence score), they are in [How I built automatic merge conflict resolution](/blog/automatic-merge-conflict-resolution). If you want the ways it can be wrong, they are in [the failure-mode catalogue](/blog/auto-merge-failure-modes). This one sits between the two: what the patterns look like from the side of the person staring at the markers.

---

## Two things to know first

**Most of this needs the base.** The examples use the `diff3` marker style, with the common ancestor between `|||||||` and `=======`. Without it, "one side changed" and "both sides changed" look identical, and several patterns below cannot run at all. If you have not turned it on, [Reading a Git conflict marker](/blog/reading-git-conflict-markers) explains the one config line (`merge.conflictStyle zdiff3`). The desktop app rebuilds the base from Git's index when the markers lack one; the CLI and the MCP server read the markers on disk as they are.

**Classifying is not applying.** Every hunk gets a type and a confidence score from 0 to 100, mapped to a label: `certain` (92 and up), `high` (68 and up), `medium` (44 and up), `low`. The default policy, `prefer-theirs`, applies a resolution only when the label is at least `high`. Several entries below are recognised but deliberately not applied; that is noted each time.

---

## 1. Same change on both sides — `same_change`

```
<<<<<<< HEAD
const TIMEOUT_MS = 5000;
||||||| base
const TIMEOUT_MS = 3000;
=======
const TIMEOUT_MS = 5000;
>>>>>>> feature
```

Both branches made the identical edit. Resolution: keep it, once. Score 100.

**Why it is safe.** The check is string equality between ours and theirs. There is nothing to choose between, so there is nothing to lose. It does not even need the base.

**Where it stops.** Nowhere, by construction: if the two sides differ by a single character, this pattern does not match and the hunk moves on down the list.

Git's own three-way merge usually settles this shape, and the next two, before you ever see markers. The engine checks them first anyway, because they cost nothing and because it reads whatever markers are on disk, not the merge that wrote them.

## 2. Only one side changed — `one_side_change`

```
<<<<<<< HEAD
const RETRIES = 2;
||||||| base
const RETRIES = 2;
=======
const RETRIES = 3;
>>>>>>> feature
```

Ours is byte-identical to the base, so only theirs made a change. Resolution: take theirs (or ours, in the mirror case). Score 100.

**Why it is safe.** Taking the changed side is exactly what a three-way merge means. The untouched side expressed no intent about these lines.

**Where it stops.** Without a base, it does not run. The same hunk in the default two-section style has no way to say which side is the original: the engine classifies it `complex` (score 60) and leaves it alone.

## 3. Deleted on one side, untouched on the other — `delete_no_change`

```
<<<<<<< HEAD
||||||| base
export function legacyLogin() {
  return oldAuth();
}
=======
export function legacyLogin() {
  return oldAuth();
}
>>>>>>> feature
```

Ours removed the function; theirs left it exactly as the base had it. Resolution: delete. Score 100.

**Why it is safe.** The other side made no claim on these lines. The deletion is the only change, so it wins, by the same logic as the previous entry.

**Where it stops.** If the surviving side edited the block at all, this is no longer a delete-versus-nothing; it is a delete-versus-edit, which is a real decision, and it falls through to `complex`. Without a base, "one side is empty" is weaker evidence: the engine still recognises it but scores it 48 (`medium`), below the default bar, so it is proposed, not applied.

## 4. Edits to different lines of the same hunk — `non_overlapping`

```
<<<<<<< HEAD
export const config = {
  timeout: 5000,
  retries: 3,
};
||||||| base
export const config = {
  timeout: 3000,
  retries: 3,
};
=======
export const config = {
  timeout: 3000,
  retries: 5,
};
>>>>>>> feature
```

Ours changed `timeout`, theirs changed `retries`. Git grouped them into one hunk because the lines are adjacent. Resolution: a line-level three-way merge of the hunk against its base, giving `timeout: 5000` and `retries: 5`. Score 80 (`high`).

**Why it is safe.** No line was changed by both sides. Each change is kept exactly as its author wrote it.

**Where it stops.** The moment both sides touch the same line, the three-way merge reports an overlap and the pattern does not match. It also scores lower than the previous three on purpose: two edits to different lines can still contradict each other in meaning (one side renames a variable, the other adds a use of the old name). That is a semantic conflict no line-based merge sees, which is why `non_overlapping` is one of the types the `strict` policy switches off.

## 5. Whitespace only — `whitespace_only`

```
<<<<<<< HEAD
function sum(a, b) {
    return a + b;
}
||||||| base
function sum(a, b) {
  return a+b;
}
=======
function sum(a, b) {
	return a + b;
}
>>>>>>> feature
```

After normalising tabs, trimming each line and collapsing runs of spaces, both sides are the same code. Resolution: take the side the policy prefers (theirs, by default). Score 89.

**Why it is safe.** In most languages, indentation and spacing between tokens do not change what the code does, and both sides agree on everything else.

**Where it stops.** Whitespace inside string literals is data, not layout: `"hello  world"` and `"hello world"` are different values. The pattern compares quoted segments exactly, so that hunk is classified `complex` and left alone.

The honest limit is the other one. The normalisation trims leading whitespace on every line, in every file type. In Python, YAML or a Makefile, indentation *is* meaning, and the engine does not special-case those languages. We checked: a Python hunk where one side dedents a `return` out of an `if` block is classified `whitespace_only` and, under the default policy, applied. If your repository has indentation-sensitive files, turn this pattern off for them in `.gitwandrc`:

```json
{
  "patterns": {
    "*.py": "prefer-safety",
    "*.yml": "prefer-safety"
  }
}
```

`prefer-safety` skips `whitespace_only` (and `value_only_change`, below) for matching files. The CLI's `--no-whitespace` turns it off everywhere.

## 6. Same lines, different order — `reorder_only`

```
<<<<<<< HEAD
alpha
charlie
bravo
||||||| base
alpha
bravo
charlie
delta
=======
charlie
bravo
alpha
>>>>>>> feature
```

Both sides contain exactly the same lines, in a different order. Resolution: take theirs' order, or ours when the base already matches theirs (meaning ours is the side that reordered). Score 88.

**Why it is safe.** No line is added, dropped or edited. The comparison is a multiset comparison, so duplicated lines are counted, not collapsed.

**Where it stops.** It works on whole lines only. Reordering items *within* a line (`["search", "billing"]` versus `["billing", "search"]`) is not a permutation of lines and lands in `complex`. Duplicate lines make the ordering ambiguous, so they cost 10 points of confidence. And order can carry meaning (middleware, CSS cascade, migration lists): the pattern guarantees no content is lost, not that either order is right.

## 7. Both sides only added lines — `insertion_at_boundary`

```
<<<<<<< HEAD
  { path: "/", component: Home },
  { path: "/billing", component: Billing },
||||||| base
  { path: "/", component: Home },
=======
  { path: "/", component: Home },
  { path: "/audit", component: Audit },
>>>>>>> feature
```

Each branch appended a route at the same spot. A line merge cannot place two insertions at one point, so this is a conflict for Git. Resolution: the base, then ours' insertions, then theirs'. Score 92 (`certain`).

**Why it is safe.** Neither side removed or edited anything that was in the base, so the union keeps everything both authors wrote.

**Where it stops.** Any deletion or modification on either side disqualifies it. Without a base it falls back to a stricter heuristic (one side must be a subset of the other) at reduced confidence. And "ours first" is a convention, not knowledge: if the order of the inserted lines matters, check it.

## 8. Only volatile values differ — `value_only_change`

```
<<<<<<< HEAD
export const VERSION = "3.12.4";
||||||| base
export const VERSION = "3.12.2";
=======
export const VERSION = "3.13.0";
>>>>>>> feature
```

Both sides changed the same value, and the line is otherwise identical. The engine compares token by token; every differing token must look volatile: a hex hash, a UUID, a semantic version, an ISO timestamp, a URL. Resolution depends on what the value is:

- **Two comparable versions:** the higher one wins (`3.13.0` here). Score 83.
- **Hashes and other non-version values:** the side the policy prefers.
- **Two versions that cannot be ordered** (`13.x-dev` against `12.54.1`): this is a release decision, not volatility. When GitWand knows which branch is the merge target (the CLI and the desktop app detect it), the target keeps its value; when it does not, the hunk is proposed, not applied.

**Why it is safe.** The structure of the line is identical on both sides; only an identifier differs, and identifiers of this kind are usually produced by tools, not by intent.

**Where it stops.** If more than 30% of the tokens differ, or if a single differing token is not volatile, it is not this pattern. And "volatile" is pattern-matching, not understanding: a hard-coded hash that you meant to pin is indistinguishable from one a tool regenerated. That is why `prefer-safety` and `strict` both turn this pattern off.

## 9. Import blocks — the imports resolver

Imports are not a `ConflictType` of their own; they go through a format-aware resolver for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` files, which runs when the whole hunk is import statements:

```
<<<<<<< HEAD
import { ref } from "vue";
import { useAuth } from "./auth";
||||||| base
import { ref } from "vue";
=======
import { ref } from "vue";
import { useBilling } from "./billing";
>>>>>>> feature
```

Resolution: parse the three versions into statements, take the base plus what each side added, and emit the merged block. Here: `ref`, `useAuth` and `useBilling`, all kept.

**Why it is safe.** Two branches each needing a new import is the single most common shape of "conflict at the top of the file", and an import added by one side never cancels an import added by the other.

**Where it stops.** When both sides import the same module in different ways, the import resolver declines, because that is a real choice. When that happens with two differently-shaped imports of the same module that declare the same name (`import { useAuth } from "./auth"` on one side, `import useAuth from "./auth"` on the other), the hunk is classified `complex` and left to you. *Update, November 2026:* this was a known gap when the article was written: the hunk went on to the line patterns, which kept both lines as an `insertion_at_boundary` and produced a duplicate binding. v3.12.5 fixed it. Two imports of the same module that bind different names (`import React` and `import { useState }`) are still both kept.

## 10. Lockfiles and other generated files — declined by default

```
<<<<<<< HEAD
      "version": "4.17.21",
||||||| base
      "version": "4.17.20",
=======
      "version": "4.17.22",
>>>>>>> feature
```

This hunk, in `package-lock.json`, looks exactly like entry 8. GitWand does not merge it. Files it recognises as generated (npm, yarn, pnpm, Composer, Bundler and Cargo lockfiles, `.min.js`, `dist/` and a few build manifests, plus anything you add in `.gitwandrc`) are not merged by default: the reason returned is that the file should be regenerated, not merged.

**Why.** A lockfile is the output of a resolver, not a text two people wrote. A textual merge of two lockfiles can be syntactically perfect and describe a dependency tree no package manager would ever produce. The engine still allows the four patterns that cannot invent anything (same change, one side changed, deletion, whitespace), and declines the rest.

**What it does instead.** For npm, pnpm, Yarn Berry, Composer and Cargo, it attaches a regeneration plan: the lockfile-only command (`npm install --package-lock-only --ignore-scripts`, for example) and the source of truth that must be clean first (`package.json`). `gitwand resolve --regenerate` runs it, in a separate git worktree, only once that source is clean or resolved. `--resolve-generated` exists if you want the old take-theirs behaviour, but it is opt-in for a reason. The details per package manager are in [package-lock.json merge conflicts](/fix/package-lock-json-merge-conflict).

---

## What GitWand will not touch

The taxonomy has a floor, and it matters as much as the entries above.

- **`complex` is never resolved.** If nothing above matches, the hunk is a real conflict and it goes to you. There is no setting that changes this.
- **Token-level merges are proposals.** When both sides changed the same line but different tokens of it (`timeout: 5000` on one side, `retries: 4` on the other, inside one `createClient(...)` call), the engine computes a merged line and classifies it `token_level_merge`. It never applies it on its own; the desktop app shows it for you to confirm.
- **Anything below the bar stays put.** The default bar is the `high` label. A numeric bar, `minConfidenceScore` (or `--min-confidence-score=N` on the CLI), can be added on top; it can only ever remove hunks from what is applied, never add them.
- **The LLM fallback and refactoring-aware merge are off by default.** Both exist (`llm_proposed`, `refactoring_aware_merge`), both are opt-in, and neither changes anything in this list unless you turn it on.

## Trying it on your own conflicts

The same engine runs in the desktop app, the CLI and the MCP server. From a repository with conflicts, without writing anything:

```bash
npx @gitwand/cli resolve --dry-run --verbose
```

`--verbose` prints each hunk's type, score and reason, which is the quickest way to see which of the entries above your conflicts actually are. Drop `--dry-run` to apply what clears the bar; `--ci` gives JSON and a non-zero exit code when hunks remain. Options are in the [CLI guide](/guide/cli).

For coding agents, `npx @gitwand/mcp` exposes the engine as an MCP server. `gitwand_resolve_conflicts` applies what is provably trivial, and `gitwand_explain_hunk` returns the classification and the three versions of a single hunk, so the agent reasons from the base instead of guessing from two blocks of text. Setup is in the [MCP guide](/guide/mcp).

The point of the taxonomy is not that these hunks are rare. It is that each of them has a check you can state in one sentence, and a resolution that follows from the check. When a hunk passes no such check, the right tool is still a person.
