# Gitea support: design

**Date:** 2026-09-15
**Issue:** [#193](https://github.com/devlint/GitWand/issues/193) ("Could you add an option to log in using Gitea?")
**Release:** fourth lot of v3.11.0, alongside the dev-server route audit, the history-aware LLM
fallback and the Finder-like folder navigation. The tag waits for all four.
**Implementation plan:** to be written after this design is approved.

---

## 1. Problem

A user runs GitWand against a self-hosted Gitea server. Git operations work, because they are
forge-agnostic. Everything that needs a forge API does not: there is no way to add a Gitea account,
so the PR tab and the Today panel stay locked.

Two things are missing, and only one of them is the API client:

1. **Authentication.** No Gitea entry exists in Settings > Accounts, so no credential can be stored.
2. **Detection.** `detect_provider()` (`apps/desktop/src-tauri/src/git/parse.rs:625`) matches forges
   on host substrings. A self-hosted Gitea lives on an arbitrary host such as `git.acme.io`, which
   no substring can recognise. This is the genuinely new problem: GitHub, GitLab, Bitbucket and
   Azure all have canonical hosts, and the one self-hosted case already handled (GitLab, issue #168)
   resolves through a `glab auth status --hostname` probe that has no Gitea equivalent, since Gitea
   support here does not depend on a CLI.

## 2. Scope

**In scope.** Everything the issue blocks: account creation, credential storage, remote detection,
and the read plus basic-write PR surface that makes the PR tab and Today usable. Roughly the
Bitbucket-sized surface (~20 Rust commands), not the GitLab-sized one (35).

**Out of scope, recorded in the roadmap's Later section as follow-ups.**

- Auto-merge. Gitea does expose `merge_when_checks_succeed` on its merge endpoint, so this is a
  clean follow-up rather than a missing capability.
- Submitting and dismissing reviews (reading them is in scope).
- Check annotations, file history, cross-fork PR creation, Gitea Actions logs.

Unimplemented `ForgeProvider` methods throw `ForgeNotImplementedError`, which the UI already treats
as "hide the affordance" rather than "show an error". This is the Bitbucket precedent.

## 3. Decisions

Four decisions were taken before this design, each with the alternative that was rejected.

### 3.1 Transport: PAT plus REST over `curl`

Gitea's `/api/v1` is close enough to GitHub's that response mapping is mostly mechanical, and a
token needs no extra install from the user.

Rejected: the `tea` CLI (mirrors `gh.rs` / `gitlab.rs`, but forces every Gitea user to install and
configure a CLI far less widespread than `gh`, and its JSON output is thinner than the REST API);
OAuth device flow (each self-hosted server would need an OAuth application registered by its own
admin before GitWand could authenticate, which is a worse first run than pasting a token).

### 3.2 Detection: from the account's base URL

A remote is Gitea when its host matches a configured Gitea account's host, plus the free cases
(`gitea.com`, `codeberg.org`, any host containing `gitea` or `forgejo`). Deterministic, no network
call, and it matches how the user thinks: they add the server, then it works.

Rejected: an unauthenticated `GET /api/v1/version` probe against unrecognised hosts (works before
any account exists, at the cost of a request to a host we were never told to trust, plus a cache to
keep it off every repo open); a manual per-repo override (one more setting to define, persist and
translate, for a case nobody has reported).

### 3.3 Forgejo under the same provider

Forgejo and Codeberg are API-compatible forks of the same `/api/v1`. They cost one detection arm and
no separate provider. Settings labels the forge "Gitea / Forgejo". The `ForgeName` discriminant
stays `"gitea"`.

### 3.4 dev:web routes for the read paths

GitLab, Bitbucket and Azure forge commands have no dev-server routes at all: their wrappers throw
`requires Tauri` in browser mode. That is precisely the gap v3.11.0's audit lot exists to close
(`gl_merge_mr` shipped broken because the only environment that could have caught it never ran that
code). Gitea's read commands get dev-server routes so the whole panel is drivable in `pnpm dev:web`
against a real server; the write paths keep the `requires Tauri` throw.

Rejected: full read-and-write routes (re-implements the Gitea REST layer twice and doubles the drift
surface); no routes at all (smallest lot, but the Gitea panel could then only be tested in a
packaged build, which is the failure mode being fixed elsewhere in the same release).

## 4. Architecture

| Layer | File | Change |
|---|---|---|
| Rust | `src-tauri/src/commands/gitea.rs` | New module, ~20 `#[tauri::command]` |
| Rust | `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` | Module registration, handler list |
| Rust | `src-tauri/src/git/parse.rs` | `detect_provider()` Gitea arm |
| TS transport | `src/utils/backend.ts` | Account-host matching in the `gitRemoteInfo` wrapper |
| TS transport | `src/utils/backend-gitea.ts` | New wrapper file, re-exported from `backend.ts` |
| TS provider | `src/composables/forge/GiteaProvider.ts` | `ForgeProvider` implementation |
| TS registry | `src/composables/forge/useForge.ts`, `forge/index.ts` | Lazy-loaded provider registration |
| Types | `src/composables/forge/types.ts` | `ForgeName` gains `"gitea"` |
| UI | `src/components/SettingsAccountsTab.vue` | Gitea form: server URL, username, token |
| UI | `src/utils/forgeUrls.ts` | Commit and PR web URLs from the account base URL |
| dev:web | `apps/desktop/dev-server.mjs` | 8 read routes |
| i18n | `src/locales/{en,fr,es,pt-BR,zh-CN}.ts` | Account form keys, forge label |

### 4.1 The eight dev-server routes

`/api/gitea-current-user`, `/api/gitea-list-prs`, `/api/gitea-pr-count`, `/api/gitea-get-pr`,
`/api/gitea-pr-diff`, `/api/gitea-pr-status`, `/api/gitea-pr-comments`, `/api/gitea-list-issues`.
Each is a `fetch` against the same endpoint its Rust counterpart calls. The wrappers in
`backend-gitea.ts` branch on `isTauri()` the way `backend-pr.ts` already does. Every other
`gitea_*` command throws `requires Tauri` in browser mode.

The one structural difference from every existing forge: **there is no constant API base**. Gitea has
no canonical host, so each command resolves `https://<host>/api/v1` from the account that matched the
remote, never from a hardcoded string.

## 5. Authentication and accounts

**Keychain entries.** Two, both under service `gitwand:gitea`, both written through the existing
generic `set_credential` (`src-tauri/src/commands/credentials.rs:36`), so no new keychain plumbing
is needed:

- account key `<host>:<username>`, value the personal access token;
- account key `<host>` alone, value the active username.

The second is a pointer, and it exists because Rust knows the host from the remote but not the
username: without it a keychain lookup has no key to read. Removal must therefore delete both, so
Gitea needs a forge-specific branch in `SettingsAccountsTab.onRemove` for the same reason Azure has
one. The generic path, which splits `tokenKey` at the first `/` and deletes a single entry, would
leave the pointer behind.

**Account record.** `Account.tokenKey` already encodes `"<service>/<account>"`, so
`gitwand:gitea/git.acme.io:alice` carries the host with no schema change to `useAccounts.ts`. The
host is parsed back out of `tokenKey` rather than stored in a new field.

**Settings form.** For `forge === "gitea"` the form shows Server URL, Username and Token. The server
URL is normalised to an origin (scheme forced to https when absent, trailing slash and any `/api/v1`
suffix stripped). Before the account is saved, `gitea_current_user` is called against the entered
host and token: a bad URL or a bad token fails at entry rather than at first PR load. The returned
login is compared against the entered username and a mismatch is reported.

**Security.** The token is passed to `curl` through `--config -` on stdin as
`Authorization: token <pat>` (Gitea's scheme, not `Bearer`), so it never appears in argv, in logs, or
in an error message. This follows `bitbucket.rs` and uses the existing `auth_header_config` helper in
`commands/curl_util.rs`.

## 6. Detection

Two layers, in order.

1. **Pure, in `detect_provider()`.** Returns `"gitea"` for a host containing `gitea` or `forgejo`, or
   containing `codeberg.org`. Ordered after the existing GitHub and GitLab arms so no current match
   changes. Stays a pure function of the URL, which keeps it unit-testable and keeps the
   `dev-server.mjs` mirror of the same chain honest.
2. **Account-aware, in the `gitRemoteInfo` wrapper (`src/utils/backend.ts:2447`).** When the
   backend returns `provider: "unknown"`, the remote host is compared against the hosts of the
   configured Gitea accounts. A match rewrites the provider to `"gitea"`. No network call. No match
   leaves `"unknown"`, which the UI already renders as "no forge integration" rather than falling
   back to GitHub.

   This layer sits in the frontend rather than in `git_remote_info` (`commands/ops.rs`), which is
   where an earlier draft of this design put it. Three reasons, all verified against the tree:
   `detect_provider()`'s only caller is `git_remote_info`, and that command's `provider` string is
   consumed only by the frontend, so Rust never needs to know; the accounts live in `localStorage`,
   which Rust cannot read, so passing hosts down the IPC boundary would be ceremony around data that
   only travels one way; and the `gitRemoteInfo` wrapper is the single funnel through which both the
   Tauri path and the `dev:web` path already pass, so one implementation covers both modes instead of
   a Rust change plus a `dev-server.mjs` mirror that could then drift. The pure layer 1 stays in
   `parse.rs` and keeps its parity test, so the duplicated substring chain remains locked.

`extract_remote_host()` handles both `git@host:owner/repo.git` and
`scheme://[user@]host[:port]/owner/repo.git`, and is reused as-is for the detection match, which
compares bare hosts. It is **not** enough for the API base URL: it splits on the first `:` or `/`
and therefore drops the port (`parse.rs:1932` asserts exactly that for
`ssh://git@forge.internal:2222/...`). Self-hosted Gitea commonly listens on a non-default port, the
stock Docker image on `:3000`, so `gitea.rs` parses its own host and port for the base URL rather
than routing it through the shared helper. The shared helper stays untouched: its other caller is
the `gh`/`glab auth status --hostname` probe from #168, which wants a bare host.

## 7. Command surface

All commands are named `gitea_*`. Endpoints verified against the Gitea 1.24 API reference. Twenty-one
commands in total: the twenty below plus `gitea_validate_token`, which section 5 requires so the account
form can validate before it stores anything.

**Discovery**

| Command | Endpoint |
|---|---|
| `gitea_current_user` | `GET /user` |
| `gitea_validate_token` | `GET /user` with a token supplied directly, used by the account form before anything is stored |
| `gitea_reviewer_candidates` | `GET /repos/{owner}/{repo}/collaborators` |
| `gitea_branches` | `GET /repos/{owner}/{repo}/branches` |

**Listing**

| Command | Endpoint |
|---|---|
| `gitea_list_prs` | `GET /repos/{owner}/{repo}/pulls?state=&page=&limit=` |
| `gitea_pr_count` | same, count from the response |
| `gitea_pr_files` | `GET /repos/{owner}/{repo}/pulls/{index}/files` |
| `gitea_list_issues` | `GET /repos/{owner}/{repo}/issues?type=issues&state=open` |

**Detail**

| Command | Endpoint |
|---|---|
| `gitea_get_pr` | `GET /repos/{owner}/{repo}/pulls/{index}` |
| `gitea_pr_diff` | `GET /repos/{owner}/{repo}/pulls/{index}.diff` |
| `gitea_pr_status` | `GET /repos/{owner}/{repo}/commits/{sha}/status` |

**Actions**

| Command | Endpoint |
|---|---|
| `gitea_create_pr` | `POST /repos/{owner}/{repo}/pulls` (`title`, `head`, `base`, `body`) |
| `gitea_merge_pr` | `POST /repos/{owner}/{repo}/pulls/{index}/merge` |
| `gitea_checkout_pr` | local git, no API |
| `gitea_convert_draft_to_ready` | `PATCH /repos/{owner}/{repo}/pulls/{index}` |

**Comments and reviews**

| Command | Endpoint |
|---|---|
| `gitea_pr_comments` | `GET /repos/{owner}/{repo}/issues/{index}/comments` |
| `gitea_create_comment` | `POST /repos/{owner}/{repo}/issues/{index}/comments` |
| `gitea_update_comment` | `PATCH /repos/{owner}/{repo}/issues/comments/{id}` |
| `gitea_delete_comment` | `DELETE /repos/{owner}/{repo}/issues/comments/{id}` |
| `gitea_list_reviews` | `GET /repos/{owner}/{repo}/pulls/{index}/reviews` |

`getConflictPreview` and `getHotspots` come free: both run on local git data and are already
forge-agnostic. `getFileHistory` returns an empty map, matching the placeholder the other providers
started from.

### 7.1 Two version-dependent unknowns

Both are settled against a live server during implementation, not asserted here.

- **Merge option field.** Older Gitea takes `Do` on the merge endpoint; the current documentation
  shows `merge_method`. The implementation sends the documented field and falls back on a 4xx that
  names the other, with the behaviour covered by a unit test on the request builder.
- **Diff path.** `/pulls/{index}.diff` is the documented suffix form; `/pulls/{index}/patch` is
  listed separately. If `.diff` is not reliable across supported versions, the command falls back to
  the patch endpoint.

## 8. Data mapping

Gitea's PR payload is close to GitHub's but not identical. The mapping decisions that matter:

- `index` is the PR number (`number` in our types). Gitea also exposes `id`, which is a global
  database id and must not be used.
- Draft state comes from the `draft` boolean, not from a title prefix.
- `mergeable` is a boolean; our `PullRequestDetail.mergeable` is a string, so it maps to
  `"MERGEABLE"` / `"CONFLICTING"` / `""` when absent.
- CI status comes from the combined-status endpoint's `state` (`success` / `pending` / `failure`),
  mapped onto the existing `CICheck` shape. Gitea Actions job detail is out of scope.
- PR comments are issue comments; Gitea has no line-anchored review-comment concept reachable from
  this endpoint, so `listComments` returns conversation comments and the inline-comment affordances
  stay hidden.

Mapping lives in pure functions in `gitea.rs` so it is unit-testable without a server.

## 9. Testing

- **Rust unit tests** in `gitea.rs`: base-URL normalisation, owner/repo parsing across HTTPS and SSH
  remotes including a non-default port, the response mappings from section 8, and the merge-option
  request builder from 7.1.
- **Rust detection tests** in `parse.rs`: `codeberg.org`, a `gitea.` host, a `forgejo` host, a
  self-hosted host matched through an account, and a host that must stay `unknown`.
- **Vitest** for `GiteaProvider`, mirroring `forge/__tests__/GitLabProvider.test.ts`: mocked backend
  wrappers, one test per implemented method, plus assertions that the unimplemented ones throw
  `ForgeNotImplementedError`.
- **Parity test** `apps/desktop/tests/parity/gitea-remote-info.test.mjs` for detection, the one
  deterministic piece shared by Rust and the dev-server.
- **Manual QA** in `pnpm dev:web` against a real Gitea instance before the PR: add an account, open
  the PR tab, read a PR, its diff, its CI status and its comments, and check Today.

What is deliberately not covered: the REST reads have no parity test, because the dev-server and Rust
would both be calling the same live server and there is none in CI. The mapping unit tests are the
coverage. This is stated so the suite is not read as proving more than it does.

## 10. Risks

- **No live server in CI.** First contact with a real Gitea happens in manual QA. The two unknowns in
  7.1 are the expected surprises; an unexpected third is possible.
- **dev-server token source differs from Rust.** The dev-server cannot read the OS keychain, so its
  routes read `GITWAND_GITEA_TOKEN` and return a clear "not configured" error when it is absent. The
  two auth paths are therefore genuinely different, which is the drift class the audit lot is about.
  The route comments say so explicitly rather than implying parity.
- **Self-hosted TLS.** A Gitea behind a private CA fails the `curl` call. The real curl error is
  surfaced. No certificate-bypass switch is added.
- **Gitea version spread.** Self-hosted instances lag. Endpoints are chosen from the stable surface
  (`/pulls`, `/issues/{index}/comments`, `/commits/{ref}/status`), all present well before 1.20.

## 11. Bookkeeping

In the implementation PR: `roadmap.md` gains Gitea as the fourth v3.11.0 lot and the deferred items
from section 2 in Later; `CHANGELOG.md` gains an `[Unreleased]` Added entry; issue #193 is closed by
the PR. `website/changelog.md` is updated with its narrative counterpart at tag time, in the same
commit as the root changelog.
