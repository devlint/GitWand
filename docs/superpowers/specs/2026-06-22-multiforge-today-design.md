# Multi-forge aggregation for "Today" — Design

- **Date:** 2026-06-22
- **Branch:** `feat/launchpad-triaged-inbox` (v2.29 "Today" Phase 2)
- **Status:** Approved design — ready for implementation plan
- **Related:** issue #73 (Launchpad failed without `gh`; fixed in `1755be6`), roadmap v2.29 "Today"

## Problem

"Today" (the renamed Launchpad) aggregates a user's PRs and Issues across every
repo in a workspace, but its two aggregators are GitHub-only:

- `workspace_prs_all` and `workspace_issues_all` (Rust) fetch only GitHub data.
- A workspace mixing GitHub / GitLab / Bitbucket / Azure repos shows nothing for
  the non-GitHub repos.

GitWand already supports all four forges for **single-repo** PR workflows via a
`ForgeProvider` abstraction (`getProviderByUrl` / `useForge`), each with its own
keychain-stored account. "Today" is the last surface that never adopted that
abstraction.

## Goals

- Aggregate **open PRs/MRs across all four forges** (GitHub, GitLab, Bitbucket,
  Azure) into Today.
- Aggregate **open Issues across GitHub, GitLab, Bitbucket** into Today.
- For a forge the user has not connected, show a **discreet "connect" invitation**
  — never a red per-row error (the #73 failure mode).

## Non-goals (deferred)

- **Azure Issues** — Azure has no issues, only Work Items (Bug/Task/User Story/
  Epic), a different model. Azure contributes PRs only this iteration.
- **Team tab multi-forge** — reviewer-candidate enrichment stays GitHub-only.
- **Active mutations** (nudge / auto-merge) — already deferred to Today Phase 3.

## Decisions (from brainstorming)

1. **Scope:** PRs (4 forges) + Issues (GitHub/GitLab/Bitbucket). Azure Issues deferred.
2. **Architecture:** Approach B — frontend aggregation over `ForgeProvider`, not a
   Rust multi-forge aggregator. Rationale: every single-repo PR/Issue flow already
   routes through `ForgeProvider`; Today is the last GitHub-only holdout. Async
   forge commands are called naturally with `await`. The notification poller reads
   composable state, so it needs no rewiring. As a side-effect, GitHub PRs in Today
   are fetched via the per-repo `ghListPrs`, which already routes through the
   OAuth/REST path — so #73's class of failure is structurally avoided.
3. **Not-connected forge:** invitation banner, never an error.
4. **No explicit concurrency cap** on the per-repo `Promise.all` (typical 5–20 repo
   workspaces; each command parallelizes its own enrichment; runs on the ~60s poller).
5. **Azure repos contribute PRs but no Issues.**
6. **Leave the now-unused Rust `workspace_prs_all` / `workspace_issues_all` in place**
   (not deleted) — harmless, and the #73 REST fix stays as their fallback.

## Architecture & data flow

Today's aggregation moves from single GitHub-only backend calls to **per-repo
dispatch over `ForgeProvider`**, in the frontend composables.

### PRs — `useLaunchpadPrs`
- **Before:** `workspacePrsAll(repos)` — one IPC, GitHub-only.
- **After:** for each repo → resolve provider via `forgeFromRemoteInfo(remote)` →
  `provider.listPRs(cwd, { state: 'open', limit: 10 })`; `Promise.all` over repos;
  flatten into the existing `PrWithRepo[]` shape (unchanged downstream contract).
- Each provider call maps to the existing per-repo command: `ghListPrs` /
  `glListMrs` / `bbListPrs` / `azListPrs`, all already returning `PullRequest`.

### Issues — `useLaunchpadIssues`
- **Before:** `workspaceIssuesAll(repos, filter)` — one IPC, GitHub-only.
- **After:** for each repo → `provider.listIssues(cwd, { filter })`; `Promise.all`;
  flatten into the existing issue shape.
- Providers that lack `listIssues` (Azure) contribute nothing — see interface change.

### Concurrency
`Promise.all` over repos. Each command is async on Tauri's thread pool and
parallelizes its own enrichment internally. No explicit cap.

### Status of the old Rust aggregators
`workspace_prs_all` / `workspace_issues_all` are no longer called by Today. They
remain in the codebase unchanged (potential reuse / fallback; the #73 REST routing
stays).

## Backend additions — per-repo issue list commands

Issues were only ever fetched via the workspace aggregator; no per-repo issue
command exists for any forge. Add three thin commands returning `Vec<Issue>`:

Today's Issues filter is one of: `""` (all open), `assigned`, `created`,
`mentioned` — the same set the GitHub path already uses. Each forge maps what it
**natively supports**; any filter a forge cannot express falls back to **all open
issues for that repo** (best-effort, never an error). Default per-repo `limit` is
100 (matches today's `workspace_issues_all`).

| Command | Endpoint / source | Filter mapping |
|---|---|---|
| `gh_list_issues(cwd, filter, limit)` | wraps `github_api::rest_list_issues` (+ `gh` fallback), reusing the #73 routing rule | all four modes natively |
| `gl_list_issues(cwd, filter, limit)` | GitLab `GET /projects/:id/issues?state=opened` | `assigned`→`scope=assigned_to_me`, `created`→`author_username=<me>`; `mentioned`→fallback to all-open (no native filter) |
| `bb_list_issues(cwd, filter, limit)` | Bitbucket `GET /repositories/{ws}/{slug}/issues?q=state="new"` (open states) | `assigned`→`assignee.username`, `created`→`reporter.username`; `mentioned`→fallback to all-open |

- Resolving `<me>` for the `assigned`/`created` filters happens **backend-side**
  inside each command, mirroring `github_api::rest_current_user` (GitLab/Bitbucket
  modules already resolve the current user for their other commands). Resolve once
  per command call.
- Bitbucket's issue tracker is **opt-in per repo**: a `404` ⇒ return an empty list,
  not an error.
- Each command gets a typed wrapper in `apps/desktop/src/utils/backend.ts`
  (AGENTS.md IPC rule) and a `dev-server.mjs` mock route (dev:web parity rule).
- Map each forge's issue JSON into the existing `Issue` IPC struct (number, title,
  state, author, assignees, labels, url, createdAt, updatedAt, milestone). Fields a
  forge does not provide are left empty.

## `ForgeProvider` interface change

Add to `apps/desktop/src/composables/forge/types.ts`:

```ts
/** Open issues for the repo. Optional: forges without an issue concept omit it. */
listIssues?(cwd: string, opts?: ListIssuesOptions): Promise<Issue[]>;
```

- Implement in `GitHubProvider`, `GitLabProvider`, `BitbucketProvider` (each calling
  its new backend command).
- `AzureProvider` **omits** it (optional method, mirroring `listIssueComments?`).
- Today treats a missing `listIssues` as "Issues unsupported for this forge" → Azure
  repos contribute no issues.

## Not-connected forge UX

Before dispatching, group workspace repos by forge and check connection via
`useAccounts` / `getCurrentForgeAccount(forge)`:

- **Connected** forge → fetch normally.
- **Not-connected** forge with ≥1 repo → do **not** call the backend; collect into a
  `needsConnection` list rendered as a discreet per-forge banner:
  *"Connect your GitLab account to see N repositories →"* linking to Settings →
  Accounts. No red error rows.

This is the direct, general fix for the #73 failure class.

## Notifications & Team (graceful degradation)

- **Notifications** (`useLaunchpadNotifications`) read composable state (`PrWithRepo`)
  — no rewiring. CI-flip detection works for all forges (every `listPRs` populates
  `checksRollup`); review-request / new-comment diffs stay GitHub-rich and fire less
  for forges that do not populate those fields. Acceptable degradation.
- **Team tab** stays GitHub-only this iteration.

## Testing

- **Frontend:** extend `useLaunchpadPrs` / `useLaunchpadIssues` tests with multi-forge
  repo fixtures and a not-connected-forge case (mock providers; no real git).
- **Backend:** per AGENTS.md, real temporary git repos for the new list commands
  where feasible; otherwise parse-level tests on the JSON → `Issue` mappers.
- **dev:web:** add mock routes for the three new commands so `pnpm dev:web` renders
  multi-forge Today without a backend.

## i18n

New user-facing strings (connect-forge banner; any "Issues unsupported on Azure"
affordance if surfaced) added to all 5 locales: `en`, `fr`, `es`, `pt-BR`, `zh-CN`.

## Files touched (anticipated)

- `apps/desktop/src/composables/useLaunchpadPrs.ts` — per-repo provider dispatch.
- `apps/desktop/src/composables/useLaunchpadIssues.ts` — per-repo provider dispatch.
- `apps/desktop/src/composables/forge/types.ts` — `listIssues?` on the interface.
- `apps/desktop/src/composables/forge/{GitHub,GitLab,Bitbucket}Provider.ts` — impls.
- `apps/desktop/src/components/LaunchpadView.vue` (and/or inbox composable) —
  not-connected banner.
- `apps/desktop/src/utils/backend.ts` — three issue-list wrappers.
- `apps/desktop/dev-server.mjs` — three mock routes.
- `apps/desktop/src-tauri/src/commands/{gh,gitlab,bitbucket}.rs` — three list commands.
- `apps/desktop/src-tauri/src/lib.rs` — register the new commands.
- `apps/desktop/src/locales/*.json` — new strings ×5.
- Tests under `apps/desktop/src/composables/__tests__/` and the Rust modules.
