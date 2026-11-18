# Create an issue from a diff selection — design (issue #301, PR 2)

Follows [the #301 design](2026-11-17-create-github-issue-design.md) (PR 1, merged
as #304). Short design: a small change on top of PR 1's form.

## Why

The point of #301 is to file an issue without leaving what you are looking at,
with that context attached. PR 1 covered a whole commit. Most bugs spotted while
reading a diff are about a few lines: the issue should point at exactly those
lines, so whoever picks it up lands on them.

## Goals

- In a **commit diff** (`CommitDiffViewer`: Git Tree detail and History view)
  and a **PR diff** (`PrInlineDiff`), select a range of lines and open the
  PR 1 form prefilled with:
  - a GitHub permalink to those lines (`…/blob/<sha>/<path>#L10-L20`);
  - the selected lines in a `diff` code block (keeps the `+`/`-` seen);
  - where they come from: path, line range, commit or PR.
- Reachable from the selection itself (a button) and from ⌘⇧I / Ctrl+Alt+I
  while a selection exists.

## Non-goals

- The working-tree diff (`DiffViewer`), decided with the user: uncommitted lines
  have no permalink, and its line numbers already carry the partial-staging
  checkboxes.
- Any backend change: the form, targets and creation are PR 1's.
- Non-GitHub forges (same as PR 1: the entry points only appear when issue
  creation is available).

## Anti-goals

- No link that answers 404: a commit diff gets a permalink only when the commit
  is on `origin` (PR 1's `commitOnOriginWith`); otherwise the body names the
  full SHA unlinked and keeps the code block.
- No selection mechanism that fights the existing ones: the PR diff keeps its
  drag selection and compose box; the new commit-diff selection lives on the
  line numbers only and does not change scrolling, collapsing or text selection.

## Approaches (decided with the user: commit + PR)

- **Commit + PR — chosen.** Both have a permalink. Both get click /
  Shift+click on line numbers (the PR diff's promised drag selection turned out
  never to have been wired, see below).
- Commit only: smaller, PR diff later.
- All three views: adds the working tree, without a permalink and with a
  selection to reconcile with staging checkboxes.

## Design

### Selection

- **Commit diff (new):** click a line number to select that line; Shift+click
  another line number to extend; Escape or a click elsewhere clears it. Within
  one hunk of one file (a range across hunks would link hidden lines). Inline
  mode: either number column selects the row. Side-by-side: the left numbers
  select old-side lines, the right numbers new-side lines. Selected rows are
  highlighted; a small "Create issue" button appears beside the selection.
- **PR diff:** the "drag selection" its header comment promises was never wired
  (`selectionStart` is declared and read, never set): only one line can be
  commented today. Decided with the user: clicking a line number keeps opening
  the compose box on that line; **Shift+click** another line number of the same
  hunk extends it to the range, highlighted. The range applies to **both** the
  comment (sent as a GitHub multi-line comment through the existing
  `start_line` / `start_side` plumbing, Rust REST and dev-server alike) and a
  new "Create issue" action next to Comment; text already typed in the box
  becomes the start of the issue body.

### Which side the permalink points at

If every selected line is a deletion, the old side: the commit's first parent
(commit diff) or the PR's base (PR diff, the side `LEFT` in GitHub's own
terms). Otherwise the new side, with the range spanning the new line numbers of
the selected non-deleted lines. The permalink repository is `origin` for a
commit diff and the PR's own repository (from its URL) for a PR diff — the PR
may live on the parent of a fork. The PR side needs the base SHA: if the PR
detail does not carry one, the old-side case falls back to no permalink.

### Body

```
https://github.com/o/r/blob/<sha>/<path>#L10-L20

````diff
 context
-old
+new
````

`path` lines 10–20, commit [`abc1234`](…) | pull request #12
```

- Fixed English, like PR 1's commit prefill (other people read the issue).
- Path segments URL-encoded in the permalink; the fence longer than any
  backtick run in the code (PR 1's helper).
- At most 200 selected lines in the block, then a "(truncated)" line, to stay
  well under GitHub's 65 536-character body.
- Title left empty (focused): the selection has no natural title.

## Left to the builder

The button's exact placement and look, the highlight colour (from the existing
tokens), the helper names, and where the prefill builder lives (next to
`commitIssuePrefill` in `utils/issuePrefill.ts`).

## Calls I made (to check)

- Permalink and code block are both always present. When the issue is on the
  same repository, GitHub also renders the permalink as a snippet, so the code
  shows twice; the block is kept because a fork's parent gets no snippet and the
  block shows the `+`/`-`.
- Selection limited to one hunk.
- 200-line cap, empty title.
