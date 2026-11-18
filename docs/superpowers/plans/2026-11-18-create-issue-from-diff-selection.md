# Create an issue from a diff selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** select a range of lines in a commit diff or a PR diff and open PR 1's issue form prefilled with a permalink, a `diff` block and where the lines come from; Shift+click also turns PR comments into multi-line comments.

**Architecture:** pure prefill helpers in `utils/issuePrefill.ts`; `useCreateIssue` gains `openFromSelection`, an `activeSelection` the diff views register, and `openFromShortcut` (⌘⇧I uses the selection when there is one). `CommitDiffViewer` gets a click / Shift+click selection on line numbers with a "Create issue" button; `PrInlineDiff` gets Shift+click to extend its compose box to a range. Frontend only: no Rust, no dev-server route.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Vitest (jsdom for component tests).

**Spec:** `docs/superpowers/specs/2026-11-18-create-issue-from-diff-selection-design.md` (PR 1: `docs/superpowers/specs/2026-11-17-create-github-issue-design.md`).

## Global Constraints

- Issue text is fixed English (other people read it), like `commitIssuePrefill`.
- Every user-visible UI string in all 5 locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`).
- No link that answers 404: a commit's permalink only when `commitOnOrigin` says origin has it.
- Fence longer than any backtick run in the content; at most 200 lines in the block.
- Selection never spans two hunks.
- Entry points only when `createIssue.available` (GitHub `origin`), like PR 1.
- No `{ deep: true }` watcher on diff data (perf invariants, `apps/desktop/CLAUDE.md`).

## Review Focus

1. A selection made only of deleted lines: old-side permalink (commit: first parent; PR: none, no base SHA) — tested in Task 1.
2. Shift+click in another hunk or another file: starts a new selection instead of spanning — tested in Tasks 3 and 4.
3. The diff changes under a live selection (another commit selected, another PR file): the selection and `activeSelection` are cleared — tested in Tasks 3 and 4.
4. A path with spaces, `#` or non-ASCII: permalink segments encoded, `/` kept — tested in Task 1.
5. Typing in the PR compose box then Shift+clicking: the text is kept — tested in Task 4.

---

### Task 1: Selection prefill helpers

**Files:**
- Modify: `apps/desktop/src/utils/issuePrefill.ts`
- Test: `apps/desktop/src/utils/__tests__/issuePrefill.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DiffSelection {
    path: string;
    /** Selected rows, in diff order, all from one hunk. */
    lines: DiffLine[];
    source:
      | { kind: "commit"; hash: string; hashFull: string; parent: string | null }
      | { kind: "pr"; number: number; url: string; headSha: string | null };
    /** Text typed before (the PR compose box): starts the body. */
    intro?: string;
  }
  export interface LineSpan { side: "old" | "new"; from: number; to: number }
  export function permalinkSpan(lines: DiffLine[]): LineSpan | null;
  export function blobPermalink(repoHtmlUrl: string, sha: string, path: string, span: LineSpan): string;
  export function selectionIssuePrefill(sel: DiffSelection, links: { permalink: string | null; commitUrl: string | null }): IssuePrefill;
  export const SELECTION_MAX_LINES = 200;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const add = (n: number, c: string): DiffLine => ({ type: "add", content: c, newLineNo: n });
const del = (n: number, c: string): DiffLine => ({ type: "delete", content: c, oldLineNo: n });
const ctx = (o: number, n: number, c: string): DiffLine => ({ type: "context", content: c, oldLineNo: o, newLineNo: n });

it("spans the new side unless every line is a deletion", () => {
  expect(permalinkSpan([ctx(9, 10, "a"), del(10, "b"), add(11, "c")])).toEqual({ side: "new", from: 10, to: 11 });
  expect(permalinkSpan([del(4, "x"), del(5, "y")])).toEqual({ side: "old", from: 4, to: 5 });
  expect(permalinkSpan([])).toBeNull();
});

it("builds a blob permalink, one line or a range, path segments encoded", () => {
  expect(blobPermalink("https://github.com/o/r/", "abc", "src/a b#c/é.ts", { side: "new", from: 3, to: 3 }))
    .toBe("https://github.com/o/r/blob/abc/src/a%20b%23c/%C3%A9.ts#L3");
  expect(blobPermalink("https://github.com/o/r", "abc", "x.ts", { side: "new", from: 3, to: 7 }))
    .toBe("https://github.com/o/r/blob/abc/x.ts#L3-L7");
});

it("writes the permalink, a diff block and the origin of the lines", () => {
  const sel: DiffSelection = {
    path: "src/x.ts",
    lines: [ctx(9, 10, "a"), del(10, "b"), add(11, "c")],
    source: { kind: "commit", hash: "abc1234", hashFull: "abc1234ffff", parent: "p" },
  };
  expect(selectionIssuePrefill(sel, { permalink: "https://g/o/r/blob/abc/src/x.ts#L10-L11", commitUrl: "https://g/o/r/commit/abc1234ffff" })).toEqual({
    title: "",
    body: "https://g/o/r/blob/abc/src/x.ts#L10-L11\n\n```diff\n a\n-b\n+c\n```\n\n`src/x.ts` lines 10–11, commit [`abc1234`](https://g/o/r/commit/abc1234ffff)\n",
  });
});

it("without links: no permalink line, the full SHA unlinked", () => {
  const sel: DiffSelection = { path: "x.ts", lines: [add(3, "c")], source: { kind: "commit", hash: "abc1234", hashFull: "abc1234ffff", parent: null } };
  expect(selectionIssuePrefill(sel, { permalink: null, commitUrl: null }).body)
    .toBe("```diff\n+c\n```\n\n`x.ts` line 3, commit `abc1234ffff`\n");
});

it("a PR selection names the pull request and starts with the typed text", () => {
  const sel: DiffSelection = { path: "x.ts", lines: [add(3, "c")], intro: "Looks wrong", source: { kind: "pr", number: 12, url: "https://github.com/o/r/pull/12", headSha: "h" } };
  expect(selectionIssuePrefill(sel, { permalink: null, commitUrl: null }).body)
    .toBe("Looks wrong\n\n```diff\n+c\n```\n\n`x.ts` line 3, pull request [#12](https://github.com/o/r/pull/12)\n");
});

it("fences past backtick runs and caps the block at 200 lines", () => {
  const ticks = selectionIssuePrefill({ path: "x", lines: [add(1, "```")], source: { kind: "pr", number: 1, url: "u", headSha: null } }, { permalink: null, commitUrl: null });
  expect(ticks.body.startsWith("````diff\n+```\n````\n")).toBe(true);
  const many = Array.from({ length: 250 }, (_, i) => add(i + 1, "x"));
  const body = selectionIssuePrefill({ path: "x", lines: many, source: { kind: "pr", number: 1, url: "u", headSha: null } }, { permalink: null, commitUrl: null }).body;
  expect(body.split("\n").filter((l) => l === "+x")).toHaveLength(SELECTION_MAX_LINES);
  expect(body).toContain("\n(first 200 of 250 lines)\n");
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd apps/desktop && npx vitest run src/utils/__tests__/issuePrefill.test.ts` → missing exports.

- [ ] **Step 3: Implement** in `issuePrefill.ts`: generalise the private `codeBlock(text)` to `codeBlock(text, lang = "text")`; `blobPermalink` encodes each `/`-separated path segment with `encodeURIComponent`, trims trailing `/` of the repo URL, `#L{from}` or `#L{from}-L{to}`; body = `[intro]\n\n` + `[permalink]\n\n` + block + optional `(first 200 of N lines)` line + `\n\n` + `` `path` `` + ` line N` / ` lines A–B` (en dash, from `permalinkSpan`, omitted when null) + `, ` + origin + `\n`. Diff rows render `+`/`-`/space + content.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit** — `feat(issues): prefill helpers for an issue from a diff selection (#301)`.

### Task 2: `openFromSelection`, `activeSelection`, `openFromShortcut`

**Files:**
- Modify: `apps/desktop/src/composables/useCreateIssue.ts`, `apps/desktop/src/App.vue` (`openNewIssue`)
- Test: `apps/desktop/src/composables/__tests__/useCreateIssue.test.ts`

**Interfaces:**
- Consumes: Task 1's `DiffSelection`, `permalinkSpan`, `blobPermalink`, `selectionIssuePrefill`; PR 1's `open(prefill fn)`, `commitOnOrigin`, `commitUrlFor`.
- Produces on `CreateIssueApi`:
  ```ts
  /** The selection a diff view currently shows, if any (⌘⇧I uses it). */
  activeSelection: Ref<DiffSelection | null>;
  openFromSelection(sel: DiffSelection): Promise<void>;
  /** ⌘⇧I / palette: from the active selection when there is one. */
  openFromShortcut(): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests** (same harness as the existing `openFromCommit` tests):
  - commit on origin → body starts with `${origin}/blob/<hashFull>/<path>#L…` and contains `commit [\`abc1234\`](${origin}/commit/<hashFull>)`;
  - commit on origin, deletions only → permalink uses `parent`; `parent: null` → no permalink line;
  - commit not on origin → no `/blob/` and no `/commit/` in the body;
  - PR → permalink on `https://github.com/o/r/blob/<headSha>/…` (PR URL minus `/pull/12`), deletions only → no permalink; URL not matching `/pull/N` → no permalink;
  - `openFromShortcut` with `activeSelection` set → body has the selection's block; with `null` → empty form;
  - an open dirty form is left as is (same rule as `openFromCommit`).

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** `openFromSelection` mirrors `openFromCommit` (available check, dirty form wins, start the origin check before `open`); the PR repo URL is `url.replace(/\/pull\/\d+\/?$/, "")` only when that pattern matched. App's `openNewIssue` calls `createIssue.openFromShortcut()`.

- [ ] **Step 4: Run, verify PASS;** `npx vue-tsc --noEmit -p apps/desktop` clean.

- [ ] **Step 5: Commit** — `feat(issues): open the issue form from a diff selection (#301)`.

### Task 3: Selection in the commit diff

**Files:**
- Modify: `apps/desktop/src/components/CommitDiffViewer.vue`; locales `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`
- Test: `apps/desktop/src/components/__tests__/CommitDiffViewer.selection.test.ts` (jsdom)

**Interfaces:**
- Consumes: `inject(CREATE_ISSUE_KEY, null)`; Task 2's `activeSelection`, `openFromSelection`.
- Produces: locale keys `createIssue.fromSelection` ("Create issue from these lines"), `createIssue.selectionHint` ("Shift+click a line number to extend the selection").

- [ ] **Step 1: Write the failing tests** (mount with `provide(CREATE_ISSUE_KEY, fake)` where `fake.available = ref(true)`):
  - click new-line number of row 2 → that row gets `cdv-line--selected`, `fake.activeSelection.value.lines` is that row, source `{ kind: "commit", hashFull, parent: parents[0] }`;
  - Shift+click row 4 of the same hunk → rows 2–4 selected; Shift+click in another hunk → only that row;
  - side-by-side: left numbers select old-side lines only;
  - Escape → nothing selected, `activeSelection` null; changing `commitHash` → same; unmount → `activeSelection` null;
  - the "Create issue" button calls `openFromSelection` with the selection; absent when `available` is false or no provider.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** State `{ fileIdx, hunkIdx, anchor, focus, side: "old" | "new" | "row" }` (row = inline); selected lines = `hunk.lines` (inline) or the pairs' `left`/`right` (side-by-side) between anchor and focus, nulls dropped. Line-number cells get `cursor: pointer` and `@click`; the button sits in the hunk header row of the selected hunk. Register into `activeSelection` on change; clear on Escape (keydown on the viewer root, `tabindex="-1"`), on `commitHash` / `diffs` change and in `onBeforeUnmount` (only if it is still this view's selection).

- [ ] **Step 4: Run, verify PASS;** `npx vue-tsc --noEmit` clean (each locale is typed `Locale` from `en.ts`, so a missing key fails there).

- [ ] **Step 5: Commit** — `feat(issues): select lines in a commit diff to file an issue (#301)`.

### Task 4: Range in the PR diff (comments and issue)

**Files:**
- Modify: `apps/desktop/src/components/PrInlineDiff.vue`, `apps/desktop/src/components/PrDetailView.vue` (pass `pr-url`, `head-sha`); locales (`pr.inline.createIssue` = "Create issue")
- Test: `apps/desktop/src/components/__tests__/PrInlineDiff.test.ts`

**Interfaces:**
- Consumes: Task 2's API; existing `openCompose`, `buildComposeParams`, `CommentParams`.
- Produces: props `prUrl?: string; headSha?: string`.

- [ ] **Step 1: Write the failing tests:**
  - click line 3 number, type "x", Shift+click line 6 (same hunk) → compose under line 6, text still "x", rows 3–6 highlighted, Comment emits `create-comment` with `line: 6, start_line: 3, start_side: "RIGHT"`;
  - Shift+click before the compose line → same range, compose stays at the later row;
  - Shift+click in another hunk → plain new compose there, no `start_line`;
  - "Create issue" (only when `prUrl` and a provider with `available`) calls `openFromSelection` with rows 3–6, `intro: "x"`, source `{ kind: "pr", number, url: prUrl, headSha }`, and closes the compose box;
  - closing the compose box clears `activeSelection`; changing `filePath` clears it.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** `extendCompose(hunkIdx, lineIdx, dl)`: same hunk as the open compose → `selectionStart` = earlier row's `{line, side}`, compose moves to the later row, text kept; otherwise `openCompose`. Line-number `@click` passes the event and calls `extendCompose` on `shiftKey`. Fix `buildComposeParams` to use `selectionStart.line` as is (it is now always the earlier row). Highlight rows between the two. Button in both compose templates (inline and side-by-side), disabled-free (an issue needs no text). Register `activeSelection` while the compose box is open.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit** — `feat(pr): Shift+click a range for comments and issues in the PR diff (#301)`.

### Task 5: Changelog, help, whole suite

**Files:**
- Modify: `CHANGELOG.md` (Unreleased › Added), `apps/desktop/src/components/HelpView.vue` (one shortcut line: Shift+click a line number → extend the selection), locales for that line.

- [ ] **Step 1:** CHANGELOG entry: lines selected in a commit or PR diff → issue with permalink and block; PR comments can now cover a range.
- [ ] **Step 2:** `cd apps/desktop && npx vitest run > $TMPDIR/vt.log 2>&1; tail $TMPDIR/vt.log` → all pass; `npx vue-tsc --noEmit` clean.
- [ ] **Step 3: Commit** — `docs: changelog and help for issues from a diff selection (#301)`.
