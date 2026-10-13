---
title: "Reading a Git conflict marker: ours, theirs, base, diff3 and zdiff3"
description: "What each section of a Git conflict marker means, why the common-ancestor section added by diff3 and zdiff3 changes how you decide, how to turn it on, and how GitWand's engine uses that base to separate trivial hunks from real decisions."
date: 2026-10-13
head:
  - - meta
    - property: og:title
      content: "Reading a Git conflict marker: ours, theirs, base, diff3 and zdiff3"
  - - meta
    - property: og:description
      content: "Ours, theirs, and the section Git hides by default: the base. What each part of a conflict marker means, why zdiff3 is the better default, and how GitWand reads the base to classify hunks."
---

# Reading a Git conflict marker: ours, theirs, base, diff3 and zdiff3

A conflict marker is the only interface Git gives you for a merge conflict. Every GUI, every IDE merge editor, every AI agent that "resolves conflicts" is reading the same few lines of text that Git wrote into your file. So it is worth knowing exactly what those lines say — and, more importantly, what Git leaves out of them by default.

This is a reference, not a release note. Everything below was reproduced with Git 2.43 on a three-commit repository; the Git behaviour is cited from the official documentation, and the GitWand behaviour is checked against the engine's source.

---

## One conflict, three styles

Start from a tiny config file on a common ancestor:

```ts
export const config = {
  timeout: 3000,
  retries: 3,
};
```

On `main`, someone raises the timeout and adds two keys. On `feature`, someone raises the retries and adds the **same** two keys:

```ts
// main                          // feature
timeout: 5000,                   timeout: 3000,
retries: 3,                      retries: 5,
region: "eu-west-1",             region: "eu-west-1",
verbose: true,                   verbose: true,
```

Nobody disagrees about anything. One person changed `timeout`, the other changed `retries`, and both added identical lines. But the edits touch adjacent lines, and Git merges by lines, so `git merge feature` stops with a conflict. What you see in the file depends on one setting, `merge.conflictStyle`.

### `merge` (the default)

```text
export const config = {
<<<<<<< HEAD
  timeout: 5000,
  retries: 3,
=======
  timeout: 3000,
  retries: 5,
>>>>>>> feature
  region: "eu-west-1",
  verbose: true,
};
```

Two sections:

- **Between `<<<<<<<` and `=======` is _ours_** — the version on the branch you are on (`HEAD`).
- **Between `=======` and `>>>>>>>` is _theirs_** — the version coming in, labelled with the branch or commit name.

Git has already pulled the identical trailing lines (`region`, `verbose`) out of the conflict region, which keeps the hunk small. What it has not told you is what the code looked like *before* either branch touched it. Looking at this hunk, `timeout: 5000` versus `timeout: 3000` reads like a disagreement. You cannot see that `3000` is simply the old value.

### `diff3`

```text
export const config = {
<<<<<<< HEAD
  timeout: 5000,
  retries: 3,
  region: "eu-west-1",
  verbose: true,
||||||| 93f004a
  timeout: 3000,
  retries: 3,
=======
  timeout: 3000,
  retries: 5,
  region: "eu-west-1",
  verbose: true,
>>>>>>> feature
};
```

A third section appears between `|||||||` and `=======`: the **base**, the common ancestor's version of this region. The label after `|||||||` names it — here, the abbreviated merge-base commit.

Now the hunk explains itself. Compare each side to the base, line by line: ours changed `timeout` and left `retries` alone; theirs changed `retries` and left `timeout` alone. The answer is `timeout: 5000, retries: 5` — and you can *prove* it from the text, instead of guessing which value is newer.

The cost is visible too. The Git documentation notes that the default style "tends to produce smaller conflict regions than diff3", partly because it pulls lines that match on both sides out of the conflict ([git-config, `merge.conflictStyle`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-mergeconflictStyle)). With `diff3`, the duplicated `region` and `verbose` lines sit inside the markers on both sides, and you have to notice for yourself that they are identical.

### `zdiff3`

```text
export const config = {
<<<<<<< HEAD
  timeout: 5000,
  retries: 3,
||||||| 93f004a
  timeout: 3000,
  retries: 3,
=======
  timeout: 3000,
  retries: 5,
>>>>>>> feature
  region: "eu-west-1",
  verbose: true,
};
```

"Zealous diff3", added in Git 2.35. In the documentation's words, it "is similar to diff3 but removes matching lines on the two sides from the conflict region when those matching lines appear near either the beginning or end of a conflict region". You get the small hunk of the default style *and* the base of `diff3`. For reading conflicts, it is the best of the three.

## The four things a marker can tell you

Once the base is visible, every hunk falls into one of a few shapes, and most of them are not decisions:

| Ours vs base | Theirs vs base | What it means |
|---|---|---|
| unchanged | changed | Only theirs edited this region. Take theirs. |
| changed | unchanged | Only ours edited it. Take ours. |
| changed | changed, identically | Both made the same edit. Take either. |
| changed | changed, differently | A real decision — or, as above, edits to different lines that merely sit next to each other. |

Without the base, all four rows look the same: two blocks of text that differ. That is the whole argument for `diff3`/`zdiff3`. The base does not resolve anything on its own; it tells you *which question you are being asked*.

## Ours and theirs flip during a rebase

One trap worth knowing before you trust the labels. During `git merge`, *ours* is your branch. During `git rebase`, it is the other way round: Git replays your commits on top of the upstream, so — as the [git-rebase documentation](https://git-scm.com/docs/git-rebase) puts it — "the side reported as ours is the so-far rebased series, starting with `<upstream>`, and theirs is the working branch". Your own commit is *theirs*.

This is one more reason to read the base rather than the labels: "which side moved away from the ancestor" is a question with the same answer whatever the operation calls each side.

## Turning it on

For every repository on your machine:

```bash
git config --global merge.conflictStyle zdiff3
```

`zdiff3` needs Git 2.35 or later (`git --version`). On an older Git, use `diff3` — same base section, slightly larger hunks.

If you are already in the middle of a conflict written in the default style, you do not have to redo the merge. Git can rewrite the markers for a file from the index, where it keeps all three versions:

```bash
git checkout --conflict=zdiff3 -- path/to/file
```

`--conflict=<style>` overrides `merge.conflictStyle` for that checkout ([git-checkout](https://git-scm.com/docs/git-checkout)). Note that it rewrites the file from Git's three stored versions, so any manual edits you already made to that file are discarded.

Those three versions are also directly readable, which is handy when a marker is too large to follow: `git show :1:path/to/file` is the base, `:2:` is ours, `:3:` is theirs.

## How GitWand reads the base

GitWand's conflict engine (`@gitwand/core`) parses the markers into the same three sections — `oursLines`, `baseLines`, `theirsLines` — and treats `diff3` and `zdiff3` alike: both carry a `|||||||` section, and that is what the parser looks for. Each hunk is then classified against a registry of patterns, evaluated in priority order. The relevant detail is a field every pattern declares: `requires: "diff3" | "diff2" | "both"`.

Some patterns cannot be judged without a base, and declare it:

- **`one_side_change`** — one side is byte-identical to the base, the other is not. Without a base there is no way to know which side is the unchanged one.
- **`non_overlapping`** — both sides changed the region, but different lines of it, so a three-way merge of the hunk is clean.
- **`token_level_merge`** — a line-by-line, then token-by-token decomposition against the base. It is never applied automatically; it is a proposal for you to confirm.

When a hunk has no base section, those patterns are skipped, and the trace says so (`Base (diff3) unavailable: … requires diff3, skipped`). Others, like `same_change` (both sides identical) and `delete_no_change`, work with or without a base — though `delete_no_change` is scored lower without one, because "one side is empty" is weaker evidence than "one side is empty and the other equals the base". Anything that matches nothing lands in `complex`, which is never resolved automatically.

Run the engine on the example above and the difference is concrete. The default-style hunk is classified `complex` and left for a person. The `diff3` and `zdiff3` hunks are both classified `non_overlapping` and resolved to:

```ts
export const config = {
  timeout: 5000,
  retries: 5,
  region: "eu-west-1",
  verbose: true,
};
```

Same conflict, same engine. The only difference is whether Git wrote down the ancestor.

One correction, found while writing this article: up to GitWand 3.12.2, the `diff3` version kept the `region` and `verbose` lines twice. Both sides carry them inside the markers, and the merge treated them as two separate additions. The fix ([#259](https://github.com/devlint/GitWand/pull/259)) takes lines that open or close both sides out of the merge, as `zdiff3` does, and ships in the next release. Until then, `zdiff3` avoids it.

Where the base comes from depends on how you run GitWand:

- **The desktop app** recovers it for you. When a file's markers have no base section, it rebuilds the three-way conflict from Git's index so the base-dependent patterns can still run — unless the file was edited outside the markers since the conflict, in which case it keeps your working copy and classifies what is there.
- **The CLI and the MCP server** read the markers on disk as they are. If your repository uses the default style, they see no base, and the base-dependent patterns are skipped. Setting `merge.conflictStyle zdiff3` is the single most useful thing you can do for them.

To see this on your own conflicts, without writing anything:

```bash
npx @gitwand/cli resolve --dry-run --verbose
```

`--verbose` prints each hunk's type and explanation; drop `--dry-run` to apply the resolutions that clear the confidence gates. The [CLI guide](/guide/cli) lists the other options, including `--ci` for pipelines.

For coding agents, the same engine is exposed as an MCP server (`npx @gitwand/mcp`): `gitwand_resolve_conflicts` resolves what is provably trivial, and `gitwand_explain_hunk` returns the classification and the ours/base/theirs text for a single hunk, so the agent reasons over the base rather than guessing from two blocks of text. Setup is in the [MCP guide](/guide/mcp).

## What the base does not solve

A base makes trivial hunks visible. It does not make hard ones easy. When both sides rewrote the same lines differently, the base shows you where each started, and the decision is still yours. And a line-based three-way merge knows nothing about meaning: two edits to different lines can still break each other, which is why GitWand scores every resolution, refuses `complex` hunks, and logs why each pattern matched or did not. The known ways this goes wrong are catalogued in [How often does GitWand's auto-merge get it wrong?](/blog/auto-merge-failure-modes); the design of the pattern registry is in [How I built automatic merge conflict resolution](/blog/automatic-merge-conflict-resolution).

But if you change one thing after reading this, make it the config line. Every conflict you read from now on will tell you not just what the two sides say, but where they started.
