---
title: "Inline GitLab discussions, Bitbucket CI checks, and forge-agnostic intelligence: GitWand v2.14"
description: "v2.14 closes the stubs left open in v2.10. GitLab gets diff-line comment anchoring via the Discussions API, Bitbucket gets CI status checks and draft-to-ready conversion, all three forges get updateComment and deleteComment, and the conflict preview and hotspot analysis become forge-agnostic. And since Linear Diffs launched the same week — a side-by-side of what each approach delivers."
date: 2026-05-20
head:
  - - meta
    - property: og:title
      content: "Inline GitLab discussions, Bitbucket CI checks, and forge-agnostic intelligence: GitWand v2.14"
  - - meta
    - property: og:description
      content: "v2.14 closes the ForgeNotImplementedError stubs from v2.10. GitLab diff-line discussions, Bitbucket CI checks and draft-to-ready, updateComment and deleteComment on all three forges, and forge-agnostic conflict preview and hotspot analysis."
  - - meta
    - name: twitter:title
      content: "Inline GitLab discussions, Bitbucket CI checks, and forge-agnostic intelligence: GitWand v2.14"
---

# Forge completeness: GitWand v2.14

`@gitwand/desktop@2.14.0` closes the stubs that shipped as `ForgeNotImplementedError` in v2.10. When we built the `ForgeProvider` abstraction eight weeks ago, three honest gaps remained: inline diff-line comments on GitLab, CI checks and draft conversion on Bitbucket, and the conflict/hotspot intelligence panel that was hardcoded to GitHub. v2.14 removes all of them.

This also happens to be the week Linear announced their Diffs feature — review PRs without leaving your issue tracker. We'll get to that at the end, because the comparison is instructive.

---

## What was deferred from v2.10

The [v2.10 article](/blog/v2-10-forge-integrations) was upfront about what wasn't done yet. The `ForgeProvider` interface had three categories of stubs:

**GitLab:** `updateComment` and `deleteComment` — both require the MR IID alongside the note ID, and the interface only took a `commentId`. The interface needed an optional `prNumber` parameter. Also deferred: diff-line anchoring via GitLab's Discussions API (v2.10 posted general notes, not anchored comments).

**Bitbucket:** `getCIChecks` — wired to a REST endpoint that just needed plumbing. `convertDraftToReady` — Bitbucket has no native draft concept; the workaround is stripping `"Draft: "` from the PR title. Same `updateComment`/`deleteComment` gap as GitLab.

**Intelligence (all forges):** `getConflictPreview` and `getHotspots` were gated behind `forge.name === "github"` because nobody had confirmed they'd work on GitLab and Bitbucket repos. They're implemented on local git data — `git merge-tree` and a commit graph walk — with no forge API call. The gate was conservative, not technical.

---

## GitLab: diff-line anchoring via the Discussions API

The GitLab Notes API (`POST /projects/:id/merge_requests/:iid/notes`) posts a comment attached to the MR, but not to a specific line. Anchoring a comment to a diff position requires the Discussions API instead:

```
POST /projects/:id/merge_requests/:iid/discussions
{
  "body": "...",
  "position": {
    "position_type": "text",
    "base_sha": "...",
    "start_sha": "...",
    "head_sha": "...",
    "old_path": "src/foo.ts",
    "new_path": "src/foo.ts",
    "old_line": null,
    "new_line": 42
  }
}
```

The three SHAs come from the MR itself (`diffRefs` in the GitLab API). `old_line` is `null` for additions, `new_line` is `null` for deletions. For context lines, both are set.

The implementation in `gitlab.rs` fetches `diffRefs` once per MR and caches them alongside the MR detail. When `createComment` is called with a `line` parameter, it posts to the Discussions endpoint; without one, it falls back to the Notes endpoint (general review comments). The mapping is transparent to `PrDetailView.vue` — it calls `forge.createComment(cwd, prNumber, { body, line, path })` and the provider handles the routing.

`updateComment` and `deleteComment` on GitLab needed the MR IID alongside the note/discussion ID because GitLab's REST paths are:

```
PUT  /projects/:id/merge_requests/:iid/notes/:note_id
DELETE /projects/:id/merge_requests/:iid/notes/:note_id
```

The `ForgeProvider` interface gained an optional `prNumber` context parameter on both methods. GitHub and Bitbucket ignore it (their paths only need the comment ID). GitLab uses it. The call sites in `PrDetailView.vue` already had access to `prNumber` and pass it through.

---

## Bitbucket: CI checks, draft conversion, and comment CRUD

### CI checks

Bitbucket Pipelines expose build status via:

```
GET /2.0/repositories/{workspace}/{slug}/commit/{commit}/statuses
```

The response shape is different from GitHub's check-runs and GitLab's pipeline jobs:

```json
{
  "values": [
    {
      "state": "SUCCESSFUL",
      "name": "Build and test",
      "url": { "href": "https://bitbucket.org/..." },
      "key": "bitbucket-pipes-build",
      "created_on": "..."
    }
  ]
}
```

`state` is one of `SUCCESSFUL`, `FAILED`, `INPROGRESS`, `STOPPED`. The mapping to `CICheck`:

```rust
let conclusion = match bb_state.as_str() {
    "SUCCESSFUL" => "success",
    "FAILED"     => "failure",
    "STOPPED"    => "cancelled",
    _            => "pending",
}.to_string();

let state = if bb_state == "INPROGRESS" {
    "in_progress"
} else {
    "completed"
}.to_string();
```

The `details_url` comes from `url.href` in the nested object (Bitbucket wraps URLs in a `{ href }` struct throughout their API). A fallback reads the top-level `url` string field for older pipeline formats.

### Draft conversion

Bitbucket has no `isDraft` concept in its REST API. The de-facto convention is a `"Draft: "` title prefix — widely used by teams, and recognized by some third-party tools. `convertDraftToReady` strips the prefix and PATCHes the PR title:

```rust
let title = pr_title.strip_prefix("Draft: ").unwrap_or(&pr_title).to_string();
// PATCH /2.0/repositories/{workspace}/{slug}/pullrequests/{id}
// { "title": title }
```

It's a workaround, but it's the workaround Bitbucket users already use. The button in `PrDetailView.vue` only renders when the PR title starts with `"Draft: "`, so no false positives.

### Comment CRUD

Bitbucket's comment update and delete endpoints:

```
PUT    /2.0/repositories/{workspace}/{slug}/pullrequests/{id}/comments/{comment_id}
DELETE /2.0/repositories/{workspace}/{slug}/pullrequests/{id}/comments/{comment_id}
```

Both require the PR ID. Same solution as GitLab: the optional `prNumber` in the interface, passed through from `PrDetailView`. Inline anchoring on Bitbucket uses `{ "inline": { "path": "...", "to": 42 } }` in the comment body, which the `createComment` implementation already handled in v2.10.

---

## Intelligence panel: removing the forge guard

The conflict preview and hotspot analysis were behind an explicit guard:

```ts
// PrDetailView.vue — v2.10
if (forge.value?.name !== "github") return;
```

Both features run on local git data:

- **Conflict preview** (`getConflictPreview`) runs `git merge-tree MERGE_BASE HEAD PR_HEAD` and parses the output for conflict markers. The PR head SHA is fetched from the forge, but the actual analysis is a local git command — it works identically regardless of which forge hosts the repository.
- **Hotspot analysis** (`getHotspots`) walks the commit graph for the files in the PR diff and counts how many recent commits touched them. Again, entirely local: `git log --follow --format="%H" -- <path>` repeated per file. The forge is not consulted.

The audit confirmed both produce identical, useful output on GitLab MRs and Bitbucket PRs. The guard is removed. GitLab and Bitbucket users now see the conflict preview widget and hotspot analysis in `PrIntelligencePanel` for any PR where the local git history is available (i.e., the repo has been cloned, which it has to be for GitWand to function at all).

`getFileHistory` — the "this file was reviewed N times recently" chips — still requires a forge API call and remains GitHub-only. GitLab's equivalent (MR note filtering by path) and Bitbucket's (comment search) are deferred to a future release.

---

## Multi-account context in providers

v2.10 introduced `useAccounts` and the `Account` interface but left a note: "per-account provider instantiation is deferred to v2.14." That's now done.

Each `ForgeProvider` method that makes an API call accepts an optional `account?: Account` parameter. The provider resolves credentials by calling `useCredentials(account?.tokenKey ?? defaultTokenKey)`. For GitHub and GitLab, the token key points to the `gh`/`glab` auth store; switching accounts means switching which `gh auth switch` or `glab auth login` session is used. For Bitbucket, it points to the keychain entry for the App Password.

The `PrDetailView.vue` passes `activeAccount(forge.value.name)` as the account context on every method call. Switching the active account in **Settings → Accounts** and refreshing the PR panel now uses the newly selected account's credentials without closing or re-opening the repo tab.

---

## The Linear Diffs comparison

Linear launched [Diffs](https://linear.app/docs/diffs) the same week — review PRs inline in your issue tracker. It's a well-executed feature for what it is. The comparison is worth stating plainly.

**What Linear Diffs does:** unified and split diff views (⌘B to toggle), inline comments bidirectional with GitHub, CI check status, merge from the PR view, a "For me / Created" tab structure, granular PR activity notifications.

**What it doesn't do:** anything except GitHub. Setup requires a GitHub organization admin to re-authorize the Linear installation with code access. No staging, no rebase, no conflict resolution — it's a diff viewer embedded in a project management tool, not a Git client.

**Where GitWand is ahead as of v2.14:**

| Capability | GitWand v2.14 | Linear Diffs |
|---|---|---|
| Forges | GitHub + GitLab + Bitbucket | GitHub only |
| Inline diff comments | ✓ all three forges | ✓ GitHub only |
| CI checks | ✓ all three forges | ✓ GitHub only |
| Draft → ready | ✓ GitHub, GitLab, Bitbucket (title prefix) | ✓ GitHub only |
| Conflict preview | ✓ all three forges (local git) | ✗ |
| Auto-resolve conflicts | ✓ (core engine, v1.0–v2.6) | ✗ |
| Staging / commit / push | ✓ | ✗ |
| Setup | `gh`/`glab` CLI + App Password | Org admin re-authorization |
| Local-first | ✓ no cloud required | ✗ requires Linear cloud |

**Where Linear is ahead:** PR activity notifications (OS-level push for review requests, CI flips, mentions). GitWand has the Launchpad polling but no push notifications yet. That's [v2.15 on the roadmap](/changelog).

The framing that matters: Linear Diffs is an issue tracker growing toward a Git client. GitWand is a Git client that already covers the review workflow across three forges. They solve adjacent problems, but only one of them can replace your terminal.

---

## What's next

**v2.15 — PR activity notifications:** OS-native notifications (macOS Notification Center, Linux libnotify, Windows toast) built on the existing Launchpad poller. No extra network calls — a diff-snapshot of the Launchpad state between ticks detects new comments, review requests, and CI flips. Granular filter: all activity · reviews & comments · CI failures only · none.

**v2.16 — CI check annotations inline:** The line that made your linter or typecheck fail, overlaid directly in the diff gutter. GitHub check-run annotations (`GET /check-runs/{id}/annotations`), GitLab pipeline artifacts, Bitbucket Pipelines — all three, same `CIAnnotation` type, same gutter icon layer in `DiffViewer`.

---

## Try it

Update to v2.14 from the [releases page](https://gitwand.app) or via the in-app update check (**Help → Check for Updates**). Open any GitLab or Bitbucket repo — the inline comment anchoring, CI checks, and conflict preview are automatic. If you have multi-account set up in **Settings → Accounts**, switching the active account now takes effect immediately on the next API call.

Source on [GitHub](https://github.com/devlint/GitWand). Full v2.14.0 entry in the [changelog](/changelog#v2-14-0-may-2026).

---

*Related: [v2.10 — the ForgeProvider architecture](/blog/v2-10-forge-integrations) that this release completes, and the [changelog](/changelog) for every commit.*

*Curious about GitWand? [Download it here](https://gitwand.app/) — free, open-source, native, no Electron.*
