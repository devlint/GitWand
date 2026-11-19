# Issue templates — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** offer the target repository's issue templates in the blank issue form. Markdown templates are used as they are; issue forms (`.yml`) are flattened into Markdown.

**Architecture:**
- A Tauri command reads the template files of a target (the Settings token's REST API, else `gh`, as the label/assignee pickers do). Its dev-server mirror shares the same rules.
- Pure TypeScript parses them into templates (front matter, YAML forms flattened, `config.yml`).
- `useCreateIssue` holds the list and applies a choice; `CreateIssueModal` shows a "Template" row in the blank form.

**Tech stack:** Rust (Tauri 2), Vue 3, TypeScript, vitest, the `yaml` package (already used by `@gitwand/core`).

**Spec:** `docs/superpowers/specs/2026-11-19-issue-templates-design.md`

## Global constraints

**Lookup order:**
1. `.github/ISSUE_TEMPLATE/` (`*.md`, `*.yml`, `*.yaml` + `config.yml`);
2. else `.github/ISSUE_TEMPLATE.md`, `ISSUE_TEMPLATE.md`, `docs/ISSUE_TEMPLATE.md`;
3. else the same two steps in `{owner}/.github`.

**Limits:**
- At most 20 template files (`config.yml` not counted), sorted by file name.
- A file over 64 KB (65_536 bytes, by the API's `size`) is skipped.
- A 404 means "not there"; any other error fails the read.

**Picker:**
- Blank form only. "Blank issue" is always offered.
- Choosing replaces the title and description, asking first when either was edited.

**Labels and assignees:**
- Only those offered by the target's pickers are selected.
- Front matter `labels` and `assignees` may be a list or a comma-separated string.

**Form flattening (exact strings):**
- `markdown` → `<!-- {value trimmed} -->`
- `textarea` and `input` → `### {label}` (+ ` *` if required), a blank line, then:
  - the `value`, if any;
  - otherwise, for a textarea with `render: {lang}`, `` ```{lang}\n\n``` ``;
  - otherwise `<!-- {placeholder} -->` if there is a placeholder.
- `dropdown` → `### {label}`, then the default option (`default` index), or else `<!-- one of: {a}, {b} -->`.
- `checkboxes` → `### {label}`, then one `- [ ] {option.label}` per option.
- Sections are separated by a blank line.

**Rules for every task:**
- YAML is loaded on demand (`await import("yaml")`); the main chunk stays ≤ 960 KB.
- All 5 locales; the Tauri command gets its `backend.ts` wrapper, its `commandRegistry` entry and its dev-server route.

## Review focus

1. **A template whose YAML or front matter does not parse:** that template is skipped, the others stay listed.
2. **No templates at all, and no `{owner}/.github` repository (404 everywhere):** the row shows only "Blank issue" and no error is reported.
3. **The target is switched (origin ↔ parent) while templates load:** the late list for the old target is never shown.
4. **The user types, then picks a template:** the confirmation is asked, and cancel keeps the text.
5. **A template with no `name`:** it is listed under its file name.

---

### Task 1: Rust command `gh_issue_templates`

**Files:**
- Modify `apps/desktop/src-tauri/src/commands/gh_issues.rs` (new command and pure helpers + tests).
- Modify `src-tauri/src/lib.rs` (register the command).

**Interfaces:**
- **Produces:**
  - `#[derive(Serialize)] pub(crate) struct TemplateFile { path: String, content: String }`
  - `#[derive(Serialize)] pub(crate) struct IssueTemplateFiles { source: String /* nwo read from */, files: Vec<TemplateFile> }`
  - `gh_issue_templates(cwd: String, repo: String) -> Result<IssueTemplateFiles, String>`
- **Pure core**, tested with a fake fetcher:
  `fn template_files(owner_repo: &str, get: &dyn Fn(&str, &str) -> Result<Option<serde_json::Value>, String>) -> Result<IssueTemplateFiles, String>`.
  - `get(nwo, path)` returns `Ok(None)` on a 404.
  - Each file's content is the base64 `content` of `GET repos/{nwo}/contents/{path}`, decoded (newlines in the base64 ignored).

- [ ] **Step 1: write the failing tests** in `gh_issues.rs`'s test module:
  - `templates_are_read_from_the_template_directory_sorted_and_capped`: a directory of 22 `.md` files + `config.yml` + `notes.txt` gives 20 sorted templates + `config.yml`, and no `.txt`.
  - `a_file_over_64_kib_is_skipped`.
  - `falls_back_to_the_single_template_files_then_the_owner_dot_github_repo`: the source is `owner/.github`.
  - `nothing_anywhere_is_an_empty_list`.
  - `a_non_404_error_fails_the_read`.
- [ ] **Step 2:** `cargo test --lib gh_issues -- templates` → FAIL (function missing).
- [ ] **Step 3: implement.** The command resolves the target with `resolve_issue_target(&cwd, &repo, false, token)`. For `{owner}/.github` it uses `origin.sibling(format!("{owner}/.github"))`. `get` calls `api_get` and maps an error containing "404" or "Not Found" to `Ok(None)`. Register the command in `lib.rs`.
- [ ] **Step 4:** run `cargo test --lib gh_issues` (PASS), then `cargo fmt` and `cargo clippy --all-targets -- -D warnings` (clean).
- [ ] **Step 5: commit:** `feat(issues): read a target's issue templates (#301)`

### Task 2: Wrapper, registry, dev-server route

**Files:**
- `src/utils/backend.ts`: `ghIssueTemplates(cwd: string, repo: string): Promise<IssueTemplateFiles>` + types.
- `src/utils/commandRegistry.ts`: `gh_issue_templates: { route: "/api/gh-issue-templates" }`.
- `dev-issues.mjs`: `devTemplateFiles(ownerRepo, get)` with the same rules, where `get` is async and resolves `null` on a 404.
- `dev-server.mjs`: route `GET /api/gh-issue-templates?cwd&repo`, plus its line in the route list.
- Test: `src/__tests__/issues.devserver.test.ts` (the existing file), with the same five cases as Task 1 on `devTemplateFiles`.

- [ ] **Steps:** the tests fail → implement → `npx vitest run src/__tests__/issues.devserver.test.ts src/utils/__tests__/commandRegistry.test.ts` passes → commit `feat(issues): issue templates over IPC and the dev server (#301)`.

### Task 3: Parsing and flattening

**Files:**
- Create `src/utils/issueTemplates.ts`.
- Test `src/utils/__tests__/issueTemplates.test.ts`.
- `apps/desktop/package.json`: add the dependency `"yaml": "^2.9.0"` (`pnpm --filter gitwand-desktop add yaml@^2.9.0`; it is already in the store through core).

**Interfaces:**

```ts
export interface IssueTemplate { id: string /* file path */; name: string; about: string; title: string; labels: string[]; assignees: string[]; body: string }
export interface IssueTemplateSet { templates: IssueTemplate[]; blankAllowed: boolean; contactLinks: { name: string; url: string; about: string }[] }
export function parseTemplateSet(files: { path: string; content: string }[], parseYaml: (s: string) => unknown): IssueTemplateSet
export function flattenForm(body: unknown[]): string
export async function loadTemplateSet(files: { path: string; content: string }[]): Promise<IssueTemplateSet> // imports "yaml" on demand
```

- [ ] **Step 1: failing tests** (using the real `yaml.parse`):
  - a Markdown template with front matter (`name`, `about`, `title`, `labels: bug, ui`, `assignees: [a]`) → its fields, and the body without the front matter;
  - a Markdown template without front matter → name = file name, body = whole file;
  - each form item kind → its exact flattened string (Global constraints), plus a required `*` and `render`;
  - a broken YAML template is skipped and the others are kept;
  - `config.yml` `blank_issues_enabled: false` + `contact_links` → `blankAllowed: false`, links listed; with no config → `true`, `[]`.
- [ ] **Step 2:** watch them fail. **Step 3:** implement. **Step 4:** `npx vitest run src/utils/__tests__/issueTemplates.test.ts` passes.
- [ ] **Step 5: commit:** `feat(issues): parse issue templates and flatten issue forms (#301)`.

### Task 4: Form state, picker, i18n, CHANGELOG

**Files:**
- `src/composables/useCreateIssue.ts`:
  - state `templateSet: Ref<IssueTemplateSet | null>`, `templatesLoading: Ref<boolean>`, `templateId: Ref<string | null>`, `blankForm: Ref<boolean>` (true when `open()` got no prefill);
  - `applyTemplate(id: string | null): void` sets title, body, labels and assignees;
  - deps: `issueTemplates?: (cwd, repo) => Promise<{ path; content }[]>`, by default `ghIssueTemplates(...).then(r => r.files)`.
- `src/components/CreateIssueModal.vue`:
  - "Template" row (select) shown when `blankForm` and the set has templates;
  - the "expects a template" hint when `!blankAllowed`;
  - contact links;
  - on change, asks before replacing if title or body differ from `initial` (the same `askConfirm` as `onSwitch`).
- 5 locales: `createIssue.template.{label, blank, expectsTemplate, contact}`.
- `CHANGELOG.md` (Unreleased, with the Edit tool).
- Tests:
  - `src/composables/__tests__/useCreateIssue-templates.test.ts`;
  - `src/components/__tests__/CreateIssueModal-templates.test.ts` (jsdom).

**Interfaces:**
- **Consumes:** Task 2 `ghIssueTemplates`, Task 3 `loadTemplateSet`.

- [ ] **Step 1: failing tests.**
  - **Composable:**
    - templates load for the default target and are read again on `setRepo`; a late answer for the old target is dropped;
    - no templates in a prefilled form (`open(prefill)`);
    - `applyTemplate` fills title and body, labels limited to the target's labels, assignees to the offered ones;
    - `applyTemplate(null)` clears.
  - **Modal:**
    - the row shows with templates, "Blank issue" first;
    - the confirmation is asked after an edit, and cancel keeps the text;
    - hint and contact links shown;
    - no row when the set is empty or the form is prefilled.
- [ ] **Step 2: watch them fail. Step 3: implement.**
- [ ] **Step 4:** `npx vitest run src/` all green; `npx vue-tsc --noEmit -p tsconfig.json` clean; `npx vite build && node perf/bundle-check.mjs` OK.
- [ ] **Step 5: commit:** `feat(issues): pick an issue template in the blank form (#301)`.
