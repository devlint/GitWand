---
title: "GitWand now works with GitHub, GitLab & Bitbucket: the v2.10 forge architecture"
description: "GitWand v2.10 breaks out of the GitHub silo. Native GitLab Merge Request support via the glab CLI, Bitbucket Cloud PR support via REST v2 + OS keychain credentials, a multi-account registry, and a ForgeProvider abstraction that routes every PR operation to the right backend without touching usePrPanel. Here's how it works."
date: 2026-05-14
head:
  - - meta
    - property: og:title
      content: "GitWand now works with GitHub, GitLab & Bitbucket: the v2.10 forge architecture"
  - - meta
    - property: og:description
      content: "ForgeProvider abstraction, auto-detection from the remote URL, GitLab via glab CLI, Bitbucket via REST v2 + OS keychain, multi-account registry, lazy-loaded provider chunks. The v2.10 architecture and what's still GitHub-only."
  - - meta
    - name: twitter:title
      content: "GitWand now works with GitHub, GitLab & Bitbucket: the v2.10 forge architecture"
---

# GitWand now works with GitHub, GitLab & Bitbucket

`@gitwand/desktop@2.10.0` removes the assumption that your forge is GitHub.

GitWand has always been git-agnostic at the engine level — the conflict resolution, staging, commit, push, rebase, and worktree flows all go through `libgit2` and never talk to any forge directly. But the PR panel, the Launchpad's PR and Issues tabs, and every `gh *` command in the codebase were GitHub-only. Opening a repo whose remote is `gitlab.com` or `bitbucket.org` would silently fail the forge detection and leave the PR panel empty.

v2.10 fixes that. The full PR panel experience — diff view, CI status, inline comments, review submission, draft-to-ready conversion — now works across all three. Here's what changed and why.

---

## The abstraction: `ForgeProvider`

The first design decision was whether to branch existing code or introduce an abstraction. The existing PR code was a flat pile of `gh *` wrapper calls inside `usePrPanel.ts` — no intermediate layer. Branching it would have meant copying the entire panel three times and keeping three divergent versions in sync forever.

The abstraction won. `forge/types.ts` defines a `ForgeProvider` interface:

```ts
export interface ForgeProvider {
  readonly name: ForgeName; // "github" | "gitlab" | "bitbucket" | "unknown"

  detectFromRemote(remoteUrl: string): boolean;

  // Discovery
  getCurrentUser(cwd: string): Promise<string>;
  listReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]>;

  // PR listing
  listPRs(cwd: string, opts?: ListPRsOptions): Promise<PullRequest[]>;
  getPRCount(cwd: string, state?: string): Promise<number>;
  getPRFiles(cwd: string, prNumber: number): Promise<string[]>;

  // PR detail
  getPR(cwd: string, number: number): Promise<PullRequestDetail>;
  getPRDiff(cwd: string, number: number): Promise<string>;
  getCIChecks(cwd: string, number: number): Promise<CICheck[]>;

  // PR actions
  createPR(cwd: string, input: CreatePRInput): Promise<PullRequest>;
  mergePR(cwd: string, number: number, method?: "merge" | "squash" | "rebase"): Promise<void>;
  checkoutPR(cwd: string, number: number): Promise<void>;
  convertDraftToReady(cwd: string, number: number): Promise<void>;

  // Comments
  listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]>;
  createComment(cwd: string, prNumber: number, params: CreatePrCommentParams): Promise<PrReviewComment>;
  updateComment(cwd: string, commentId: number, body: string): Promise<void>;
  deleteComment(cwd: string, commentId: number): Promise<void>;

  // Reviews
  listReviews(cwd: string, prNumber: number): Promise<PrReview[]>;
  submitReview(cwd: string, prNumber: number, opts: SubmitReviewOptions): Promise<PrReview>;

  // GitHub-specific intelligence (stubs on other forges)
  getConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview>;
  getHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]>;
  getFileHistory(cwd: string, paths: string[]): Promise<Record<string, PrFileHistory>>;
}
```

The data types — `PullRequest`, `PullRequestDetail`, `CICheck`, `PrReviewComment`, `PrReview` — are reused from `utils/backend.ts` unchanged. They were already forge-agnostic by accident: they described what the GitHub API returned, and GitHub's field names are close enough to GitLab's and Bitbucket's that mapping at the provider boundary is all that's needed.

`usePrPanel.ts` was updated in a single pass: every `gh *` call replaced with `forge.<method>()`, where `forge` is a `ForgeProvider` resolved once at mount and stored in a `ref`. The panel itself became blind to which forge it's talking to — it just calls the interface.

### `ForgeNotImplementedError`

Not every method is implemented on every forge in v2.10. The three methods at the bottom of the interface — `getConflictPreview`, `getHotspots`, `getFileHistory` — are GitHub-specific analyses that don't have meaningful equivalents on GitLab or Bitbucket yet. Rather than silently returning empty data and making the UI look broken, unimplemented methods throw:

```ts
export class ForgeNotImplementedError extends Error {
  constructor(provider: ForgeName, method: string) {
    super(`[ForgeProvider:${provider}] ${method}() not yet implemented`);
    this.name = "ForgeNotImplementedError";
  }
}
```

Components catch `ForgeNotImplementedError` and hide the corresponding UI section. The conflict preview widget in `PrDetailView.vue` doesn't render on GitLab or Bitbucket repos — it checks `forge.name` and suppresses itself, the same way the Launchpad's Team tab suppresses itself when disabled.

---

## Auto-detection: `useForge.ts`

No configuration is required. GitWand detects the forge from the remote URL automatically.

```ts
export async function useForge(cwd: string): Promise<ForgeProvider> {
  try {
    const info = await gitRemoteInfo(cwd);
    return getProviderByName(info.provider as ForgeName);
  } catch {
    return githubProvider; // fallback
  }
}
```

`gitRemoteInfo()` is a Rust command that reads the repo's `origin` remote URL and returns a `RemoteInfo` struct including a `provider` field — `"github"` / `"gitlab"` / `"bitbucket"` / `"unknown"` — derived from the URL hostname. This Rust-side detection is reliable (it handles SSH URLs, HTTPS URLs, custom subdomains, and self-hosted instances that include `gitlab.` anywhere in the hostname) and costs no network call — it just reads `.git/config`.

When `RemoteInfo` is already loaded in the calling component (which is the case for `usePrPanel.ts` — it loads `gitRemoteInfo` on mount anyway), `forgeFromRemoteInfo()` skips the redundant call:

```ts
export function forgeFromRemoteInfo(info: { provider: string; url: string }): ForgeProvider {
  const byName = _cache.get(info.provider as ForgeName);
  if (byName) return byName;
  return getProviderByUrl(info.url); // URL-match fallback
}
```

### Lazy-loaded Vite chunks

The three provider files are separate Vite chunks. `githubProvider` stays in the main bundle — it's the common case, and adding a dynamic import for the most-used path just adds latency. `GitLabProvider` and `BitbucketProvider` are pre-warmed at module init as non-blocking dynamic imports:

```ts
const _cache = new Map<ForgeName, ForgeProvider>();
_cache.set("github", githubProvider);

// Pre-warm at module init — non-blocking
import("./GitLabProvider").then((m) => _cache.set("gitlab", m.gitlabProvider));
import("./BitbucketProvider").then((m) => _cache.set("bitbucket", m.bitbucketProvider));
```

Pre-warming means the chunks are fetched and parsed immediately when `useForge.ts` is first imported — well before the user opens the PR panel for a non-GitHub repo. By the time `getProviderByName("gitlab")` is called for the first time, the module is already in the cache. The only user-visible cost is the initial chunk download, amortised to zero in practice because the pre-warm fires during app startup idle time.

Chunk savings: `GitLabProvider.ts` and `BitbucketProvider.ts` together add about 450 KB before minification; keeping them out of the main bundle means the main chunk size stays unchanged.

---

## GitLab: via `glab`

The `GitLabProvider` is backed by the `glab` CLI — the official GitLab CLI, distributed as a standalone binary and available via Homebrew, apt, and winget. GitWand detects `glab` the same way it detects `gh`: by looking for the binary in the PATH enriched by the login-shell preload. If `glab` isn't installed, the PR panel shows a "Install glab" prompt with a one-click setup path via Homebrew or the system package manager.

Auth is handled entirely by `glab auth login` — the token lives in the `glab` credential store, never in GitWand's settings or the app's `localStorage`. GitWand never reads or holds the token. When a `glab` command fails with an auth error, the provider surfaces the raw `glab` error message and prompts re-authentication.

The state terminology is the one interesting adaptation. GitLab uses `"opened"` where GitHub uses `"open"`, and calls PRs "Merge Requests" throughout its API. The `ForgeProvider` interface uses GitHub terminology uniformly (`listPRs`, `getPR`, `createPR`), so the `GitLabProvider` translates at its boundary:

```ts
listPRs(cwd: string, opts: ListPRsOptions = {}): Promise<PullRequest[]> {
  const state = opts.state === "open" ? "opened" : (opts.state ?? "opened");
  return glListMrs(cwd, state, opts.limit ?? 10, opts.offset ?? 0);
}
```

The UI renders "Merge Request" instead of "Pull Request" when `forge.name === "gitlab"`. This is handled in `PrDetailView.vue` with a computed `prLabel`:

```ts
const prLabel = computed(() =>
  forge.value?.name === "gitlab" ? t("forge.mergeRequest") : t("forge.pullRequest")
);
```

Every string in the PR panel that names the PR concept uses `prLabel` — no hardcoded "Pull Request" anywhere that a GitLab user would see.

**What works on GitLab in v2.10:** MR list, MR detail, diff, pipeline status (CI), create MR, merge MR, checkout MR, draft→ready conversion, MR notes (general comments), approvals, reviewer candidates.

**Stubs deferred to v2.14:** `updateComment` and `deleteComment` — both require the MR IID alongside the note ID, and the `ForgeProvider` interface's comment methods only take a `commentId`. The interface will gain an optional `prNumber` parameter in v2.14. Diff-line anchoring via GitLab's Discussions API (as opposed to general notes) is also v2.14.

---

## Bitbucket: via REST v2 + OS keychain

Bitbucket Cloud has no official CLI comparable to `gh` or `glab`. The `BitbucketProvider` talks to the Bitbucket REST API v2 directly, using `curl` via Rust Tauri commands in `bitbucket.rs`. This was a deliberate choice over writing a Node.js HTTP client — `curl` is universally available, handles TLS, follows redirects, and produces predictable JSON output that can be piped through `jq`.

The credential model is different from GitHub and GitLab. Bitbucket uses **App Passwords** — user-generated tokens with fine-grained scopes — rather than OAuth tokens. App Passwords are stored in the OS keychain (macOS Keychain, libsecret on Linux, Windows Credential Manager) via `credentials.rs`, which wraps the Tauri keyring plugin. GitWand never writes the App Password to disk, never logs it, and never holds it in process memory longer than the time it takes to pass it to `curl` as a `--user` argument. The keychain lookup happens on every API call.

Setting up Bitbucket requires one step in **Settings → Accounts**: paste your workspace slug and App Password. GitWand validates them immediately by calling `GET /2.0/user` and shows the authenticated username. Once verified, all Bitbucket operations work without further configuration.

Bitbucket's API quirks that required adaptation:

- **PR state casing.** Bitbucket uses `"OPEN"`, `"MERGED"`, `"DECLINED"` (uppercase). The provider upcases the `state` argument at its boundary.
- **No native draft.** Bitbucket has no `isDraft` concept. The `convertDraftToReady` method in `BitbucketProvider` is a stub in v2.10 — Bitbucket workarounds (title prefix `"Draft:"`) are not yet implemented.
- **CI Checks.** Bitbucket Pipelines are accessible via a separate REST endpoint (`/2.0/repositories/{workspace}/{repo_slug}/commit/{commit}/statuses`). That endpoint is wired in v2.14; `getCIChecks` throws `ForgeNotImplementedError` in v2.10.
- **Approvals only, no "request changes".** Bitbucket's review model has approve / unapprove, but no "request changes" equivalent. `submitReview` with `event: "REQUEST_CHANGES"` silently downgrades to `event: "COMMENT"` on Bitbucket — the review is posted but no blocking flag is set on the PR.

**What works on Bitbucket in v2.10:** PR list, PR detail, diff, create PR, merge PR, checkout PR, PR comments (general + inline via Bitbucket inline anchors), approvals, reviewer candidates (repo members with write access).

---

## Multi-account registry: `useAccounts`

Large teams often have multiple accounts on the same forge — a personal account and a work account on GitHub, or two different Bitbucket workspaces. The `useAccounts` composable manages these as a flat list of `Account` objects, each identified by a `tokenKey` pointer into the OS keychain:

```ts
export interface Account {
  id: string;
  forge: ForgeName;
  label: string;     // "perso", "work", "client-X"
  username: string;  // displayed in UI
  tokenKey: string;  // "gitwand:bitbucket/my-workspace" — keychain pointer
}
```

The `tokenKey` is a `"service/account"` string that identifies the keychain entry without holding the secret itself. `useCredentials.ts` translates it to a `(service, account)` pair for the OS keychain lookup. Storing only the key instead of the credential means rotating an App Password — common in enterprise security policies — requires only one step: update the keychain entry. GitWand's stored data doesn't change.

Each forge has one **active account** at a time. The active account is stored in a separate `localStorage` key (`"gitwand-active-accounts"`), a `Record<ForgeName, accountId>`. `activeAccount(forge)` returns the explicitly-set active account, or the first account for that forge if none has been explicitly set. This fallback makes the first account "automatic" without requiring users to click "Set as active" after adding their first account.

```ts
function activeAccount(forge: ForgeName): Account | null {
  const forgeAccounts = _accounts.value.filter((a) => a.forge === forge);
  if (forgeAccounts.length === 0) return null;
  const activeId = _activeMap.value[forge];
  return forgeAccounts.find((a) => a.id === activeId) ?? forgeAccounts[0];
}
```

In v2.10, multi-account awareness is informational: the active account badge shows "Connected as alice" in the PR panel header, but all API calls still go through a single per-forge provider instance. Per-account provider instantiation — so you can switch between `alice` and `bob@corp.com` on GitHub without leaving the app — is deferred to v2.14, where the `ForgeProvider` methods will receive an optional `Account` context.

The **Settings → Accounts** tab renders each forge section with its list of accounts, an "Add account" form, and an active-account radio selector. GitHub accounts are displayed with a note that auth is managed by `gh auth login` (GitWand reads the active `gh` account but doesn't store a token); GitLab accounts similarly defer to `glab auth login`; Bitbucket accounts go through the App Password form.

---

## What stays GitHub-only

Three methods on the `ForgeProvider` interface throw `ForgeNotImplementedError` on GitLab and Bitbucket:

**`getConflictPreview`** uses `git merge-tree` to simulate a merge and return which files conflict and which hunks can be auto-resolved before the merge is executed. This requires local git analysis, not a forge API call — it works by running `git merge-tree MERGE_BASE HEAD PR_HEAD` and parsing the output. There's no reason it can't work on GitLab or Bitbucket (the local git history is available regardless of the forge). It's listed as a stub because the `PrConflictPreview` data structure was designed around the GitHub PR model, and the implementation that feeds it needs review before being declared forge-agnostic. v2.14.

**`getHotspots`** identifies files in a PR that have been frequently modified together in recent commit history — a heuristic for "this change might require looking at file B if you're editing file A". It's implemented via a commit graph walk in Rust, not a forge API call. Same situation as conflict preview: forge-agnostic in principle, blocked by implementation review. v2.14.

**`getFileHistory`** fetches recent review comments for a set of file paths across the PR's history — used to show "this file has been reviewed three times in the last two weeks" context chips in the diff view. This one does require a forge API call (GitHub's GraphQL `pullRequest { reviews { files } }` query), and the equivalent query path for GitLab and Bitbucket needs separate work. v2.14 for GitLab; v2.14 for Bitbucket.

The `PrDetailView.vue` component gates all three widgets behind `forge.name === "github"` checks, so GitLab and Bitbucket users see the diff, comments, and CI status without the intelligence features — a clean partial experience rather than a broken full one.

---

## Detection reliability: SSH, HTTPS, self-hosted

One concern with URL-based detection is self-hosted instances. `gitlab.com` is the easy case; `code.corp.com` is not. The `detectFromRemote` implementations use `includes("gitlab.")` rather than `=== "gitlab.com"` — this catches `gitlab.mycorp.com`, `gitlab.internal`, `code.gitlab.io`, and any hostname that contains `gitlab.` as a substring. The same logic in `gitRemoteInfo`'s Rust implementation:

```rust
pub fn detect_provider(remote_url: &str) -> &'static str {
    if remote_url.contains("github.com")   { return "github";    }
    if remote_url.contains("gitlab.")       { return "gitlab";    }
    if remote_url.contains("bitbucket.org") { return "bitbucket"; }
    "unknown"
}
```

SSH URLs (`git@gitlab.com:user/repo.git`) and HTTPS URLs (`https://gitlab.com/user/repo.git`) both contain the hostname, so the substring match works for both. Custom SSH ports (`git@gitlab.example.com:2222/repo.git`) work too because the hostname precedes the port. The one gap is a self-hosted Bitbucket instance — `bitbucket.mycorp.com` — because Bitbucket Data Center uses a completely different REST API from Bitbucket Cloud. That's a known non-goal for v2.10; only Bitbucket Cloud is supported, and detection is deliberately restricted to `bitbucket.org` to avoid misleading users with a Data Center instance into connecting their App Password to the wrong API endpoint.

---

## What's next

The v2.14 scope is:

**GitLab stubs:** `updateComment` / `deleteComment` (need the `prNumber` in the interface), diff-line comment anchoring via Discussions API, CI Checks (`gl pipeline list`).

**Bitbucket stubs:** `getCIChecks` (Bitbucket Pipelines REST endpoint), `convertDraftToReady` (via title prefix), `updateComment` / `deleteComment` (same interface gap as GitLab).

**Multi-account provider instantiation:** Pass the active `Account` context into `ForgeProvider` methods so a user with two GitHub accounts can toggle which one is used for API calls without leaving the app. The `useAccounts` composable and `Account` interface are already in place; v2.14 connects the account to the provider's credential resolution.

**`getConflictPreview` + `getHotspots` forge-agnostic audit:** Both are implemented on local git data; the audit is about whether the `PrConflictPreview` and `PrHotspot` types need a GitLab/Bitbucket variant or can be populated identically.

---

## Try it

Update to v2.10 from the [releases page](https://gitwand.app) or via the in-app update check. Open any repo with a GitLab or Bitbucket remote — GitWand detects the forge from the remote URL and routes the PR panel automatically. If `glab` isn't installed for GitLab, the panel prompts you; for Bitbucket, the **Settings → Accounts** tab has the App Password form.

Source on [GitHub](https://github.com/devlint/GitWand). Full v2.10.0 entry in the [changelog](/changelog#v2-10-0-may-2026).

---

*Related reading: [Launchpad — GitWand's cross-repo dashboard](/blog/v2-9-launchpad) (the v2.9 release that built the multi-repo PR aggregation the forge abstraction now feeds) and the [changelog](/changelog) for everything else.*

*Curious about GitWand? [Download it here](https://gitwand.app/) — free, open-source, shipping monthly.*
