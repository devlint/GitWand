# Report a Bad Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a resolution GitWand proposed in the merge editor, file an issue either on the current repository or, behind a switch and guardrails, on `devlint/GitWand` as a resolver report.

**Architecture:** Pure builders turn a hunk + its resolution into an issue prefill (repository or GitWand variant) and scan a body for secrets. `useCreateIssue` gains a report mode (answer field, GitWand switch, confirmation, findings) and sends GitWand reports through two new github.com-only backend commands. The three proposal panels emit `report`; `MergeEditor` keeps an in-memory copy of accepted proposals so they stay reportable for the session.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, vitest (jsdom opt-in), Rust (Tauri 2), `@gitwand/core`, `dev-server.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-18-report-bad-resolution-design.md`

## Global Constraints

- GitWand's repository is the constant `devlint/GitWand` on `github.com`; requests for it never go to `origin`'s host.
- The GitWand body never contains the file path, raw file name, repository name, branch names or remote.
- Create on the GitWand path stays disabled until "I reviewed the code, it can be public" is ticked; switching off and on unticks it; editing the body does not tick it.
- Secret findings of severity `high` or `medium` block Create on the GitWand path; `low` (entropy) only warns; on the repository path every finding only warns.
- GitWand scan: enabled whatever the config, `ignore: []`, built-in plus the repository's `.gitwandrc` extra patterns, entropy threshold from settings.
- No labels, assignees or milestone on the GitWand path.
- Generated issue text is English; UI strings in all 5 locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`).
- Report body budget: `REPORT_BODY_MAX = 60_000` characters (under GitHub's 65,536).
- Accepted-proposal copies live in memory only, for the merge editor's lifetime.
- AGENTS.md: new Tauri commands get `backend.ts` wrappers, `commandRegistry.ts` entries and `dev-server.mjs` routes in the same PR; `packages/core` stays browser-safe.
- Run `cargo fmt` before pushing Rust.

## Review Focus

- A hunk without a base (2-way markers): the report must omit the base block, not print an empty one — test in Task 3.
- A lockfile hunk full of integrity hashes: entropy findings must warn, never block — test in Task 4.
- Switching to GitWand after typing in the answer field: the answer must survive, the path must be gone — test in Task 5.
- Opening a report from a GitLab or remote-less repository: the form must open locked on GitWand, not on "no target" — test in Task 5.
- Accepting an engine proposal then leaving the file: the copy must not leak into another file's list — test in Task 7.

---

### Task 1: The format resolver on the hunk (core)

**Files:**
- Modify: `packages/core/src/types.ts` (`ConflictHunk`)
- Modify: `packages/core/src/resolver/index.ts` (`reclassifyFormatSemantic`, `boostFormatValidated`)
- Test: `packages/core/src/__tests__/format-resolvers.test.ts`

**Interfaces:**
- Produces: `ConflictHunk.formatResolver?: string` — the format resolver that produced the hunk's resolution (`dispatch.resolverUsed`), absent otherwise.

- [ ] **Step 1: Write the failing tests** in the "Intégration JSON via resolve()" describe:

```ts
it("records the format resolver on the resolved hunk", () => {
  const result = resolve(jsonConflict, "package.json"); // the existing fixture above
  expect(result.resolutions[0].hunk.formatResolver).toBe("json");
});
it("leaves formatResolver unset for a pattern-resolved hunk", () => {
  const r = resolve("<<<<<<< ours\na\n||||||| base\na\n=======\nb\n>>>>>>> theirs", "x.txt");
  expect(r.resolutions[0].hunk.formatResolver).toBeUndefined();
});
```

(Hoist `jsonConflict` to the describe if it is local to one test.)

- [ ] **Step 2: Run** `cd packages/core && npx vitest run src/__tests__/format-resolvers.test.ts` — Expected: the first test FAILS (`undefined` vs `"json"`).
- [ ] **Step 3: Implement** — add the optional field with a doc comment; set `formatResolver: resolverUsed` in both functions' returned hunk.
- [ ] **Step 4: Run** the file, then `cd packages/core && pnpm test && pnpm build` — Expected: all pass, build clean.
- [ ] **Step 5: Commit** `feat(core): keep the format resolver on a resolved hunk (#301)`.

### Task 2: GitWand's github.com target (backend)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gh_issues.rs`, `apps/desktop/src-tauri/src/lib.rs` (`generate_handler!`)
- Modify: `apps/desktop/src/utils/backend.ts` (or the issues section where `ghCreateIssue` lives), `apps/desktop/src/utils/commandRegistry.ts`, `apps/desktop/dev-server.mjs`

**Interfaces:**
- Produces (Rust): `pub(crate) const GITWAND_REPO: &str = "devlint/GitWand";` · `#[tauri::command] gh_create_gitwand_issue(input: GitwandIssueInput) -> Result<CreatedIssue, String>` with `GitwandIssueInput { title: String, body: String }` (camelCase serde) · `#[tauri::command] gh_gitwand_writable() -> Result<bool, String>`.
- Produces (TS): `ghCreateGitwandIssue(input: { title: string; body: string }): Promise<CreatedIssue>` · `ghGitwandWritable(): Promise<boolean>`; dev routes `POST /api/gh-create-gitwand-issue { input }`, `GET /api/gh-gitwand-writable`.

- [ ] **Step 1: Write failing Rust unit tests** in `gh_issues.rs`'s test module:
  - `gitwand_repo_is_on_github_com`: the `GhRepo` built for GitWand has `selector() == "devlint/GitWand"` (no host prefix).
  - `gitwand_payload_is_title_and_body_only`: the payload built from `GitwandIssueInput { title: "t", body: "b" }` equals `{"title":"t","body":"b"}`; a blank title is an error (reuse `issue_payload`'s rule).
- [ ] **Step 2: Run** `cd apps/desktop/src-tauri && cargo test gitwand` — Expected: FAIL (not defined).
- [ ] **Step 3: Implement.** `gitwand_repo() -> GhRepo` (empty host prefix; add a `GhRepo::github_com(nwo)` constructor in `gh.rs` if none exists). Create: payload, then the account token (`issue_token()`) → `rest_api_json("POST", "repos/devlint/GitWand/issues", tok, Some(body), Some(60))`; without a token → `gh_api_on(<temp dir>, &gitwand_repo(), "POST", …, 60 s)`; the same `MAY_HAVE_BEEN_CREATED` marking as `create_issue_inner`. Writable: `issue_token().is_some() || gh_signed_in_to("github.com")` (make it `pub(crate)`; check it answers for github.com, else add a github.com probe). Register both commands.
- [ ] **Step 4: Run** `cargo test gitwand && cargo fmt && cargo clippy --all-targets -- -D warnings` — Expected: pass, clean.
- [ ] **Step 5: TS + dev-server.** Wrappers (`IPC_TIMEOUT.NETWORK` for create), registry entries with `cliPathOnly` notes like `gh_create_issue`'s, plus for the create route: "The dev-server posts to `GITWAND_DEV_REPORT_REPO` when set (QA on a test fork), else devlint/GitWand." Dev routes reuse `devIssuePayload` (title/body only), `getGithubToken()`, `githubFetch`, `MAY_HAVE_BEEN_CREATED`; writable = token present.
- [ ] **Step 6: Run** `cd apps/desktop && npx vitest run src/utils/__tests__/commandRegistry.test.ts && npx vue-tsc --noEmit` — Expected: pass.
- [ ] **Step 7: Commit** `feat(issues): file a resolver report on GitWand's repository (#301)`.

### Task 3: Report bodies (pure builders)

**Files:**
- Create: `apps/desktop/src/utils/resolutionReport.ts`
- Test: `apps/desktop/src/utils/__tests__/resolutionReport.test.ts`

**Interfaces:**
- Consumes: `ConflictHunk` (with `formatResolver?`), `IssuePrefill` from `issuePrefill.ts`.
- Produces:
  ```ts
  export type ProposalKind = "engine" | "ai" | "token";
  export interface ResolutionReport { kind: ProposalKind; path: string; hunk: ConflictHunk; resolvedLines: string[] }
  export const REPORT_BODY_MAX = 60_000;
  export function fileKind(path: string): string;
  export function repoReportPrefill(r: ResolutionReport, answer: string): IssuePrefill;
  export function gitwandReportPrefill(r: ResolutionReport, answer: string, env: { version: string; platform: string }): IssuePrefill;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `fileKind`: `"src/a/b.test.ts"` → `".ts"`; `"Cargo.lock"` → `"Cargo.lock"`; `"deploy/Dockerfile"` → `"Dockerfile"`; `".env.production"` → `".env"`; `"Makefile.secret-name"`-style unknown names without a known extension → `"no extension"`; `"LICENSE"` → `"no extension"`. Known names: `Dockerfile`, `Makefile`, `Cargo.lock`, `Gemfile`, `Gemfile.lock`, `package-lock.json` (extension `.json` is fine too, but keep the list explicit for lockfiles: `yarn.lock`, `pnpm-lock.yaml`, `composer.lock`, `poetry.lock`).
  - `repoReportPrefill`: title `` Bad merge resolution in `src/x.ts` ``; body starts with the answer under `### What it should have been` when non-empty (section omitted when blank); contains `` `src/x.ts` ``, fenced `ours`, `theirs`, `base` blocks, `### GitWand's result`, the explanation, `` `non_overlapping` ``, `confidence 90 (high)`.
  - No base (`baseLines: []` and `trace.hasBase === false`): no `base` block.
  - `gitwandReportPrefill`: title `` Resolver: bad `non_overlapping` resolution (`.ts`) ``; body contains `GitWand 3.13.2`, the platform, `.ts`, `formatResolver` when set (`resolver: json`), and does **not** contain `src/x.ts`, `x.ts` or the repository name passed nowhere.
  - AI kind: body contains the model name and `validation 82`, never `promptHash`; token kind: pass counts.
  - AI kind with `history` stats: they appear (commits and lines used). Repository body: no branch names (ruling: `ConflictFile` carries no branch labels, so the spec's "when known" is never met here).
  - Budget: a hunk of 5,000 lines of 40 chars → `body.length <= REPORT_BODY_MAX` and a `(cut` note.
- [ ] **Step 2: Run** `cd apps/desktop && npx vitest run src/utils/__tests__/resolutionReport.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the builders. Fences use a run of backticks longer than any in the content (as `issuePrefill.ts` does, reuse its helper if exported). Cut the longest block first until under budget, with `_(cut to its first N lines)_`.
- [ ] **Step 4: Run** the file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(issues): build bad-resolution reports (#301)`.

### Task 4: Secrets scan of a report body

**Files:**
- Create: `apps/desktop/src/utils/reportGuard.ts`
- Test: `apps/desktop/src/utils/__tests__/reportGuard.test.ts`

**Interfaces:**
- Produces: `export function scanReportBody(body: string, opts: { extraPatterns: SecretPattern[]; entropyThreshold: number; blockAt: "medium" | "never" }): { blocking: SecretFinding[]; warnings: SecretFinding[] }` — calls core `scanSecrets([{ path: "issue-body.md", addedLines }], { enabled: true, extraPatterns, ignore: [], entropyThreshold })`.

- [ ] **Step 1: Failing tests:** a line `token = "ghp_` + 36 alphanumerics + `"` → one blocking finding with its line number (`blockAt: "medium"`); same body with `blockAt: "never"` → zero blocking, one warning; a `"integrity": "sha512-…"` line (88 base64 chars) → warning only; plain prose → nothing; an extra pattern `{ id: "acme", regex: "ACME-[0-9]{6}", severity: "high" }` → blocking.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(issues): scan a report for secrets before it goes public (#301)`.

### Task 5: Report mode in `useCreateIssue`

**Files:**
- Modify: `apps/desktop/src/composables/useCreateIssue.ts`
- Test: `apps/desktop/src/composables/__tests__/useCreateIssue-report.test.ts` (jsdom)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces on `CreateIssueApi`:
  ```ts
  report: Ref<ResolutionReport | null>;
  answer: Ref<string>;                       // "What should it have been?"
  toGitwand: Ref<boolean>;
  gitwandLocked: Ref<boolean>;               // the repository path is impossible
  gitwandWritable: Ref<boolean | null>;      // null while checking
  confirmedPublic: Ref<boolean>;
  findings: Ref<{ blocking: SecretFinding[]; warnings: SecretFinding[] }>;
  bodyEdited: ComputedRef<boolean>;          // body differs from the generated one
  openFromResolution(r: ResolutionReport): Promise<void>;
  setGitwand(on: boolean): void;             // regenerates the body; the caller confirms first when bodyEdited
  ```
  New deps (defaults to the real ones, injectable in tests): `createGitwandIssue`, `gitwandWritable`, `appVersion`, `platform`, `secretsOptions: () => Promise<{ extraPatterns; entropyThreshold }>`.

- [ ] **Step 1: Failing tests** (real composable, injected deps; no git needed):
  - open from a report on a GitHub repo with issues → `toGitwand === false`, `repo` = origin, body = `repoReportPrefill(r, "")`.
  - open with no targets (provider says none / origin not GitHub) → `toGitwand === true`, `gitwandLocked === true`, `repo === "devlint/GitWand"`.
  - `answer.value = "keep both"; setGitwand(true)` → body = `gitwandReportPrefill(r, "keep both", env)`, contains no `src/x.ts`; `answer` unchanged; labels/assignees/milestone cleared; `setGitwand(false)` → repository body back, `confirmedPublic === false`.
  - `canSubmit` on GitWand: false until `confirmedPublic`; false with a blocking finding even when confirmed; true after the secret line is removed from the body (scan re-runs; await the debounce with fake timers).
  - `submit` on GitWand calls `createGitwandIssue({ title, body })` and never `provider.createIssue`; `MAY_HAVE_BEEN_CREATED` handled as today.
  - `gitwandWritable` false → `canSubmit` false on GitWand.
  - `dirty` true when only `answer` changed.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (report mode resets on `close`/`reset`; a non-report `open` hides everything new). **Step 4: Run** this file and `useCreateIssue.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(issues): report mode with a GitWand switch and guardrails (#301)`.

### Task 6: The form

**Files:**
- Modify: `apps/desktop/src/components/CreateIssueModal.vue`, the 5 locale files
- Test: `apps/desktop/src/components/__tests__/CreateIssueModal-report.test.ts` (jsdom)

- [ ] **Step 1: Failing tests:** in report mode the modal shows the answer textarea, the switch (checkbox, `data-testid="ci-gitwand"`), and on GitWand: the public warning, the confirmation checkbox, no label/assignee/milestone pickers, the target fieldset hidden; a blocking finding is listed with its line and Create is disabled; the switch is disabled with its reason when `gitwandWritable === false`, and checked + disabled when `gitwandLocked`; flipping the switch with `bodyEdited` asks `window.confirm`-style through the app's existing confirm helper (use the one `CreateIssueModal` already uses for dirty close) and does nothing on cancel.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Keys under `createIssue.report.*`: `answerLabel` ("What should it have been?"), `answerPlaceholder`, `toGitwand` ("Send to GitWand (resolver report)"), `publicWarning` (spec text), `confirmPublic` ("I reviewed the code, it can be public"), `secretBlocking` ("Possible secret on line {0} ({1}): remove it to send"), `secretWarning`, `replaceEdits` ("Your edits to the description will be replaced"), `gitwandUnavailable` ("Sign in to GitHub (github.com) to send reports to GitWand"), `repoUnavailable` ("This repository can't receive issues here; the report goes to GitWand"), `button` ("Report"), `acceptedTitle` ("Accepted in this session"), `acceptedItem` ("Hunk at line {0}"). Translate for fr/es/pt-BR/zh-CN.
- [ ] **Step 4: Run** this test + `locales` tests — PASS.
- [ ] **Step 5: Commit** `feat(issues): report form with the GitWand switch (#301)`.

### Task 7: Report buttons and accepted copies

**Files:**
- Modify: `ResolutionPreviewPanel.vue`, `LlmTracePanel.vue`, `TokenMergePanel.vue` (emit `report: [hunkId]`, a "Report" button when a `canReport` prop is true), `MergeEditor.vue`
- Test: `apps/desktop/src/components/__tests__/MergeEditor-report.test.ts` (jsdom)

**Interfaces:**
- Consumes: `CREATE_ISSUE_KEY` (optional inject; no button without it), `openFromResolution`.
- Produces in `MergeEditor`: `acceptedReports: Ref<ResolutionReport[]>` built on `onPreviewAccept` / `onTokenMergeAccept` (before the emit), shown as a compact list "Accepted in this session" at the top of the file view, each row "Hunk at line N · Report". Cleared when `props.file.path` changes.

- [ ] **Step 1: Failing tests:** Report in each panel calls `openFromResolution` with `{ kind, path: file.path, hunk, resolvedLines }` (engine: `resolutions[i].resolvedLines`; token: `trace.tokenMergeTrace.mergedLines`; AI: `resolutions[i].resolvedLines`); after `onPreviewAccept`, the accepted list shows one row whose Report sends the same data; changing `file` to another path empties the list; without the injection no Report button renders.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** (Ruling from the spec's "where the hunk was": a list at the top of the file view, since the hunk's place is gone after the reparse.) **Step 4: Run** this + existing `MergeEditor*.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(merge): report a resolution from the merge editor (#301)`.

### Task 8: Docs and full check

- [ ] CHANGELOG Unreleased › Added: one entry (both destinations, guardrails, accepted copies, works from non-GitHub repositories). ROADMAP: under the #301 follow-ups, "journal of resolutions (report after the file is saved)".
- [ ] Run `cd apps/desktop && npx vitest run` (log to a file, read the tail), `npx vue-tsc --noEmit`, `cd packages/core && pnpm test`, `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` — Expected: all green.
- [ ] Commit `docs: changelog for bad-resolution reports (#301)`.
