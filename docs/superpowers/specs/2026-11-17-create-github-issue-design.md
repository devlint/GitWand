# Create GitHub issues from inside GitWand — design (issue #301)

Requested by Pannboo in [#301](https://github.com/devlint/GitWand/issues/301).

## Why

Spotting a bug or a TODO while reviewing a diff, resolving a conflict or reading
history today means leaving GitWand for the browser, finding the repository and
filling the form there. The context being looked at (the commit, the lines) is
lost on the way, and has to be copied by hand. The point of the feature is to
file the issue **without leaving what you are looking at**, with that context
attached automatically.

## Goals

- File an issue on the current repository's GitHub from inside the app: title,
  Markdown body with preview, optional labels, assignees and milestone.
- Reach the form from wherever the user is: the toolbar, the ⌘K palette, a
  keyboard shortcut, and — the most valuable part — from the thing being looked
  at (a commit first, a diff selection next), prefilled with its context.
- Confirm the creation with a link to the new issue.

## Non-goals (for now)

- GitLab, Gitea, Bitbucket, Azure issue creation. The method is added to
  `ForgeProvider` so they can follow, but only GitHub implements it.
- Any target other than `origin` or, on a fork, its parent on GitHub (no
  free-form `owner/repo`, no other remote).
- Issue templates (`.github/ISSUE_TEMPLATE/`), the MCP tool, inserting `#N` in
  the commit message, a list of open issues with "link to commit".
- New authentication (OAuth device flow): the existing auth is reused.

## Anti-goals

- The form must not take the user away from the view they were in. A full-screen
  view would defeat the purpose of the issue.
- No issue may be filed on the wrong repository silently. In particular `gh`
  must not pick an `upstream` remote over `origin` (the #298 bug).
- No untrusted Markdown injected unsanitised: the preview goes through
  `useSafeHtml`, like every rendered body in the app.

## Delivery in several PRs (agreed with the user)

1. **PR 1 — the form and its first entry points** (this design, in detail):
   backend create + label/milestone reads, the modal, toolbar / palette /
   shortcut entry points, "Create issue from commit" in the commit graph menu,
   success toast with a link.
2. **PR 2 — from a diff selection**: a way to pick a line range in a diff and
   file an issue with a permalink and a code block. Needs a selection mechanism
   the diff views do not have today (see "Findings"), and a blob-permalink
   helper.
3. **PR 3 — "Report a bad resolution"** from an auto/AI-resolved conflict, with
   the hunk and the explanation.
4. **Later, as separate PRs**: `#N` into the commit message being written,
   issue templates, `gitwand_create_issue` MCP tool.

PR 2 and later are sketched here only so PR 1 leaves room for them; each gets
its own short design pass before it is built.

## Approaches considered (where the form lives)

- **A. A modal over the current view — chosen by the user.** Keeps the commit or
  diff on screen behind it, which is the point of the issue; `BaseModal` exists;
  one component serves every entry point. Cost: less room, so the Markdown
  preview is a Write / Preview tab switch rather than side by side.
- B. A full-screen view like `PrCreateView`. Consistent with PR creation and
  roomy, but navigates away from the context — the opposite of what is asked.
- C. A side panel. Context and form side by side, but the app has no such panel
  today: a new layout component to make work in every view.

Backend: one sensible way, same as PR creation — REST with the account token via
`github_api::with_rest`, else `gh issue create` with the target repo named
explicitly.

## Findings that shape the design

- Issues are read today (Launchpad, `IssueDetailView`, `useIssuePanel`) through
  `gh*` wrappers directly, GitHub only. `ForgeProvider` has an optional
  `listIssues?`; there is no create method anywhere, nor any read of a repo's
  labels or milestones.
- Assignable users: `gh_list_reviewer_candidates` already GETs
  `/repos/{o}/{r}/assignees` (REST and `gh` paths) — reused for the assignee
  picker.
- ⌘K palette: `SearchPalette.vue` renders `paletteActions` built in `App.vue`
  (`paletteActions` computed + `onPaletteAction` switch).
- Shortcuts: `App.vue` `onKeyDown`; the help list is `HelpView.vue` `shortcuts`.
- Toolbar: `AppHeader.vue` `.header-actions` buttons (Stash, Tags, Worktrees…),
  each with collapse keys.
- Commit menu: `CommitGraph.vue` is the live one (`CommitLog.vue` is imported
  nowhere). Items are hand-written `<li>`s emitting kebab-case events handled in
  `App.vue` / `useCommitActions.ts`. Entry type `GitLogEntry`
  (`hash, hashFull, author, email, date, message, body, …`).
- Toasts: `showDetailToast(title, detail, ms)` in `App.vue` is text only;
  `useUndoToast` carries only an Undo action. No toast carries a link today.
- Diffs: `DiffViewer` (working tree) has per-line checkboxes for partial staging
  but no context menu nor range selection; commit history uses
  `CommitDiffViewer`, the PR diff `PrInlineDiff`. Hence diff selection is its
  own PR.
- URL helpers (`forgeCommitUrl`) hardcode `github.com`; the backend knows GHE
  hosts. Links shown after creation use the URL GitHub returns, never a built one.

## Design of PR 1

### Target repository (decided with the user)

GitHub turns issues off on new forks by default, and the requester likely works
from a fork (they reported #298). So:

- **Not a fork:** the target is `origin`'s GitHub repository.
- **A fork:** the candidates are `origin` and its parent (from the GitHub API's
  `parent.full_name`, not from an `upstream` remote, which may be absent or
  unrelated — #298). Default: `origin` if its issues are on, else the parent. The
  modal shows a two-way selector; a candidate whose issues are off is shown
  disabled with the reason.
- **No candidate has issues on:** the entry points stay visible but the modal
  says issues are disabled on the repository, with no form to fill.
- The chosen target is always shown in the modal (`owner/repo`) so the user sees
  where the issue goes.
- The backend accepts a target only if it is one of those candidates,
  recomputed server-side; the frontend's string is never trusted as is.
  *(Builder's call.)*
- Both paths name the repository explicitly (REST URL; `gh --repo
  host/owner/repo`), as `gh_create_pr` does since #298.

Known inconsistency, unchanged: the `gh` fallback of `gh_list_issues` reads the
parent's issues on a fork (`gh_base_cmd`), already a roadmap item.

### Backend (Rust + dev-server + IPC)

Four new commands, each with a `backend.ts` wrapper, a `commandRegistry.ts`
entry and a `dev-server.mjs` route:

- `gh_issue_targets(cwd)` → `{ repo: "owner/repo", hasIssues: bool,
  isOrigin: bool }[]` plus the default: `origin`'s repo (`GET /repos/{o}/{r}`:
  `has_issues`, `fork`, `parent`), then its parent when it is a fork
  (`has_issues` read from the parent). Empty when `origin` is not GitHub — that
  is also what availability is derived from.
- `gh_create_issue(cwd, repo, title, body, labels?, assignees?, milestone?)` →
  `{ number, url }`; `repo` must be one of `gh_issue_targets`.
  - REST: `POST /repos/{o}/{r}/issues` with `title`, `body`, `labels`,
    `assignees`, `milestone` (number).
  - `gh` fallback: `gh api -X POST repos/{nwo}/issues --input -` on the target's
    host, the same JSON payload on stdin (never in argv: it can be long and
    contain anything). Same payload as REST, and the JSON answer gives
    `number` and `html_url` directly. *(Planning refinement of the earlier
    `gh issue create` idea, which would have needed milestone titles and
    stdout parsing.)*
  - Empty title refused before any call.
- `gh_list_labels(cwd, repo)` → `{ name, color, description? }[]`
  (`/repos/{o}/{r}/labels`, paginated up to a bound).
- `gh_list_milestones(cwd, repo)` → `{ number, title, dueOn? }[]` (open ones,
  `/repos/{o}/{r}/milestones?state=open`).

Pickers follow the selected target, so they are reloaded when it changes.
Assignees: `gh_list_reviewer_candidates` reads `origin` only; it gets an
optional `repo` (validated the same way) so the parent's assignees can be
listed. *(Builder's call.)*

Lack of permission (labels/assignees/milestone need triage rights; GitHub
silently drops them for others on REST, `gh` errors): the pickers are optional
and a failed read leaves them empty with no error; a create error is shown in
the modal with GitHub's message, the form kept intact.

### Frontend

- `ForgeProvider.createIssue?(cwd, input)` (+ `listLabels?`, `listMilestones?`),
  implemented by `GitHubProvider` only. Availability is **not** derived from
  `useForge` alone (it falls back to GitHub with no remote, an unknown forge or a
  failed `gitRemoteInfo`): it requires `origin` to resolve to a GitHub
  repository on the backend (`gh_origin_repo` / `owner_repo` returning a repo).
  *(Builder's call, from the design review.)*
- `composables/useCreateIssue.ts`: form state (title, body, labels, assignees,
  milestone), lazy loading of the pickers when the modal opens, submit, error,
  and an `open(prefill?)` API so every entry point goes through one place. A
  single instance provided from `App.vue`.
- `components/CreateIssueModal.vue` on `BaseModal`:
  - shows the target `owner/repo`;
  - title (required, focused), body textarea with Write / Preview tabs (preview
    through `useSafeHtml` / the existing markdown renderer);
  - labels, assignees, milestone pickers, all optional;
  - Create / Cancel; ⌘Enter submits; Escape cancels — with a confirmation only
    if the user typed something beyond the prefill.
- Entry points (all hidden when not GitHub):
  - toolbar: a "New issue" button in `.header-actions` with collapse keys;
  - ⌘K: a "New issue" palette action;
  - keyboard shortcut (proposed ⌘⇧I — free today), added to `HelpView`;
  - commit graph context menu: "Create issue from commit", prefilling
    - title: the commit summary,
    - body: a short block with the short SHA, the author, and the full message
      in a quote. The SHA is linked to the commit (URL built from the origin
      remote; GHE host taken from the remote, not hardcoded) **only when a
      remote-tracking ref contains the commit**; an unpushed commit gets the
      full SHA unlinked, so a filed issue never carries a 404 link. The
      reachability answer is passed to the prefill builder, which stays a pure
      function. *(Builder's call, from the design review.)*
- After creation: the modal closes and a toast says "Issue #N created" with an
  "Open" action opening the URL GitHub returned. The app toast gets an optional
  link/action (smallest change to `showDetailToast` and its template); used only
  here for now.
- i18n: every string in the 5 locales.

### Testing

- Rust: target resolution (not a fork; fork with issues on / off; parent with
  issues off; a `repo` argument that is not a candidate is refused), request
  building for both paths (title/body/labels/assignees/milestone,
  body on stdin, `--repo` always set), URL→number parsing, empty-title refusal.
- Dev-server route parity where deterministic (argument validation).
- Frontend: `useCreateIssue` (prefill, picker loading failures, submit success /
  error keeps the form), the commit prefill builder, the modal (required title,
  preview sanitised, ⌘Enter), entry points hidden off GitHub.
- Manual QA under `pnpm dev:web` on a real repository (a test issue on a repo
  the user designates; issues created during QA are closed afterwards).

## Left to the builder

- Exact visual layout of the pickers (reuse whatever chip/select pattern
  `PrCreateView` uses for reviewers).
- Label pagination bound and caching of picker data per repo for the session.
- Exact wording of the strings.
