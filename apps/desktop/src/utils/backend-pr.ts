// backend-pr.ts — GitHub PR functions, shared forge types, and OS keychain credentials.
// Extracted from backend.ts as part of the v2.11 backend split to keep module size manageable.
// Consumers should import directly from this file instead of backend.ts for these symbols.

import { isTauri, tauriInvoke, devFetch, DEV_SERVER } from "./backend-core";

// Module-level identity cache — one `gh api user` call per app session.
// Store the Promise so concurrent callers reuse the same in-flight request.
let _currentUserPromise: Promise<string> | null = null;

/**
 * Returns the GitHub login of the currently authenticated user (via `gh` CLI or token).
 * Result is cached for the lifetime of the app session.
 */
export function ghCurrentUser(): Promise<string> {
  if (_currentUserPromise) return _currentUserPromise;
  if (isTauri()) {
    _currentUserPromise = tauriInvoke<string>("gh_current_user");
  } else {
    _currentUserPromise = devFetch(`${DEV_SERVER}/api/gh-current-user`).then(
      async (res) => {
        if (!res.ok) throw new Error(`Failed to get current user: ${res.status}`);
        return res.json() as Promise<string>;
      }
    );
  }
  return _currentUserPromise;
}

/** GitHub fork relationship for the repo at `cwd`. */
export interface ForkInfo {
  /** True when origin is a fork of another GitHub repo. */
  isFork: boolean;
  /** Origin as "owner/repo" (head side of a cross-fork PR). */
  origin: string;
  /** Parent/upstream as "owner/repo", or "" when not a fork. */
  parent: string;
}

/**
 * Resolve the current repo's fork relationship so the PR create view can offer
 * "open against upstream". Falls back to a non-fork result in dev:web.
 */
export async function ghForkInfo(cwd: string): Promise<ForkInfo> {
  if (isTauri()) return tauriInvoke<ForkInfo>("gh_fork_info", { cwd });
  return { isFork: false, origin: "", parent: "" };
}

/** Returns the list of file paths changed by a PR (lazy — call only when needed). */
export async function ghPrFiles(repoPath: string, prNumber: number): Promise<string[]> {
  if (isTauri()) {
    return tauriInvoke<string[]>("pr_files", { cwd: repoPath, number: prNumber });
  }
  const res = await devFetch(
    `${DEV_SERVER}/api/pr-files?repo=${encodeURIComponent(repoPath)}&pr=${prNumber}`
  );
  if (!res.ok) throw new Error(`Failed to get PR files: ${res.status}`);
  return res.json() as Promise<string[]>;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  labels: string[];
  /** Logins of users assigned to this PR. */
  assignees: string[];
  /** Logins of users requested as reviewers (pending review). */
  reviewRequested: string[];
  /** "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" */
  reviewDecision: string;
  /** "CLEAN" | "BLOCKED" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "" */
  mergeStateStatus: string;
  /** Overall CI rollup: "SUCCESS" | "FAILURE" | "PENDING" | "" */
  checksRollup: string;
  /**
   * Number of issue-comments. Populated by the enriched workspace_prs_all
   * path (v2.16, Launchpad notification diff); 0 on the light sidebar list.
   */
  commentCount: number;
}

/**
 * List pull requests (requires `gh` CLI).
 *
 * `limit` and `offset` drive the boot-perf lazy-pagination introduced in
 * v2.8.5: the sidebar requests the first page of 10 PRs, then asks for
 * `offset += 10` chunks as the user scrolls. The Rust side fetches
 * `offset + limit` rows from `gh pr list` and slices — naïve but adequate
 * for the typical 10/20/30 windows the UI uses. TODO Phase 2: cursor-based
 * GraphQL pagination so already-loaded pages are not re-fetched.
 *
 * The heavy fields (`reviewDecision`, `additions`, `deletions`,
 * `reviewRequested`) are NOT populated by this call (gh CLI path) — empty
 * strings / zeros. `mergeStateStatus` and `checksRollup` ARE populated so
 * the sidebar dot turns red on conflicts and CI failures. Callers that need
 * the other fields must fetch the PR detail lazily (per-PR enrichment on
 * hover or select).
 */
export async function ghListPrs(
  cwd: string,
  state: string = "open",
  limit: number = 10,
  offset: number = 0,
): Promise<PullRequest[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<
      Array<{
        number: number;
        title: string;
        state: string;
        author: string;
        branch: string;
        base: string;
        draft: boolean;
        created_at: string;
        updated_at: string;
        url: string;
        additions: number;
        deletions: number;
        labels: string[];
        assignees: string[];
        review_requested: string[];
        review_decision: string;
        merge_state_status: string;
        checks_rollup: string;
        comment_count: number;
      }>
    >("gh_list_prs", { cwd, state, limit, offset });
    return raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.author,
      branch: pr.branch,
      base: pr.base,
      draft: pr.draft,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      url: pr.url,
      additions: pr.additions,
      deletions: pr.deletions,
      labels: pr.labels,
      assignees: pr.assignees ?? [],
      reviewRequested: pr.review_requested ?? [],
      reviewDecision: pr.review_decision ?? "",
      mergeStateStatus: pr.merge_state_status ?? "",
      checksRollup: pr.checks_rollup ?? "",
      commentCount: pr.comment_count ?? 0,
    }));
  }
  // Browser dev mode — call dev server. The dev-server endpoint doesn't
  // accept limit/offset yet; we slice client-side from the (already
  // capped) REST response. The Tauri path is what most users hit.
  const res = await devFetch(`${DEV_SERVER}/api/gh-list-prs?cwd=${encodeURIComponent(cwd)}&state=${state}`);
  if (!res.ok) throw new Error(`gh pr list failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  const sliced = (raw as any[]).slice(offset, offset + limit);
  return sliced.map((pr: any) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    author: pr.author,
    branch: pr.branch,
    base: pr.base,
    draft: pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    url: pr.url,
    additions: pr.additions,
    deletions: pr.deletions,
    labels: pr.labels,
    assignees: pr.assignees ?? [],
    reviewRequested: pr.review_requested ?? [],
    reviewDecision: pr.review_decision ?? "",
    mergeStateStatus: pr.merge_state_status ?? "",
    checksRollup: pr.checks_rollup ?? "",
    commentCount: pr.comment_count ?? 0,
  }));
}

/**
 * Lightweight count of pull requests — used at boot (DashboardView) and
 * for the sidebar badge.
 *
 * Avoids the multi-roundtrip cost of `gh_list_prs` (which expands
 * `statusCheckRollup` and `mergeStateStatus` per PR) by hitting a single
 * GraphQL `totalCount` edge instead.
 *
 * Offline-safe: short-circuits to 0 when the connectivity guard reports
 * the app is offline so the dashboard doesn't hang on a network call
 * during a no-internet boot. The Logs tab still records the skip.
 *
 * `state` accepts "open" (default), "closed", "merged" or "all".
 */
export async function ghPrCount(cwd: string, state: string = "open"): Promise<number> {
  // Local require to avoid a circular import at module init time
  // (networkGuard → useLogs → … → could touch backend in the future).
  const { requireOnline } = await import("./networkGuard");
  if (!(await requireOnline("gh pr count"))) return 0;
  try {
    if (isTauri()) {
      return await tauriInvoke<number>("gh_pr_count", { cwd, state });
    }
    const res = await devFetch(
      `${DEV_SERVER}/api/gh-pr-count?cwd=${encodeURIComponent(cwd)}&state=${encodeURIComponent(state)}`,
    );
    if (!res.ok) return 0;
    const data = await res.json();
    if (typeof data === "number") return data;
    if (data && typeof data.error === "string") return 0;
    return 0;
  } catch {
    // Boot-time dashboard call — never throw, the dashboard renders 0.
    return 0;
  }
}

/**
 * Create a pull request (requires `gh` CLI).
 */
export async function ghCreatePr(
  cwd: string,
  title: string,
  body: string,
  base: string = "",
  draft: boolean = false,
  reviewers: string[] = [],
  /** Cross-fork target as "owner/repo". Empty → open against the origin repo. */
  baseRepo: string = "",
): Promise<PullRequest> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      number: number;
      title: string;
      state: string;
      author: string;
      branch: string;
      base: string;
      draft: boolean;
      created_at: string;
      updated_at: string;
      url: string;
      additions: number;
      deletions: number;
      labels: string[];
      review_decision: string;
      merge_state_status: string;
      checks_rollup: string;
    }>("gh_create_pr", { cwd, title, body, base, baseRepo: baseRepo || null, draft, reviewers });
    return {
      number: raw.number,
      title: raw.title,
      state: raw.state,
      author: raw.author,
      branch: raw.branch,
      base: raw.base,
      draft: raw.draft,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      url: raw.url,
      additions: raw.additions,
      deletions: raw.deletions,
      labels: raw.labels,
      assignees: [],
      reviewRequested: [],
      reviewDecision: raw.review_decision ?? "",
      mergeStateStatus: raw.merge_state_status ?? "",
      checksRollup: raw.checks_rollup ?? "",
      commentCount: 0,
    };
  }
  // Browser dev mode — call dev server (uses GitHub REST API directly)
  const res = await devFetch(`${DEV_SERVER}/api/gh-create-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, title, body, base, baseRepo, draft, reviewers }),
  });
  const raw = await res.json();
  if (!res.ok || raw.error) {
    throw new Error(raw.error || `gh create pr failed: ${res.status}`);
  }
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: raw.author,
    branch: raw.branch,
    base: raw.base,
    draft: raw.draft,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.url,
    additions: raw.additions,
    deletions: raw.deletions,
    labels: raw.labels,
    assignees: [],
    reviewRequested: [],
    reviewDecision: raw.review_decision ?? "",
    mergeStateStatus: raw.merge_state_status ?? "",
    checksRollup: raw.checks_rollup ?? "",
    commentCount: raw.comment_count ?? 0,
  };
}

/**
 * Reviewer suggestion (assignee/collaborator candidate from the GitHub repo).
 */
export interface ReviewerCandidate {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

/**
 * List candidate reviewers for the current repo (requires `gh` CLI).
 * Returns assignees from `gh api /repos/:owner/:repo/assignees` — i.e. users with push access.
 */
export async function ghListReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<
      Array<{ login: string; name?: string | null; avatar_url?: string | null }>
    >("gh_list_reviewer_candidates", { cwd });
    return raw.map((u) => ({
      login: u.login,
      name: u.name ?? null,
      avatarUrl: u.avatar_url ?? null,
    }));
  }
  // Browser dev mode — call dev server (uses GitHub REST API directly)
  const res = await devFetch(`${DEV_SERVER}/api/gh-reviewer-candidates?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) return [];
  const raw = await res.json();
  if (!Array.isArray(raw)) return [];
  return raw.map((u: { login: string; name?: string | null; avatar_url?: string | null }) => ({
    login: u.login,
    name: u.name ?? null,
    avatarUrl: u.avatar_url ?? null,
  }));
}

/**
 * Checkout a PR branch locally (requires `gh` CLI).
 */
export async function ghCheckoutPr(cwd: string, number: number): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("gh_checkout_pr", { cwd, number });
    return;
  }
  throw new Error("PR checkout not available in dev mode");
}

/**
 * Merge a PR (requires `gh` CLI).
 * @param method - "merge", "squash", or "rebase"
 */
export async function ghMergePr(cwd: string, number: number, method: string = "merge"): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("gh_merge_pr", { cwd, number, method });
    return;
  }
  const resp = await devFetch(`${DEV_SERVER}/api/gh-merge-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number, method }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
}

/** Convert a draft PR to ready-for-review via `gh pr ready`. */
export async function ghPrReady(cwd: string, number: number): Promise<void> {
  if (!isTauri()) throw new Error("ghPrReady requires Tauri");
  return tauriInvoke<void>("gh_pr_ready", { cwd, number });
}

// ─── PR Detail, Diff & Checks (Phase 9.1) ──────────────────

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviewComments: number;
  labels: string[];
  reviewers: string[];
  mergeable: string;
  checksStatus: string;
  /**
   * Whether the current viewer can merge this PR. `null` when the forge does
   * not expose it (Azure, Bitbucket) — callers must treat null as "allowed"
   * and gate the merge button on errors only, never on an unknown permission.
   */
  canMerge: boolean | null;
}

export interface CICheck {
  name: string;
  state: string;
  conclusion: string;
  detailsUrl: string;
}

/**
 * A check-run / code-quality annotation anchored to a file line (v2.18).
 * Forge-agnostic: GitHub check-runs, GitLab codequality, Bitbucket reports.
 */
export interface CIAnnotation {
  /** Name of the check-run / job / report that produced the annotation. */
  checkName: string;
  path: string;
  startLine: number;
  endLine: number;
  level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

/** Raw snake_case CIAnnotation shape returned by the Rust/dev-server backends. */
export interface CIAnnotationRaw {
  check_name: string;
  path: string;
  start_line: number;
  end_line: number;
  level: string;
  title: string;
  message: string;
}

export function mapAnnotation(a: CIAnnotationRaw): CIAnnotation {
  return {
    checkName: a.check_name,
    path: a.path,
    startLine: a.start_line,
    endLine: a.end_line,
    level: a.level === "failure" || a.level === "warning" ? a.level : "notice",
    title: a.title,
    message: a.message,
  };
}

/**
 * Get check-run annotations for a PR (requires `gh` CLI).
 * Returns `[]` when the repo has no checks or annotations have expired.
 */
export async function ghCheckAnnotations(cwd: string, number: number): Promise<CIAnnotation[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<CIAnnotationRaw[]>("gh_check_annotations", { cwd, number });
    return raw.map(mapAnnotation);
  }
  const res = await devFetch(`${DEV_SERVER}/api/gh-check-annotations?cwd=${encodeURIComponent(cwd)}&number=${number}`);
  if (!res.ok) throw new Error(`gh check annotations failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return (raw as CIAnnotationRaw[]).map(mapAnnotation);
}

/**
 * Get detailed PR information (requires `gh` CLI).
 */
export async function ghPrDetail(cwd: string, number: number): Promise<PullRequestDetail> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      number: number;
      title: string;
      body: string;
      state: string;
      author: string;
      branch: string;
      base: string;
      draft: boolean;
      created_at: string;
      updated_at: string;
      merged_at: string;
      url: string;
      additions: number;
      deletions: number;
      changed_files: number;
      comments: number;
      review_comments: number;
      labels: string[];
      reviewers: string[];
      mergeable: string;
      checks_status: string;
      can_merge: boolean | null;
    }>("gh_pr_detail", { cwd, number });
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body,
      state: raw.state,
      author: raw.author,
      branch: raw.branch,
      base: raw.base,
      draft: raw.draft,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      mergedAt: raw.merged_at,
      url: raw.url,
      additions: raw.additions,
      deletions: raw.deletions,
      changedFiles: raw.changed_files,
      comments: raw.comments,
      reviewComments: raw.review_comments,
      labels: raw.labels,
      reviewers: raw.reviewers,
      mergeable: raw.mergeable,
      checksStatus: raw.checks_status,
      canMerge: raw.can_merge ?? null,
    };
  }
  // Browser dev mode
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-detail?cwd=${encodeURIComponent(cwd)}&number=${number}`);
  if (!res.ok) throw new Error(`gh pr detail failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return {
    number: raw.number, title: raw.title, body: raw.body, state: raw.state,
    author: raw.author, branch: raw.branch, base: raw.base, draft: raw.draft,
    createdAt: raw.created_at, updatedAt: raw.updated_at, mergedAt: raw.merged_at,
    url: raw.url, additions: raw.additions, deletions: raw.deletions,
    changedFiles: raw.changed_files, comments: raw.comments, reviewComments: raw.review_comments,
    labels: raw.labels, reviewers: raw.reviewers, mergeable: raw.mergeable, checksStatus: raw.checks_status,
    canMerge: raw.can_merge ?? null,
  };
}

/**
 * Get the diff of a PR (requires `gh` CLI).
 */
export async function ghPrDiff(cwd: string, number: number): Promise<string> {
  if (isTauri()) {
    return await tauriInvoke<string>("gh_pr_diff", { cwd, number });
  }
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-diff?cwd=${encodeURIComponent(cwd)}&number=${number}`);
  if (!res.ok) throw new Error(`gh pr diff failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.diff;
}

/**
 * Get CI checks for a PR (requires `gh` CLI).
 */
export async function ghPrChecks(cwd: string, number: number): Promise<CICheck[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<Array<{
      name: string;
      state: string;
      conclusion: string;
      details_url: string;
    }>>("gh_pr_checks", { cwd, number });
    return raw.map((c) => ({
      name: c.name,
      state: c.state,
      conclusion: c.conclusion,
      detailsUrl: c.details_url,
    }));
  }
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-checks?cwd=${encodeURIComponent(cwd)}&number=${number}`);
  if (!res.ok) throw new Error(`gh pr checks failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw.map((c: any) => ({
    name: c.name, state: c.state, conclusion: c.conclusion, detailsUrl: c.details_url,
  }));
}

// ─── PR Review Comments (Phase 9.2) ────────────────────────

/** A single review comment anchored to a diff line. */
export interface PrReviewComment {
  id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
  /** File path the comment is anchored to. */
  path: string;
  /** New-file line number (null for comments on deleted lines). */
  line: number | null;
  /** Line number in the original (old) file. */
  original_line: number | null;
  /** Which side of the diff: LEFT (old) or RIGHT (new). */
  side: "LEFT" | "RIGHT";
  /** First line of a multi-line comment range. */
  start_line: number | null;
  start_side: "LEFT" | "RIGHT" | null;
  /** ID of parent comment if this is a reply. */
  in_reply_to_id: number | null;
  /** Raw diff hunk context. */
  diff_hunk: string;
  url: string;
}

/** Params for creating a new review comment. */
export interface CreatePrCommentParams {
  /** Comment text (Markdown). */
  body: string;
  /** File path. Required for new comments (not replies). */
  path?: string;
  /** Last line number (new-file side). */
  line?: number;
  side?: "LEFT" | "RIGHT";
  /** Start of a multi-line comment. */
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  /** Reply to this comment ID instead of creating a new thread. */
  in_reply_to_id?: number;
}

/** Fetch all review comments for a PR. */
export async function ghPrComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
  if (isTauri()) return tauriInvoke<PrReviewComment[]>("gh_pr_comments", { cwd, number: prNumber });
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-comments?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`);
  if (!res.ok) throw new Error(`gh pr comments failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReviewComment[];
}

/**
 * Issue-level (conversation) comments on a PR — the ones not anchored to a
 * diff line. Returned in the same {@link PrReviewComment} shape with an empty
 * `path` so they can be merged with review comments for display.
 */
export async function ghPrIssueComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
  if (isTauri()) return tauriInvoke<PrReviewComment[]>("gh_pr_issue_comments", { cwd, number: prNumber });
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-issue-comments?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`);
  if (!res.ok) throw new Error(`gh pr issue comments failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReviewComment[];
}

// ─── Reactions ──────────────────────────────────────────────────────────────

export interface PrReaction {
  id: number;
  content: string;
  user: string;
}

/** List reactions on a PR or one of its comments.
 * `targetType`: `"pr"` | `"review_comment"` | `"issue_comment"`.
 * `targetId`: PR number for `"pr"`, comment id otherwise.
 */
export async function ghListReactions(
  cwd: string,
  prNumber: number,
  targetType: string,
  targetId: number,
): Promise<PrReaction[]> {
  if (isTauri()) {
    return tauriInvoke<PrReaction[]>("gh_list_reactions", { cwd, number: prNumber, targetType, targetId });
  }
  return [];
}

/** Add a reaction to a PR or comment. Returns the created reaction. */
export async function ghAddReaction(
  cwd: string,
  prNumber: number,
  targetType: string,
  targetId: number,
  content: string,
): Promise<PrReaction> {
  if (isTauri()) {
    return tauriInvoke<PrReaction>("gh_add_reaction", { cwd, number: prNumber, targetType, targetId, content });
  }
  throw new Error("Reactions not supported in dev mode");
}

/** Delete a reaction from a PR or comment. */
export async function ghDeleteReaction(
  cwd: string,
  prNumber: number,
  targetType: string,
  targetId: number,
  reactionId: number,
): Promise<void> {
  if (isTauri()) {
    return tauriInvoke<void>("gh_delete_reaction", { cwd, number: prNumber, targetType, targetId, reactionId });
  }
  throw new Error("Reactions not supported in dev mode");
}

/** Create a new review comment (or reply to an existing one). */
export async function ghPrCreateComment(
  cwd: string,
  prNumber: number,
  params: CreatePrCommentParams,
): Promise<PrReviewComment> {
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number: prNumber, ...params }),
  });
  if (!res.ok) throw new Error(`create comment failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReviewComment;
}

/** Edit the body of an existing review comment. */
export async function ghPrUpdateComment(
  cwd: string,
  commentId: number,
  body: string,
): Promise<void> {
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-comment?id=${commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, body }),
  });
  if (!res.ok) throw new Error(`update comment failed: ${res.status}`);
}

/** Delete a review comment. */
export async function ghPrDeleteComment(cwd: string, commentId: number): Promise<void> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-comment?cwd=${encodeURIComponent(cwd)}&id=${commentId}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`delete comment failed: ${res.status}`);
}

// ─── PR Reviews (Phase 9.3) ────────────────────────────────

/** A top-level pull-request review (Approve / Request Changes / Comment). */
export interface PrReview {
  id: number;
  /** "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" */
  state: string;
  body: string;
  user: { login: string; avatar_url: string };
  submitted_at: string;
  html_url: string;
}

/** A pending inline comment included when submitting a review. */
export interface PendingReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

/** Fetch all reviews for a PR. */
export async function ghPrListReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
  if (isTauri()) return tauriInvoke<PrReview[]>("gh_pr_reviews", { cwd, number: prNumber });
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-reviews?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`,
  );
  if (!res.ok) throw new Error(`gh pr reviews failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReview[];
}

/** Submit a review (Approve / Request Changes / Comment) with optional inline comments. */
export async function ghPrSubmitReview(
  cwd: string,
  prNumber: number,
  opts: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body?: string;
    comments?: PendingReviewComment[];
  },
): Promise<PrReview> {
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-submit-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number: prNumber, ...opts }),
  });
  // Prefer the server's JSON error body over a generic status message.
  const raw = await res.json().catch(() => null);
  if (!res.ok || (raw && raw.error)) {
    const msg = raw?.error || `gh pr submit review failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return raw as PrReview;
}

// ─── Phase 9.4 — Intelligence GitWand ──────────────────────

/** Result of a conflict simulation (merge-tree analysis). */
export interface PrConflictPreview {
  /** GitHub mergeable flag (true/false/null=unknown). */
  mergeable: boolean | null;
  mergeableState: string;
  /** Files very likely to conflict (appear on both sides since merge-base). */
  conflictingFiles: string[];
  /** Files changed only in the PR — no conflict risk. */
  cleanFiles: string[];
  /** Files that both sides changed (potential conflicts even if GH says clean). */
  overlappingFiles: string[];
  totalPrFiles: number;
  summary: string;
}

/** Hotspot score for a file — how often it has been involved in merge commits. */
export interface PrHotspot {
  path: string;
  /** Number of merge commits that touched this file. */
  mergeCount: number;
  /** Total commits touching this file. */
  totalCount: number;
  /** Percentage of commits that were merges (0–100). */
  score: number;
  lastChange: string;
}

/** Historical review activity on a specific file. */
export interface PrFileHistory {
  reviewCommentCount: number;
  reviewers: string[];
  lastComment: { author: string; body: string; pr_number: string } | null;
}

/** Fetch conflict prediction for a PR (git merge-tree analysis). */
export async function ghPrConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-conflict-preview?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`,
  );
  if (!res.ok) throw new Error(`conflict preview failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrConflictPreview;
}

/** Fetch hotspot scores for a list of file paths. */
export async function ghPrHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-hotspots?cwd=${encodeURIComponent(cwd)}&paths=${encodeURIComponent(paths.join(","))}`,
  );
  if (!res.ok) throw new Error(`hotspots failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrHotspot[];
}

/** Total number of tracked files in the repo (for scope %). */
export async function gitFileCount(cwd: string): Promise<number> {
  const res = await devFetch(`${DEV_SERVER}/api/git-file-count?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`file count failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw.count as number;
}

/** Fetch past review activity on a set of files (last 100 review comments from repo). */
export async function ghPrFileHistory(
  cwd: string,
  paths: string[],
): Promise<Record<string, PrFileHistory>> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-file-history?cwd=${encodeURIComponent(cwd)}&paths=${encodeURIComponent(paths.join(","))}`,
  );
  if (!res.ok) throw new Error(`file history failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as Record<string, PrFileHistory>;
}

// ─── OS Keychain credentials ────────────────────────────────────────────────
//
// Thin wrappers around the `credentials.rs` Tauri commands.
// Convention: service = "gitwand:<forge>", account = workspace identifier.

/** Store a credential in the OS keychain. */
export async function setCredential(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  if (!isTauri()) throw new Error("setCredential requires Tauri");
  return tauriInvoke<void>("set_credential", { service, account, value });
}

/** Retrieve a credential from the OS keychain. Throws if not found. */
export async function getCredential(service: string, account: string): Promise<string> {
  if (!isTauri()) throw new Error("getCredential requires Tauri");
  return tauriInvoke<string>("get_credential", { service, account });
}

/** Delete a credential from the OS keychain (idempotent). */
export async function deleteCredential(service: string, account: string): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke<void>("delete_credential", { service, account });
}

// ─── GitHub OAuth device flow ───────────────────────────────────────────────
//
// "Sign in with GitHub" from Settings > Accounts. The token is stored in the
// OS keychain (service "gitwand:github", account "oauth"); once present, the
// Rust `gh_*` commands route through the REST API instead of the `gh` CLI, so
// the `gh` binary is no longer required.

export interface GithubDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** verification_uri with the code pre-filled (skips manual entry); may be "". */
  verification_uri_complete: string;
  expires_in: number;
  /** Minimum seconds between polls (GitHub-mandated, floored at 5). */
  interval: number;
}

export interface GithubDevicePoll {
  /** "pending" | "slow_down" | "success" | "error" */
  status: string;
  /** Populated only on success. */
  login: string;
  /** Populated only on a hard error. */
  error: string;
}

/** Begin the OAuth device flow — returns the user code + verification URL. */
export async function githubDeviceStart(): Promise<GithubDeviceCode> {
  if (isTauri()) return tauriInvoke<GithubDeviceCode>("github_device_start");
  // dev:web — mock device flow (does not actually authenticate).
  const res = await devFetch(`${DEV_SERVER}/api/github-device-start`, { method: "POST" });
  if (!res.ok) throw new Error(`github-device-start failed: ${res.status}`);
  return res.json() as Promise<GithubDeviceCode>;
}

/** Poll once for the access token. On success the token is stored server-side. */
export async function githubDevicePoll(deviceCode: string): Promise<GithubDevicePoll> {
  if (isTauri()) return tauriInvoke<GithubDevicePoll>("github_device_poll", { deviceCode });
  const res = await devFetch(`${DEV_SERVER}/api/github-device-poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (!res.ok) throw new Error(`github-device-poll failed: ${res.status}`);
  return res.json() as Promise<GithubDevicePoll>;
}

/**
 * Open an http(s) URL in the system browser. In Tauri the webview's
 * `window.open` is a no-op, so we hand the URL to the OS via the Rust
 * `open_url` command; in dev:web we fall back to `window.open`.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>("open_url", { url });
    return;
  }
  window.open(url, "_blank");
}

/** Whether a Settings-managed GitHub token is currently stored. */
export async function githubTokenPresent(): Promise<boolean> {
  if (isTauri()) return tauriInvoke<boolean>("github_token_present");
  const res = await devFetch(`${DEV_SERVER}/api/github-token-present`, { method: "POST" });
  if (!res.ok) return false;
  return res.json() as Promise<boolean>;
}

// ─── Azure DevOps (Entra ID OAuth + REST) ───────────────────────────────────
//
// "Sign in with Azure" from Settings > Accounts uses Microsoft's Entra ID
// device-authorization grant — the same UX as the GitHub device flow, so the
// `GithubDeviceCode` / `GithubDevicePoll` shapes are reused verbatim. The
// access token is stored in the OS keychain (service "gitwand:azure", account
// "oauth"); the `az_*` PR commands route through the Azure DevOps REST API.
//
// Azure DevOps support is Tauri-only — there is no dev:web mock backend, so the
// browser path throws a clear "desktop only" error.

const AZURE_WEB_ONLY = "Azure DevOps sign-in is only available in the desktop app.";

/** Begin the Entra ID device flow — returns the user code + verification URL. */
export async function azureDeviceStart(): Promise<GithubDeviceCode> {
  if (isTauri()) return tauriInvoke<GithubDeviceCode>("azure_device_start");
  throw new Error(AZURE_WEB_ONLY);
}

/** Poll once for the Entra access token. On success the token is stored. */
export async function azureDevicePoll(deviceCode: string): Promise<GithubDevicePoll> {
  if (isTauri()) return tauriInvoke<GithubDevicePoll>("azure_device_poll", { deviceCode });
  throw new Error(AZURE_WEB_ONLY);
}

/** Whether a Settings-managed Azure token is currently stored. */
export async function azureTokenPresent(): Promise<boolean> {
  if (isTauri()) return tauriInvoke<boolean>("azure_token_present");
  return false;
}

/**
 * Sign out of Azure DevOps: removes both the access token and the Entra refresh
 * token from the OS keychain. Must be called on account removal — clearing only
 * the access token would leave the refresh token able to mint new tokens.
 */
export async function azureSignOut(): Promise<void> {
  if (isTauri()) return tauriInvoke<void>("azure_sign_out");
}

/** Map the Rust `PullRequest` serde shape (snake_case) to the camelCase type. */
function mapRawPr(pr: any): PullRequest {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    author: pr.author,
    branch: pr.branch,
    base: pr.base,
    draft: pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    url: pr.url,
    additions: pr.additions,
    deletions: pr.deletions,
    labels: pr.labels ?? [],
    assignees: pr.assignees ?? [],
    reviewRequested: pr.review_requested ?? [],
    reviewDecision: pr.review_decision ?? "",
    mergeStateStatus: pr.merge_state_status ?? "",
    checksRollup: pr.checks_rollup ?? "",
    commentCount: pr.comment_count ?? 0,
  };
}

export async function azCurrentUser(): Promise<string> {
  if (isTauri()) return tauriInvoke<string>("az_current_user");
  throw new Error(AZURE_WEB_ONLY);
}

export async function azListPrs(
  cwd: string,
  state: string = "open",
  limit: number = 10,
  offset: number = 0,
): Promise<PullRequest[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<any[]>("az_list_prs", { cwd, state, limit, offset });
    return raw.map(mapRawPr);
  }
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrCount(cwd: string, state: string = "open"): Promise<number> {
  if (isTauri()) return tauriInvoke<number>("az_pr_count", { cwd, state });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrDetail(cwd: string, number: number): Promise<PullRequestDetail> {
  if (isTauri()) {
    const raw = await tauriInvoke<any>("az_pr_detail", { cwd, number });
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body,
      state: raw.state,
      author: raw.author,
      branch: raw.branch,
      base: raw.base,
      draft: raw.draft,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      mergedAt: raw.merged_at,
      url: raw.url,
      additions: raw.additions,
      deletions: raw.deletions,
      changedFiles: raw.changed_files,
      comments: raw.comments,
      reviewComments: raw.review_comments,
      labels: raw.labels,
      reviewers: raw.reviewers,
      mergeable: raw.mergeable,
      checksStatus: raw.checks_status,
      canMerge: raw.can_merge ?? null,
    };
  }
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrDiff(cwd: string, number: number): Promise<string> {
  if (isTauri()) return tauriInvoke<string>("az_pr_diff", { cwd, number });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrFiles(cwd: string, number: number): Promise<string[]> {
  if (isTauri()) return tauriInvoke<string[]>("az_pr_files", { cwd, number });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azCreatePr(
  cwd: string,
  title: string,
  body: string,
  base?: string,
  draft?: boolean,
): Promise<PullRequest> {
  if (isTauri()) {
    const raw = await tauriInvoke<any>("az_create_pr", { cwd, title, body, base, draft });
    return mapRawPr(raw);
  }
  throw new Error(AZURE_WEB_ONLY);
}

export async function azMergePr(cwd: string, number: number, method: string = "merge"): Promise<void> {
  if (isTauri()) return tauriInvoke<void>("az_merge_pr", { cwd, number, method });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrReady(cwd: string, number: number): Promise<void> {
  if (isTauri()) return tauriInvoke<void>("az_pr_ready", { cwd, number });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azCheckoutPr(cwd: string, number: number): Promise<void> {
  if (isTauri()) return tauriInvoke<void>("az_checkout_pr", { cwd, number });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrComments(cwd: string, number: number): Promise<PrReviewComment[]> {
  if (isTauri()) return tauriInvoke<PrReviewComment[]>("az_pr_comments", { cwd, number });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrCreateComment(cwd: string, number: number, body: string): Promise<PrReviewComment> {
  if (isTauri()) return tauriInvoke<PrReviewComment>("az_pr_create_comment", { cwd, number, body });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrChecks(cwd: string, number: number): Promise<CICheck[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<Array<{ name: string; state: string; conclusion: string; details_url: string }>>(
      "az_pr_checks",
      { cwd, number },
    );
    return raw.map((c) => ({
      name: c.name,
      state: c.state,
      conclusion: c.conclusion,
      detailsUrl: c.details_url,
    }));
  }
  throw new Error(AZURE_WEB_ONLY);
}

export async function azPrReviews(cwd: string, number: number): Promise<PrReview[]> {
  if (isTauri()) return tauriInvoke<PrReview[]>("az_pr_reviews", { cwd, number });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azSubmitReview(
  cwd: string,
  number: number,
  opts: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string },
): Promise<PrReview> {
  if (isTauri()) {
    return tauriInvoke<PrReview>("az_submit_review", { cwd, number, event: opts.event, body: opts.body });
  }
  throw new Error(AZURE_WEB_ONLY);
}

export async function azListLikes(cwd: string, prNumber: number, compositeId: number): Promise<PrReaction[]> {
  if (isTauri()) return tauriInvoke<PrReaction[]>("az_list_likes", { cwd, prNumber, compositeId });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azAddLike(cwd: string, prNumber: number, compositeId: number): Promise<PrReaction> {
  if (isTauri()) return tauriInvoke<PrReaction>("az_add_like", { cwd, prNumber, compositeId });
  throw new Error(AZURE_WEB_ONLY);
}

export async function azDeleteLike(cwd: string, prNumber: number, compositeId: number): Promise<void> {
  if (isTauri()) return tauriInvoke<void>("az_delete_like", { cwd, prNumber, compositeId });
  throw new Error(AZURE_WEB_ONLY);
}
