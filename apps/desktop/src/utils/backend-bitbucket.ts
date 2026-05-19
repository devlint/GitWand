// backend-bitbucket.ts — Bitbucket Cloud REST v2 wrappers.
// Extracted from backend.ts as part of the v2.11 backend split to keep module size manageable.
// Consumers should import directly from this file instead of backend.ts for these symbols.

import { isTauri, tauriInvoke } from "./backend-core";
import {
  PullRequest,
  PullRequestDetail,
  CICheck,
  PrReviewComment,
  ReviewerCandidate,
} from "./backend-pr";

// ─── Bitbucket Cloud REST v2 wrappers ───────────────────────────────────────
//
// All commands delegate to `bitbucket.rs` which calls the Bitbucket REST API
// via `curl`. Credentials must be stored in the OS keychain first
// (service="gitwand:bitbucket", account=workspace, value="username:app_password").

/** Map a raw Bitbucket comment JSON to a PrReviewComment. */
function bbCommentToReviewComment(raw: Record<string, unknown>): PrReviewComment {
  const content = raw.content as Record<string, unknown> | undefined;
  const user = raw.author as Record<string, unknown> | undefined;
  const inline = raw.inline as Record<string, unknown> | undefined;
  return {
    id: (raw.id as number) ?? 0,
    body: (content?.raw as string) ?? (content?.markup as string) ?? "",
    author: (user?.nickname as string) ?? (user?.display_name as string) ?? "",
    created_at: (raw.created_on as string) ?? "",
    updated_at: (raw.updated_on as string) ?? "",
    path: (inline?.path as string) ?? "",
    line: (inline?.to as number) ?? null,
    original_line: (inline?.from as number) ?? null,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    in_reply_to_id: null,
    diff_hunk: "",
    url: ((raw.links as Record<string, unknown>)?.html as Record<string, unknown>)?.href as string ?? "",
  };
}

/** List open/merged/declined Bitbucket pull requests. */
export async function bbListPrs(
  cwd: string,
  state: string,
  limit: number,
  offset: number,
): Promise<PullRequest[]> {
  if (!isTauri()) return [];
  return tauriInvoke<PullRequest[]>("bb_list_prs", { cwd, state, limit, offset });
}

/** Count PRs for a given state. */
export async function bbPrCount(cwd: string, state: string): Promise<number> {
  if (!isTauri()) return 0;
  return tauriInvoke<number>("bb_pr_count", { cwd, state });
}

/** Get detailed PR info. */
export async function bbGetPr(cwd: string, prId: number): Promise<PullRequestDetail> {
  if (!isTauri()) throw new Error("bbGetPr requires Tauri");
  return tauriInvoke<PullRequestDetail>("bb_get_pr", { cwd, prId });
}

/** Get the unified diff of a PR. */
export async function bbPrDiff(cwd: string, prId: number): Promise<string> {
  if (!isTauri()) return "";
  return tauriInvoke<string>("bb_pr_diff", { cwd, prId });
}

/** Create a Bitbucket pull request. */
export async function bbCreatePr(
  cwd: string,
  title: string,
  body: string,
  sourceBranch: string,
  targetBranch: string,
  reviewers?: string[],
): Promise<PullRequest> {
  if (!isTauri()) throw new Error("bbCreatePr requires Tauri");
  return tauriInvoke<PullRequest>("bb_create_pr", {
    cwd, title, body, sourceBranch, targetBranch, reviewers: reviewers ?? [],
  });
}

/** Merge a Bitbucket PR. */
export async function bbMergePr(
  cwd: string,
  prId: number,
  method: string,
): Promise<void> {
  if (!isTauri()) throw new Error("bbMergePr requires Tauri");
  return tauriInvoke<void>("bb_merge_pr", { cwd, prId, method });
}

/** Checkout a PR branch locally (git fetch + switch). */
export async function bbCheckoutPr(cwd: string, prId: number): Promise<void> {
  if (!isTauri()) throw new Error("bbCheckoutPr requires Tauri");
  return tauriInvoke<void>("bb_checkout_pr", { cwd, prId });
}

/** List comments on a PR. */
export async function bbPrComments(cwd: string, prId: number): Promise<PrReviewComment[]> {
  if (!isTauri()) return [];
  const raw = await tauriInvoke<unknown[]>("bb_pr_comments", { cwd, prId });
  return (raw as Record<string, unknown>[]).map(bbCommentToReviewComment);
}

/** Create a comment on a Bitbucket PR. */
export async function bbCreateComment(
  cwd: string,
  prId: number,
  body: string,
): Promise<PrReviewComment> {
  if (!isTauri()) throw new Error("bbCreateComment requires Tauri");
  const raw = await tauriInvoke<Record<string, unknown>>("bb_create_comment", { cwd, prId, body });
  return bbCommentToReviewComment(raw);
}

/** Update a comment on a Bitbucket PR. */
export async function bbUpdateComment(
  cwd: string,
  prId: number,
  commentId: number,
  body: string,
): Promise<void> {
  if (!isTauri()) throw new Error("bbUpdateComment requires Tauri");
  return tauriInvoke<void>("bb_update_comment", { cwd, prId, commentId, body });
}

/** Delete a comment on a Bitbucket PR. */
export async function bbDeleteComment(
  cwd: string,
  prId: number,
  commentId: number,
): Promise<void> {
  if (!isTauri()) throw new Error("bbDeleteComment requires Tauri");
  return tauriInvoke<void>("bb_delete_comment", { cwd, prId, commentId });
}

/** Approve a Bitbucket PR (current user). */
export async function bbApprovePr(cwd: string, prId: number): Promise<void> {
  if (!isTauri()) throw new Error("bbApprovePr requires Tauri");
  return tauriInvoke<void>("bb_approve_pr", { cwd, prId });
}

/** List file paths changed in a PR (via diffstat). */
export async function bbPrFiles(cwd: string, prId: number): Promise<string[]> {
  if (!isTauri()) return [];
  return tauriInvoke<string[]>("bb_pr_files", { cwd, prId });
}

/** Get CI status checks for a PR via Bitbucket Pipelines commit statuses. */
export async function bbPrCiChecks(cwd: string, prId: number): Promise<CICheck[]> {
  if (!isTauri()) return [];
  return tauriInvoke<CICheck[]>("bb_pr_ci_checks", { cwd, prId });
}

/** Convert a "Draft: …" Bitbucket PR to ready-for-review (strips title prefix). */
export async function bbConvertDraftToReady(cwd: string, prId: number): Promise<void> {
  if (!isTauri()) throw new Error("bbConvertDraftToReady requires Tauri");
  return tauriInvoke<void>("bb_convert_draft_to_ready", { cwd, prId });
}

/** Get the current Bitbucket user (from stored credentials). */
export async function bbCurrentUser(cwd: string): Promise<string> {
  if (!isTauri()) throw new Error("bbCurrentUser requires Tauri");
  return tauriInvoke<string>("bb_current_user", { cwd });
}

/** List reviewer candidates (repo members with write access). */
export async function bbReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
  if (!isTauri()) return [];
  return tauriInvoke<ReviewerCandidate[]>("bb_reviewer_candidates", { cwd });
}
