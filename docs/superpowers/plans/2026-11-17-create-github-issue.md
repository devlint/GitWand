# Create GitHub Issue (PR 1 of #301) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File a GitHub issue from a modal over the current view — toolbar, ⌘K, ⌘⇧I, or the commit graph's context menu (prefilled) — on `origin` or, on a fork, its parent.

**Architecture:** Four Rust commands (`gh_issue_targets`, `gh_create_issue`, `gh_list_labels`, `gh_list_milestones`) plus a `repo` parameter on `gh_list_reviewer_candidates`, each REST-first via `github_api::with_rest`, else `gh api` aimed explicitly at the validated repo; matching dev-server routes, `backend.ts` wrappers and registry entries. On the frontend, one `useCreateIssue` instance provided by `App.vue` drives one lazy-loaded `CreateIssueModal.vue`; entry points only call `open(prefill?)`.

**Tech Stack:** Rust (Tauri 2, serde_json, `gh` CLI), Vue 3 `<script setup>`, Vitest (+ jsdom per file), Node dev-server.

**Spec:** `docs/superpowers/specs/2026-11-17-create-github-issue-design.md`

## Global Constraints

- Branch `feat/301-create-github-issue`; never touch the unrelated `website/` working-tree edits.
- Every new `#[tauri::command]`: registered in `src-tauri/src/lib.rs`, wrapper in `src/utils/backend.ts`, entry in `src/utils/commandRegistry.ts`, route in `dev-server.mjs` (AGENTS.md § IPC). Invoke with string literals.
- Target is `origin`'s GitHub repo or, on a fork, its parent from the API's `parent.full_name` — never an `upstream` remote (#298). The backend recomputes the candidates and refuses any other `repo`.
- Issue body never goes in argv: `gh` path sends the JSON payload on stdin (`gh api -X POST … --input -`).
- Markdown preview through the existing sanitising renderer (`useSafeHtml`).
- Links after creation use the `html_url` GitHub returns; commit links use the origin target's `htmlUrl` (GHE-safe), never a hardcoded `github.com`.
- Every user-visible string in `src/locales/{en,fr,es,pt-BR,zh-CN}.ts` (namespace `createIssue.*`, plus `commitCtx.createIssue`, `help.keyboardShortcuts.newIssue`).
- The modal is lazy-loaded (`defineAsyncComponent`), it is `v-if`-gated.
- `cargo fmt` + `cargo clippy -- -D warnings` before every Rust commit; `vue-tsc` clean.

## Review Focus

1. **Whitespace-only title** → refused before any network call, front (Create disabled) and back (`Err`). Pinned in Tasks 2 and 5.
2. **Body with quotes, backslashes, newlines, `$`, `--flag`-looking lines, 60 KB** → reaches GitHub byte-for-byte on both paths. Pinned in Task 2 (payload) and Task 3 (dev route).
3. **Target switched while pickers are loading** → late answers for the old target are dropped; selected labels/assignees/milestone are cleared on switch (they may not exist on the other repo). Pinned in Task 5.
4. **Double submit** (⌘Enter twice, or click + ⌘Enter) → exactly one create call. Pinned in Task 5.
5. **Create fails** (403, network, issues turned off meanwhile) → GitHub's message shown, every field kept, Create re-enabled. Pinned in Task 5.

---

### Task 1: Rust — issue targets

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/gh_issues.rs` (register `mod gh_issues;` in `commands/mod.rs`)
- Modify: `apps/desktop/src-tauri/src/commands/gh.rs` (make `GhRepo::sibling` and `gh_host_cmd` `pub(crate)` if not already)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register `commands::gh_issues::gh_issue_targets`)
- Test: inline `#[cfg(test)] mod tests` in `gh_issues.rs`

**Interfaces:**
- Produces:
  - `#[derive(Serialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")] pub(crate) struct IssueTarget { repo: String /* owner/repo */, html_url: String, has_issues: bool, is_origin: bool }`
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub(crate) struct IssueTargets { targets: Vec<IssueTarget>, default_repo: Option<String> }`
  - `fn targets_from(origin: &serde_json::Value, parent: Option<&serde_json::Value>) -> IssueTargets` — pure: origin first, parent second (only when `origin.fork == true` and `parent` given); `default_repo` = first target with `has_issues`, else `None`.
  - `pub(crate) fn issue_targets_inner(cwd: &str) -> Result<IssueTargets, String>` — empty `targets` when `gh_origin_repo(cwd)` is `None`. Cached per `cwd` for 5 minutes.
  - `pub(crate) fn resolve_issue_target(cwd: &str, repo: &str) -> Result<GhRepo, String>` — `Ok` only for a listed target with `has_issues`; error text `"Not an issue target for this repository: {repo}"` / `"Issues are disabled on {repo}"`.
  - `#[tauri::command] pub(crate) async fn gh_issue_targets(cwd: String) -> Result<IssueTargets, String>` (spawn_blocking).

- [ ] **Step 1: Write failing tests for `targets_from`**

```rust
#[test] fn not_a_fork_has_one_target() {
    let o = json!({"full_name":"me/app","html_url":"https://github.com/me/app","has_issues":true,"fork":false});
    let t = targets_from(&o, None);
    assert_eq!(t.targets.len(), 1);
    assert!(t.targets[0].is_origin);
    assert_eq!(t.default_repo.as_deref(), Some("me/app"));
}
#[test] fn fork_with_issues_off_defaults_to_parent() {
    let o = json!({"full_name":"me/app","html_url":"https://github.com/me/app","has_issues":false,"fork":true});
    let p = json!({"full_name":"org/app","html_url":"https://github.com/org/app","has_issues":true});
    let t = targets_from(&o, Some(&p));
    assert_eq!(t.targets.iter().map(|x| x.repo.as_str()).collect::<Vec<_>>(), ["me/app","org/app"]);
    assert_eq!(t.default_repo.as_deref(), Some("org/app"));
}
#[test] fn fork_with_issues_on_defaults_to_origin() { /* origin has_issues true → default "me/app" */ }
#[test] fn no_target_with_issues_has_no_default() { /* both false → default None, 2 targets */ }
#[test] fn parent_ignored_when_origin_is_not_a_fork() { /* fork:false + Some(parent) → 1 target */ }
```

- [ ] **Step 2: Run** `cd apps/desktop/src-tauri && cargo test --lib gh_issues` — Expected: FAIL (module/function missing).

- [ ] **Step 3: Implement** `targets_from`, `issue_targets_inner`, `resolve_issue_target`, the command. Origin read: REST `GET /repos/{nwo}` via `with_rest`, else `gh api repos/{nwo}` with `gh_host_cmd(Some(&origin))`; parent read the same way only when `fork` is true, its `full_name` taken from `origin.parent.full_name`. A failed parent read keeps the origin target alone.

- [ ] **Step 4: Add tests for `resolve_issue_target` membership** by factoring the check as `fn check_target(targets: &IssueTargets, repo: &str) -> Result<(), String>` (pure): unknown repo → Err "Not an issue target…"; listed with `has_issues:false` → Err "Issues are disabled…"; listed with issues → Ok.

- [ ] **Step 5: Run** `cargo test --lib gh_issues && cargo fmt && cargo clippy -- -D warnings` — Expected: PASS, clean.

- [ ] **Step 6: Commit** `feat(issues): resolve where a new issue can go — origin or a fork's parent (#301)`

### Task 2: Rust — create issue, labels, milestones, assignees of a target

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gh_issues.rs`
- Modify: `apps/desktop/src-tauri/src/commands/gh.rs` (`gh_list_reviewer_candidates` gains `repo: Option<String>`)
- Modify: `apps/desktop/src-tauri/src/commands/github_api.rs` (`rest_reviewer_candidates(cwd, nwo: Option<&str>, token)`)
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `resolve_issue_target`, `IssueTarget` (Task 1).
- Produces:
  - `#[derive(Deserialize)] #[serde(rename_all = "camelCase")] pub(crate) struct CreateIssueInput { repo: String, title: String, body: String, labels: Vec<String>, assignees: Vec<String>, milestone: Option<i64> }`
  - `#[derive(Serialize)] pub(crate) struct CreatedIssue { number: i64, url: String }`
  - `#[derive(Serialize)] pub(crate) struct RepoLabel { name: String, color: String, description: Option<String> }`
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub(crate) struct RepoMilestone { number: i64, title: String, due_on: Option<String> }`
  - `fn issue_payload(input: &CreateIssueInput) -> Result<serde_json::Value, String>` — pure; trims title, `Err("Title is required")` when empty; omits `labels`/`assignees` when empty and `milestone` when `None`; body verbatim.
  - Commands: `gh_create_issue(cwd: String, input: CreateIssueInput) -> Result<CreatedIssue, String>`, `gh_list_labels(cwd: String, repo: String) -> Result<Vec<RepoLabel>, String>` (up to 3 pages of 100), `gh_list_milestones(cwd: String, repo: String) -> Result<Vec<RepoMilestone>, String>` (`state=open`, 1 page of 100), `gh_list_reviewer_candidates(cwd: String, repo: Option<String>)` — `repo` validated by `resolve_issue_target` membership only (issues flag not required for listing assignees; use `check_target` membership half).

- [ ] **Step 1: Failing tests for `issue_payload`**

```rust
#[test] fn payload_omits_empty_optionals() {
    let p = issue_payload(&input("  Bug  ", "", vec![], vec![], None)).unwrap();
    assert_eq!(p, json!({"title":"Bug","body":""}));
}
#[test] fn payload_keeps_body_verbatim() {
    let body = "a \"q\" \\ $HOME\n--flag\n".repeat(2000);
    let p = issue_payload(&input("t", &body, vec![], vec![], None)).unwrap();
    assert_eq!(p["body"].as_str().unwrap(), body);
}
#[test] fn payload_carries_labels_assignees_milestone() { /* labels ["bug"], assignees ["me"], Some(3) → all three present, milestone 3 */ }
#[test] fn whitespace_title_is_refused() { assert_eq!(issue_payload(&input(" \n ", "", vec![], vec![], None)).unwrap_err(), "Title is required"); }
#[test] fn created_issue_read_from_response() { /* fn created_from(&json!({"number":12,"html_url":"https://github.com/o/r/issues/12"})) → CreatedIssue{12, url} */ }
```

- [ ] **Step 2: Run** `cargo test --lib gh_issues` — Expected: FAIL.

- [ ] **Step 3: Implement.** Create: `issue_payload` first (title check happens before any target resolution), then `resolve_issue_target`, then REST `POST /repos/{nwo}/issues` via `with_rest` (the `api_json` helper), else `gh_host_cmd(Some(&repo)).args(["api","-X","POST",&format!("repos/{}/issues", repo.nwo),"--input","-"])` with the payload written to stdin. `created_from` reads `number` and `html_url`. Labels/milestones: REST via `with_rest`, else `gh api` GET on the same paths; map fields. Reviewer candidates: thread `nwo` through to the REST helper and the `gh` path (`repos/{nwo}/assignees`) when `repo` is given; unchanged behaviour when `None`.

- [ ] **Step 4: Run** `cargo test --lib && cargo fmt && cargo clippy -- -D warnings` (outside the sandbox for the PTY/watcher tests) — Expected: PASS, clean.

- [ ] **Step 5: Commit** `feat(issues): create issues and read a target's labels, milestones and assignees (#301)`

### Task 3: IPC — dev-server routes, wrappers, registry, provider

**Files:**
- Modify: `apps/desktop/dev-server.mjs` (routes next to `/api/gh-reviewer-candidates`)
- Modify: `apps/desktop/src/utils/backend.ts`
- Modify: `apps/desktop/src/utils/commandRegistry.ts`
- Modify: `apps/desktop/src/composables/forge/types.ts`, `GitHubProvider.ts`
- Test: `apps/desktop/src/utils/__tests__/commandRegistry.test.ts` (existing, must pass); `apps/desktop/src/composables/forge/__tests__/` (existing provider tests pattern)

**Interfaces:**
- Consumes: the Rust commands and JSON shapes of Tasks 1–2.
- Produces (`backend.ts`):
  - `interface IssueTarget { repo: string; htmlUrl: string; hasIssues: boolean; isOrigin: boolean }`, `interface IssueTargets { targets: IssueTarget[]; defaultRepo: string | null }`
  - `interface CreateIssueInput { repo: string; title: string; body: string; labels: string[]; assignees: string[]; milestone: number | null }`, `interface CreatedIssue { number: number; url: string }`, `interface RepoLabel { name: string; color: string; description: string | null }`, `interface RepoMilestone { number: number; title: string; dueOn: string | null }`
  - `ghIssueTargets(cwd): Promise<IssueTargets>`, `ghCreateIssue(cwd, input): Promise<CreatedIssue>`, `ghListLabels(cwd, repo): Promise<RepoLabel[]>`, `ghListMilestones(cwd, repo): Promise<RepoMilestone[]>`; `ghListReviewerCandidates(cwd, repo?)` gains the optional arg.
  - Routes: `GET /api/gh-issue-targets?cwd`, `POST /api/gh-create-issue {cwd, input}`, `GET /api/gh-list-labels?cwd&repo`, `GET /api/gh-list-milestones?cwd&repo`, `/api/gh-reviewer-candidates` accepts `&repo`.
  - `ForgeProvider`: optional `issueTargets?(cwd)`, `createIssue?(cwd, input)`, `listLabels?(cwd, repo)`, `listMilestones?(cwd, repo)`, `listReviewerCandidates(cwd, repo?)`; implemented in `GitHubProvider` only.

- [ ] **Step 1: Add the registry entries** (route + `cliPathOnly` note, same wording pattern as `gh_pr_attachment_urls`) and run `pnpm vitest run src/utils/__tests__/commandRegistry.test.ts` — Expected: FAIL until wrappers invoke the commands, then PASS after Step 2.
- [ ] **Step 2: Implement wrappers and routes.** Dev routes mirror Rust: same target computation (origin `getRepoNwo`, `fork`/`parent`), same membership + issues check before create/labels/milestones/assignees (400 `{error}` otherwise), `issue_payload` rules (trim, refuse empty title with 400, omit empty optionals). Create uses `githubFetch` with `method: "POST"` — extend `githubFetch(path, token, accept, init?)` minimally.
- [ ] **Step 3: Provider methods** delegating to the wrappers.
- [ ] **Step 4: Run** `pnpm vitest run src/utils src/composables/forge && pnpm vue-tsc --noEmit` — Expected: PASS, clean.
- [ ] **Step 5: Live check of the dev routes** (dev-server outside the sandbox): `gh-issue-targets` on GitWand returns `devlint/GitWand` with `hasIssues: true, isOrigin: true`; `gh-create-issue` with a whitespace title → 400; a `repo` not in the targets → 400. No issue is created in this step.
- [ ] **Step 6: Commit** `feat(issues): IPC for issue creation — wrappers, dev-server routes, GitHub provider (#301)`

### Task 4: Commit prefill builder

**Files:**
- Create: `apps/desktop/src/utils/issuePrefill.ts`
- Test: `apps/desktop/src/utils/__tests__/issuePrefill.test.ts`

**Interfaces:**
- Consumes: `GitLogEntry` (`backend.ts`).
- Produces: `interface IssuePrefill { title: string; body: string }`; `function commitIssuePrefill(entry: GitLogEntry, commitUrl: string | null): IssuePrefill`; `function commitUrlFor(originHtmlUrl: string, sha: string): string` (`${originHtmlUrl}/commit/${sha}`).

- [ ] **Step 1: Failing tests**

```ts
it("titles the issue with the commit summary", () => {
  expect(commitIssuePrefill(entry({ message: "fix: x" }), null).title).toBe("fix: x");
});
it("links the short SHA when the commit is pushed", () => {
  const b = commitIssuePrefill(entry({ hash: "abc1234", hashFull: "abc1234ff…" }), "https://github.com/o/r/commit/abc1234ff…").body;
  expect(b).toContain("[`abc1234`](https://github.com/o/r/commit/abc1234ff…)");
});
it("writes the full SHA unlinked when the commit is not pushed", () => {
  const b = commitIssuePrefill(entry({ hashFull: "abc1234ff…" }), null).body;
  expect(b).toContain("`abc1234ff…`"); expect(b).not.toContain("](");
});
it("quotes every line of the full message, body included", () => {
  const b = commitIssuePrefill(entry({ message: "s", body: "l1\n\nl2" }), null).body;
  expect(b).toContain("> s\n>\n> l1\n>\n> l2");
});
it("names the author", () => { /* body contains entry.author */ });
```

- [ ] **Step 2: Run** `pnpm vitest run src/utils/__tests__/issuePrefill.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Body layout (English, as GitHub content is shared): `Commit <sha-part> by <author>` line, blank line, quoted message. The labels inside the body are fixed English copy, not i18n.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(issues): prefill an issue from a commit (#301)`

### Task 5: `useCreateIssue` composable

**Files:**
- Create: `apps/desktop/src/composables/useCreateIssue.ts`
- Test: `apps/desktop/src/composables/__tests__/useCreateIssue.test.ts`

**Interfaces:**
- Consumes: Task 3 wrappers (through `ForgeProvider` methods), `IssuePrefill` (Task 4).
- Produces:
  - `export const CREATE_ISSUE_KEY: InjectionKey<CreateIssueApi>`
  - `function useCreateIssue(deps: { cwd: Ref<string | null>; provider: Ref<ForgeProvider | null>; onCreated: (issue: CreatedIssue) => void }): CreateIssueApi`
  - `CreateIssueApi = { isOpen: Ref<boolean>; available: Ref<boolean>; targets: Ref<IssueTarget[]>; repo: Ref<string | null>; title: Ref<string>; body: Ref<string>; labels: Ref<string[]>; assignees: Ref<string[]>; milestone: Ref<number | null>; labelOptions: Ref<RepoLabel[]>; assigneeOptions: Ref<ReviewerCandidate[]>; milestoneOptions: Ref<RepoMilestone[]>; submitting: Ref<boolean>; error: Ref<string | null>; dirty: ComputedRef<boolean>; canSubmit: ComputedRef<boolean>; refreshAvailability(): Promise<void>; open(prefill?: IssuePrefill): Promise<void>; close(): void; setRepo(repo: string): void; submit(): Promise<void>; originHtmlUrl: ComputedRef<string | null> }`
  - `available` = `issueTargets` returned at least one target (computed per cwd by `refreshAvailability`, called by `App.vue` when the repo changes).
  - `dirty` = title/body differ from the prefill they were opened with.

- [ ] **Step 1: Failing tests** (fake provider object, no Tauri mock):
  - `open()` loads targets and selects `defaultRepo`; pickers load for it.
  - `open(prefill)` fills title/body; `dirty` false until edited.
  - **(Focus 3)** `setRepo` while the first repo's labels are pending: the late answer is ignored; `labels`/`assignees`/`milestone` cleared.
  - Picker read failure → that option list empty, `error` stays null.
  - `canSubmit` false for `"   "` title, for no repo, while `submitting`.
  - **(Focus 4)** two `submit()` calls in the same tick → `createIssue` called once.
  - **(Focus 5)** `createIssue` rejects with `"HTTP 403: …"` → `error` = that message, all fields kept, `submitting` false, still open.
  - Success → `onCreated` called with the result, modal closed, state reset.
  - No target has issues (`defaultRepo` null) → `repo` null, `canSubmit` false (modal shows the disabled message).
- [ ] **Step 2: Run** `pnpm vitest run src/composables/__tests__/useCreateIssue.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with a per-load sequence token for picker loads (same pattern as other composables guarding stale responses).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(issues): issue form state — targets, pickers, submit (#301)`

### Task 6: `CreateIssueModal.vue` + i18n

**Files:**
- Create: `apps/desktop/src/components/CreateIssueModal.vue`
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` (`createIssue.*`)
- Test: `apps/desktop/src/components/__tests__/CreateIssueModal.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `CREATE_ISSUE_KEY` (Task 5) via `inject`.
- Produces: a component with no props, emitting nothing (state lives in the composable); mounted by `App.vue` under `v-if="createIssue.isOpen.value"`.

Layout: `BaseModal size="lg" :title="t('createIssue.title')"`, subtitle = selected `repo`; when `targets.length > 1` a two-option selector, a target without issues disabled with `t('createIssue.issuesDisabled')`; when `repo` is null, only the disabled message and Close. Title input (autofocus), Write/Preview tabs over the body (preview rendered with the app's markdown renderer through `useSafeHtml`), labels / assignees / milestone pickers reusing the reviewer chip pattern of `PrCreateView.vue`, error line, Cancel / Create. ⌘Enter / Ctrl+Enter submits when `canSubmit`. Escape and Cancel: `window.confirm(t('createIssue.discardConfirm'))` only when `dirty`.

- [ ] **Step 1: Failing tests:** Create disabled with empty title; preview of `<img src=x onerror=alert(1)>` contains no `onerror`; ⌘Enter calls `submit`; target selector shows only on forks and disables a no-issues target; Escape with a dirty form asks for confirmation, clean form closes directly; `repo` null shows the disabled message and no title field.
- [ ] **Step 2: Run** `pnpm vitest run src/components/__tests__/CreateIssueModal.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the component and the locale keys (use the i18n-sync skill to keep the 5 files aligned).
- [ ] **Step 4: Run** the test file and `pnpm vue-tsc --noEmit` — Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(issues): new issue modal (#301)`

### Task 7: Entry points, toast link, wiring

**Files:**
- Modify: `apps/desktop/src/App.vue` (instance + `provide`, lazy modal, palette action, `onKeyDown` ⌘⇧I, commit handler, `refreshAvailability` on repo change, toast link)
- Modify: `apps/desktop/src/components/AppHeader.vue` (button in `.header-actions` with `data-collapse-key="newIssue"`, emits `openNewIssue`, prop `canCreateIssue: boolean`)
- Modify: `apps/desktop/src/components/CommitGraph.vue` (`CommitEvent` union + emits `"create-issue": [entry: GitLogEntry]`, menu item next to "View on forge", shown only with prop `canCreateIssue`)
- Modify: `apps/desktop/src/components/HelpView.vue` (`{ action: "help.keyboardShortcuts.newIssue", keys: ["⌘⇧I"] }`)
- Modify: locales (`commitCtx.createIssue`, `createIssue.toolbar`, `createIssue.paletteLabel`, `createIssue.created`, `createIssue.open`, `help.keyboardShortcuts.newIssue`)
- Test: extend `src/components/__tests__/CommitGraph.*.test.ts` pattern with `CommitGraph.createIssue.test.ts`

**Interfaces:**
- Consumes: `useCreateIssue`, `CREATE_ISSUE_KEY` (Task 5), `commitIssuePrefill`, `commitUrlFor` (Task 4), `gitExec` (existing).
- Produces: `showDetailToast(title, detail, ms = 3000, link?: { label: string; url: string })` — the toast renders a link button opening `url` with the app's existing external-URL opener; other callers unchanged.

Commit handler: `gitExec(cwd, ["for-each-ref", "--contains", entry.hashFull, "--count=1", "--format=%(refname)", "refs/remotes/"])` — non-empty stdout ⇒ pushed ⇒ `commitUrlFor(originHtmlUrl, entry.hashFull)`; else `null`; then `createIssue.open(commitIssuePrefill(entry, url))`. On creation: `showDetailToast(t('createIssue.created', n), null, 8000, { label: t('createIssue.open'), url })`.

- [ ] **Step 1: Failing test:** the commit menu shows "Create issue from commit" only when `canCreateIssue`, and clicking it emits `create-issue` with the entry.
- [ ] **Step 2: Run** `pnpm vitest run src/components/__tests__/CommitGraph.createIssue.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** all entry points, gated by `createIssue.available.value` (toolbar button, palette action, shortcut, menu item); the toast link.
- [ ] **Step 4: Run** `pnpm test && pnpm vue-tsc --noEmit` — Expected: all pass, clean.
- [ ] **Step 5: Commit** `feat(issues): new issue from the toolbar, ⌘K, ⌘⇧I and a commit's menu (#301)`

### Task 8: QA, changelog, PR

**Files:**
- Modify: `CHANGELOG.md` (Unreleased › Added: "Create GitHub issues from inside GitWand … (#301, requested by Pannboo)")

- [ ] **Step 1: Full checks:** `pnpm test`, `pnpm vue-tsc --noEmit`, `cargo test --lib` (outside the sandbox), `cargo clippy -- -D warnings`, `cargo fmt --check` — all green.
- [ ] **Step 2: Browser QA under `pnpm dev:web`** (repo injected through `gitwand-open-tabs`): entry points visible on a GitHub repo and hidden on a non-GitHub one; modal opens from each; commit prefill pushed vs local commit; preview; pickers load; target selector on a fork. Creating a real issue only on a repository the user designates, then closing it.
- [ ] **Step 3: Commit** the changelog; push; open the PR referencing #301 and the spec, listing what is left for PR 2/3.
