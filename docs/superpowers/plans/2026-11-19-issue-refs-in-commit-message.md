# Issue references in the commit message — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** typing `#` in the commit summary or description offers the
repository's open issues and inserts `#N` or `Fixes #N`. The "issue created"
toast gains an "Add to commit" action.

**Architecture:**
- The text logic is pure functions in `utils/issueRefs.ts`.
- `composables/useIssueSuggest.ts` holds the list state, a per-repository
  cache and the key handling, with its fetchers injected.
- `components/IssueSuggestList.vue` renders the list.
- `RepoSidebar.vue` wires the composable to its two fields. `App.vue` adds the
  toast action.
- There is no backend change: the forges' `listIssues` already exist.

**Tech stack:** Vue 3 `<script setup>`, TypeScript, vitest (jsdom opt-in).

**Spec:** `docs/superpowers/specs/2026-11-19-issue-refs-in-commit-message-design.md`

## Global constraints

- **Trigger:** `#` at the start of the field, or right after a space, a line
  break or `(`. Never after a letter or digit (`C#`, `abc#`).
- **Close:** on a space after the query, on Escape, on blur, or when the `#`
  is removed.
- **Filter:** digits match the number by prefix. Anything else matches the
  title, case-insensitively. At most 8 rows, the most recently updated first.
- **Keys:** Enter or Tab inserts `#N `. Shift+Enter inserts `Fixes #N `.
  Escape only closes the list. ↑/↓ move through the rows. Click works like
  Enter.
- **Hint row:** `↵ #N · ⇧↵ Fixes #N`.
- **Cache:** per repository, fetched again when older than 60 s (60_000 ms).
  Nothing is fetched before the first `#`.
- **Load failure:** a muted "Issues unavailable" row; the `#` stays as typed.
- **Forge without `listIssues`:** no list at all.
- **Toast:** the button appends ` #N` to the commit description (or sets `#N`
  when it is empty). Nothing is added if the reference is already in the
  message.
- **Qualified references:** an issue whose repository is not the push remote
  (`origin`) is written `owner/repo#N`. This applies to the toast and to the
  list.
- **i18n:** all 5 locales. `Fixes` and `#N` are git text and are not
  translated.
- **Escape:** the list's Escape must not reach App's global Escape ladder.

## Review focus

1. **IME composition** (`e.isComposing`): Enter confirms the composition and
   must not pick an issue.
2. **Caret leaving the `#token`** (a click elsewhere, ←/→ past the `#`): the
   list closes.
3. **Repository tab switch while loading:** a late answer for the old
   repository is ignored and never shown under the new one.
4. **Enter with the list open but no row** (loading, error, no match): the
   key falls through to its normal behaviour. Escape still closes the list.
5. **Toast action after switching repository tabs:** it does nothing. It
   never writes into another repository's message.

---

### Task 1: The text helpers

**Files:**
- Create: `apps/desktop/src/utils/issueRefs.ts`
- Test: `apps/desktop/src/utils/__tests__/issueRefs.test.ts`

**Interfaces:**
- Produces:
  - `hashTokenAt(text: string, caret: number): { start: number; query: string } | null`.
    `start` is the index of the `#`; `query` is the text between the `#` and
    the caret.
  - `filterIssues(issues: Issue[], query: string, max = 8): Issue[]`
  - `repoSlugFromUrl(url: string): string | null`. It reads `owner/repo` (or
    `group/sub/proj`) from an issue URL, cutting before `/issues/` or
    `/-/issues/`.
  - `issueRef(number: number, issueRepo: string | null, pushRepo: string | null): string`.
    It returns `#N` when either repository is null or both are equal
    (case-insensitive), and `issueRepo#N` otherwise.
  - `insertRef(text: string, start: number, caret: number, ref: string, fixes: boolean): { text: string; caret: number }`
  - `appendRef(description: string, ref: string, summary = ""): string`

- [ ] **Step 1: Write the failing tests**

```ts
describe("hashTokenAt", () => {
  it("opens at the start, after a space, a newline or (", () => {
    expect(hashTokenAt("#", 1)).toEqual({ start: 0, query: "" });
    expect(hashTokenAt("fix #12", 7)).toEqual({ start: 4, query: "12" });
    expect(hashTokenAt("a\n#lo", 5)).toEqual({ start: 2, query: "lo" });
    expect(hashTokenAt("(#4", 3)).toEqual({ start: 1, query: "4" });
  });
  it("never after a letter or a digit", () => {
    expect(hashTokenAt("C#", 2)).toBeNull();
    expect(hashTokenAt("abc#1", 5)).toBeNull();
  });
  it("closes on a space after the query, or when the caret is before the #", () => {
    expect(hashTokenAt("#12 x", 5)).toBeNull();
    expect(hashTokenAt("ab #12", 2)).toBeNull();
  });
});
describe("filterIssues", () => {
  // issues: #42 "Login fails with SSO" (updated 2026-11-10),
  //         #57 "Logout keeps cache" (2026-11-12), #4 "Docs" (2026-11-01)
  it("digits match the number by prefix", () =>
    expect(filterIssues(issues, "4").map((i) => i.number)).toEqual([42, 4]));
  it("text matches the title, case-insensitively, most recently updated first", () =>
    expect(filterIssues(issues, "LOG").map((i) => i.number)).toEqual([57, 42]));
  it("caps at 8", () => expect(filterIssues(many(20), "")).toHaveLength(8));
});
describe("repoSlugFromUrl", () => {
  it("GitHub, Gitea, GitLab", () => {
    expect(repoSlugFromUrl("https://github.com/iamvdo/mq/issues/4")).toBe("iamvdo/mq");
    expect(repoSlugFromUrl("https://gitlab.com/g/sub/p/-/issues/9")).toBe("g/sub/p");
    expect(repoSlugFromUrl("nope")).toBeNull();
  });
});
describe("issueRef", () => {
  it("bare when same repository or unknown, qualified otherwise", () => {
    expect(issueRef(4, "Me/App", "me/app")).toBe("#4");
    expect(issueRef(4, null, "me/app")).toBe("#4");
    expect(issueRef(4, "up/app", "me/app")).toBe("up/app#4");
  });
});
describe("insertRef", () => {
  it("replaces #query with the reference and a space", () =>
    expect(insertRef("fix #lo now", 4, 7, "#42", false)).toEqual({ text: "fix #42  now", caret: 8 }));
  it("Fixes form", () =>
    expect(insertRef("#4", 0, 2, "#42", true)).toEqual({ text: "Fixes #42 ", caret: 10 }));
});
describe("appendRef", () => {
  it("appends, sets when empty, never duplicates", () => {
    expect(appendRef("body", "#4")).toBe("body #4");
    expect(appendRef("", "#4")).toBe("#4");
    expect(appendRef("see #4 here", "#4")).toBe("see #4 here");
    expect(appendRef("", "#4", "Fix #4")).toBe("");
    expect(appendRef("see #42", "#4")).toBe("see #42 #4");
  });
});
```

- [ ] **Step 2: Watch them fail.**
  Run: `cd apps/desktop && npx vitest run src/utils/__tests__/issueRefs.test.ts`.
  Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement `utils/issueRefs.ts`.**
  - The `appendRef` duplicate check matches the reference as a whole token
    (`#4` is not found in `#42`), in the summary and in the description.

- [ ] **Step 4: Watch them pass** with the same command.

- [ ] **Step 5: Commit.**
  `feat(commit): helpers for issue references in commit messages (#301)`

### Task 2: The suggestion composable

**Files:**
- Create: `apps/desktop/src/composables/useIssueSuggest.ts`
- Test: `apps/desktop/src/composables/__tests__/useIssueSuggest.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
export interface IssueSuggestDeps {
  cwd: () => string | null;
  /** null when the forge cannot list issues (no list at all). */
  loadIssues: (cwd: string) => Promise<Issue[]> | null;
  pushRepo: (cwd: string) => Promise<string | null>;
  now?: () => number;
}
export type SuggestStatus = "idle" | "loading" | "ready" | "error";
export function useIssueSuggest(deps: IssueSuggestDeps): {
  open: Ref<boolean>;
  status: Ref<SuggestStatus>;
  rows: ComputedRef<Issue[]>;
  active: Ref<number>;
  /** Call on input, click and keyup: re-reads the token at the caret. */
  update(text: string, caret: number): void;
  /** Returns the new text and caret when a row was picked, "handled" when the
   * key was consumed, null when the key must fall through. */
  keydown(e: KeyboardEvent, text: string): { text: string; caret: number } | "handled" | null;
  pick(index: number, fixes: boolean, text: string): { text: string; caret: number } | null;
  close(): void;
};
export const ISSUE_CACHE_TTL_MS = 60_000;
```

- [ ] **Step 1: Write the failing tests.** Use fake deps, a counter on
  `loadIssues` and a controllable `now`.

```ts
it("fetches nothing until a # opens the list", ...)       // loadIssues not called after update("abc", 3)
it("fetches once, then again after 60 s", ...)           // 2nd update within 60 s: 1 call; at now+60_001: 2 calls
it("shows loading, then rows", ...)                       // status "loading" → "ready"; rows filtered by the query
it("shows error and keeps the text on failure", ...)      // loadIssues rejects → status "error", rows []
it("no list when the forge cannot list issues", ...)      // loadIssues returns null → open stays false
it("Enter inserts #N, Shift+Enter Fixes #N, Tab like Enter", ...)
it("arrows move the active row and wrap", ...)
it("Escape closes and is handled", ...)
it("ignores Enter while composing (IME)", ...)            // isComposing: true → null, list still open
it("Enter with no row falls through", ...)                // status loading → keydown returns null
it("drops a late answer for another repository", ...)     // cwd switches before resolve → rows stay empty, cache keyed by cwd
it("qualifies issues from another repository", ...)       // pushRepo "me/app", issue url on up/app → inserts "up/app#4 "
it("closes when the caret leaves the token", ...)         // update(text, caretBeforeHash) → open false
```

- [ ] **Step 2: Watch them fail.**
  Run: `npx vitest run src/composables/__tests__/useIssueSuggest.test.ts`.
  Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement `useIssueSuggest`.**
  - The cache is a `Map<cwd, { at, issues, pushRepo }>` held by the instance.
  - A request is tagged with its `cwd`. An answer whose `cwd` is no longer
    `deps.cwd()` is cached but not shown.

- [ ] **Step 4: Watch them pass.**

- [ ] **Step 5: Commit.**
  `feat(commit): issue suggestions composable for # in commit messages (#301)`

### Task 3: The list component and the commit fields

**Files:**
- Create: `apps/desktop/src/components/IssueSuggestList.vue`
- Modify: `apps/desktop/src/components/RepoSidebar.vue`, around the summary
  input (~line 1555) and the description textarea (~line 1618). Their
  handlers are `onSummaryInput`, `onDescriptionInput` and `onCommitKeydown`
  (~line 838).
- Modify: the 5 locales, adding `sidebar.issueSuggest.{loading,unavailable,empty,hint}`.
- Test: `apps/desktop/src/components/__tests__/RepoSidebar-issueSuggest.test.ts`
  (jsdom).

**Interfaces:**
- Consumes: Task 2.
- Production deps:
  - `loadIssues`: `forgeForRepo(cwd)`, then `provider.listIssues?.(cwd, { limit: 100 })`,
    or `null` when the provider has no `listIssues`. The `useIssueSuggest`
    contract returns `Promise | null`, but `forgeForRepo` is async. Wrap
    the call: cache the provider per `cwd` on the first `#`, and return
    `null` once the cached provider is known to lack `listIssues`.
  - `pushRepo`: `gitRemoteInfo(cwd)`, then `` `${owner}/${repo}` ``, or `null`
    when those are empty.
- One `useIssueSuggest` instance per field: summary and description.
- `IssueSuggestList` props: `{ status, rows, active }`. It emits
  `pick(index, fixes)`.
  - It shows each issue as `#N` plus the title, a loading, unavailable or
    empty row when there is nothing else, and the hint row last.
  - Rows use `@mousedown.prevent`, like the template list, so the field
    keeps focus.
  - Its position: the summary's list sits under the summary row, like
    `.template-slash-dropdown`; the description's list sits under the
    textarea.

- [ ] **Step 1: Write the failing tests.** Mount RepoSidebar with the
  minimal props an existing RepoSidebar test uses; reuse its harness. Mock
  `forgeForRepo` and `gitRemoteInfo` at the module level.

```ts
it("typing # in the summary lists issues and Enter inserts #N", ...)   // emitted update:commitSummary "Fix #42 "
it("Shift+Enter in the description inserts Fixes #N", ...)              // update:commitDescription "Fixes #42 "
it("Escape closes the list without reaching a window Escape listener", ...)
it("a / in an empty summary still opens the templates", ...)           // the existing behaviour is unchanged
it("Cmd+Enter still commits while the list is open", ...)
```

- [ ] **Step 2: Watch them fail.**
  Run: `npx vitest run src/components/__tests__/RepoSidebar-issueSuggest.test.ts`.

- [ ] **Step 3: Implement.**
  - **`onCommitKeydown`:** call the field's `keydown` first. With a result
    object, emit the new text and set the caret on `nextTick`. With
    `"handled"`, call `preventDefault()` and `stopPropagation()` and return.
    With `null`, fall through to the existing logic.
  - **Refresh:** call `update` on input, on `click` and on `keyup` of arrow,
    Home and End.
  - **Blur:** `close()`.

- [ ] **Step 4: Watch them pass. Then run the whole desktop suite and vue-tsc.**
  - Run: `npx vitest run src/`.
  - Run: `npx vue-tsc --noEmit -p tsconfig.json`.
  - Expected: all tests green, no type errors.

- [ ] **Step 5: Commit.**
  `feat(commit): suggest issues on # in the commit summary and description (#301)`

### Task 4: The toast action and the release notes

**Files:**
- Modify: `apps/desktop/src/App.vue`:
  - `showDetailToast` (~line 367) gains an optional `action?: { label: string; run: () => void }`;
  - the toast template (~line 5154) renders the action as a second button;
  - `onCreated` (~line 512) uses it.
- Modify: the 5 locales, adding `createIssue.addToCommit`.
- Modify: `CHANGELOG.md` under `## [Unreleased]`. Insert the entry with the
  Edit tool, never by rewriting the file with a script.
- Test: `apps/desktop/src/utils/__tests__/issueRefs.test.ts` covers
  `appendRef`. Pull the `onCreated` decision into a testable helper,
  `addCreatedIssueToCommit(issue, ctx)`, in `utils/issueRefs.ts`.

**Interfaces:**
- `addCreatedIssueToCommit(issueUrl: string, number: number, createdIn: string, activeCwd: string, pushRepo: string | null, summary: string, description: string): string | null`.
  It returns the new description, or `null` when `createdIn !== activeCwd`
  or when the reference is already in the message.

- [ ] **Step 1: Write the failing tests.**

```ts
it("appends the reference to the active repository's description", () =>
  expect(addCreatedIssueToCommit("https://github.com/me/app/issues/7", 7, "/r", "/r", "me/app", "s", "d")).toBe("d #7"));
it("qualifies an issue filed on the parent", () =>
  expect(addCreatedIssueToCommit("https://github.com/up/app/issues/7", 7, "/r", "/r", "me/app", "", "")).toBe("up/app#7"));
it("does nothing after a repository switch", () =>
  expect(addCreatedIssueToCommit("https://github.com/me/app/issues/7", 7, "/r", "/other", "me/app", "", "")).toBeNull());
it("does nothing when already referenced", () =>
  expect(addCreatedIssueToCommit("https://github.com/me/app/issues/7", 7, "/r", "/r", "me/app", "Fix #7", "")).toBeNull());
```

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.**
  - **Helper:** write `addCreatedIssueToCommit`.
  - **`onCreated` in App:**
    - capture `repoFolderPath` when the issue is created;
    - read `pushRepo` with `gitRemoteInfo` (best effort, `null` on error);
    - pass the action `{ label: t("createIssue.addToCommit"), run }`. `run`
      sets `commitDescription.value` when the helper returns a string.
  - **Release notes:** CHANGELOG entry: "Reference issues in commit
    messages: `#` suggests open issues; the new-issue toast adds `#N` to the
    commit (#301)."

- [ ] **Step 4: Watch them pass. Then run the whole desktop suite and vue-tsc.**

- [ ] **Step 5: Commit.**
  `feat(issues): add a created issue to the commit message from its toast (#301)`
