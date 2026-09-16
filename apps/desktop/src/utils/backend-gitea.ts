/**
 * @file backend-gitea.ts
 *
 * Typed wrappers over the `gitea_*` Tauri commands.
 *
 * Read paths also work in `dev:web` through dev-server routes, which is a
 * deliberate departure from GitLab/Bitbucket/Azure (all Tauri-only). It is what
 * makes the Gitea panel testable without a packaged build.
 *
 * Write paths stay Tauri-only and throw in browser mode.
 */

import { isTauri, tauriInvoke, DEV_SERVER } from "./backend-core";
import type { PullRequest, PullRequestDetail, CICheck, PrReviewComment, PrReview, ReviewerCandidate } from "./backend-pr";
import type { Issue } from "./backend";

async function devGet<T>(route: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${DEV_SERVER}/api/${route}?${qs}`, { method: "GET" });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`dev-server ${route} failed: ${detail}`);
  }
  return (await res.json()) as T;
}

// ─── Reads (Tauri + dev:web) ────────────────────────────────────────────────

export async function giteaCurrentUser(cwd: string): Promise<string> {
  if (isTauri()) return tauriInvoke<string>("gitea_current_user", { cwd });
  return devGet<string>("gitea-current-user", { cwd });
}

export async function giteaListPrs(
  cwd: string,
  state = "open",
  limit = 10,
  offset = 0,
): Promise<PullRequest[]> {
  if (isTauri()) return tauriInvoke<PullRequest[]>("gitea_list_prs", { cwd, state, limit, offset });
  return devGet<PullRequest[]>("gitea-list-prs", {
    cwd,
    state,
    limit: String(limit),
    offset: String(offset),
  });
}

export async function giteaPrCount(cwd: string, state = "open"): Promise<number> {
  if (isTauri()) return tauriInvoke<number>("gitea_pr_count", { cwd, state });
  return devGet<number>("gitea-pr-count", { cwd, state });
}

export async function giteaGetPr(cwd: string, index: number): Promise<PullRequestDetail> {
  if (isTauri()) return tauriInvoke<PullRequestDetail>("gitea_get_pr", { cwd, index });
  return devGet<PullRequestDetail>("gitea-get-pr", { cwd, index: String(index) });
}

export async function giteaPrDiff(cwd: string, index: number): Promise<string> {
  if (isTauri()) return tauriInvoke<string>("gitea_pr_diff", { cwd, index });
  return devGet<string>("gitea-pr-diff", { cwd, index: String(index) });
}

export async function giteaPrStatus(cwd: string, index: number): Promise<CICheck[]> {
  if (isTauri()) return tauriInvoke<CICheck[]>("gitea_pr_status", { cwd, index });
  return devGet<CICheck[]>("gitea-pr-status", { cwd, index: String(index) });
}

export async function giteaPrComments(cwd: string, index: number): Promise<PrReviewComment[]> {
  if (isTauri()) return tauriInvoke<PrReviewComment[]>("gitea_pr_comments", { cwd, index });
  return devGet<PrReviewComment[]>("gitea-pr-comments", { cwd, index: String(index) });
}

export async function giteaListIssues(cwd: string, limit = 30): Promise<Issue[]> {
  if (isTauri()) return tauriInvoke<Issue[]>("gitea_list_issues", { cwd, limit });
  return devGet<Issue[]>("gitea-list-issues", { cwd, limit: String(limit) });
}

// ─── Reads (Tauri only) ─────────────────────────────────────────────────────

export async function giteaPrFiles(cwd: string, index: number): Promise<string[]> {
  if (!isTauri()) return [];
  return tauriInvoke<string[]>("gitea_pr_files", { cwd, index });
}

export async function giteaListReviews(cwd: string, index: number): Promise<PrReview[]> {
  if (!isTauri()) return [];
  return tauriInvoke<PrReview[]>("gitea_list_reviews", { cwd, index });
}

export async function giteaReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
  if (!isTauri()) return [];
  return tauriInvoke<ReviewerCandidate[]>("gitea_reviewer_candidates", { cwd });
}

export async function giteaBranches(cwd: string): Promise<string[]> {
  if (!isTauri()) return [];
  return tauriInvoke<string[]>("gitea_branches", { cwd });
}

// ─── Writes (Tauri only) ────────────────────────────────────────────────────

/**
 * Validates a token against a server before anything is stored, returning the
 * login. `host` is passed straight to Rust's `normalize_base_url`, which
 * accepts either a bare host or a full URL, so callers should pass the full
 * validated base URL (scheme, host, port) here, not a bare host: a bare host
 * would force the https default, defeating validation of a plain-http
 * instance or one on a non-default port.
 */
export async function giteaValidateToken(host: string, token: string): Promise<string> {
  if (!isTauri()) throw new Error("giteaValidateToken requires Tauri");
  return tauriInvoke<string>("gitea_validate_token", { host, token });
}

export async function giteaCreatePr(
  cwd: string,
  title: string,
  body: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<PullRequest> {
  if (!isTauri()) throw new Error("giteaCreatePr requires Tauri");
  return tauriInvoke<PullRequest>("gitea_create_pr", {
    cwd,
    title,
    body,
    sourceBranch,
    targetBranch,
  });
}

export async function giteaMergePr(cwd: string, index: number, method?: string): Promise<void> {
  if (!isTauri()) throw new Error("giteaMergePr requires Tauri");
  return tauriInvoke<void>("gitea_merge_pr", { cwd, index, method });
}

export async function giteaCheckoutPr(cwd: string, index: number): Promise<void> {
  if (!isTauri()) throw new Error("giteaCheckoutPr requires Tauri");
  return tauriInvoke<void>("gitea_checkout_pr", { cwd, index });
}

export async function giteaConvertDraftToReady(cwd: string, index: number): Promise<void> {
  if (!isTauri()) throw new Error("giteaConvertDraftToReady requires Tauri");
  return tauriInvoke<void>("gitea_convert_draft_to_ready", { cwd, index });
}

export async function giteaCreateComment(
  cwd: string,
  index: number,
  body: string,
): Promise<PrReviewComment> {
  if (!isTauri()) throw new Error("giteaCreateComment requires Tauri");
  return tauriInvoke<PrReviewComment>("gitea_create_comment", { cwd, index, body });
}

export async function giteaUpdateComment(
  cwd: string,
  commentId: number,
  body: string,
): Promise<void> {
  if (!isTauri()) throw new Error("giteaUpdateComment requires Tauri");
  return tauriInvoke<void>("gitea_update_comment", { cwd, commentId, body });
}

export async function giteaDeleteComment(cwd: string, commentId: number): Promise<void> {
  if (!isTauri()) throw new Error("giteaDeleteComment requires Tauri");
  return tauriInvoke<void>("gitea_delete_comment", { cwd, commentId });
}
