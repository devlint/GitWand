/**
 * @file forge/GiteaProvider.ts
 *
 * Gitea / Forgejo implementation of ForgeProvider.
 *
 * Talks to `/api/v1` through the `gitea_*` Tauri commands. Auth is a personal
 * access token in the OS keychain, configured in Settings > Accounts, and the
 * server host comes from that account rather than from a constant.
 *
 * Deliberately unimplemented in this first pass (issue #193): auto-merge,
 * submitting and dismissing reviews, check annotations, file history. Reading
 * reviews IS implemented, so verdicts still render.
 */

import {
  giteaCurrentUser,
  giteaListPrs,
  giteaPrCount,
  giteaGetPr,
  giteaPrDiff,
  giteaPrStatus,
  giteaPrFiles,
  giteaListIssues,
  giteaPrComments,
  giteaCreateComment,
  giteaUpdateComment,
  giteaDeleteComment,
  giteaListReviews,
  giteaCreatePr,
  giteaMergePr,
  giteaCheckoutPr,
  giteaConvertDraftToReady,
  giteaReviewerCandidates,
  giteaBranches,
  ghPrConflictPreview,
  ghPrHotspots,
} from "../../utils/backend";

import {
  ForgeNotImplementedError,
  type ForgeProvider,
  type ForgeName,
  type ListPRsOptions,
  type ListIssuesOptions,
  type CreatePRInput,
  type SubmitReviewOptions,
  type PullRequest,
  type PullRequestDetail,
  type CICheck,
  type CIAnnotation,
  type PrReviewComment,
  type CreatePrCommentParams,
  type PrReview,
  type PrConflictPreview,
  type PrHotspot,
  type PrFileHistory,
  type ReviewerCandidate,
  type Issue,
  type Account,
} from "./types";

export class GiteaProvider implements ForgeProvider {
  readonly name: ForgeName = "gitea";

  private _account: Account | null = null;

  setAccount(account: Account | null): void {
    this._account = account;
  }

  /**
   * Only the hosts the pure Rust arm also recognises. A self-hosted instance on
   * a neutral hostname is resolved by the account-host match in
   * `gitRemoteInfo`, not here, so this stays a mirror of `detect_provider`.
   */
  detectFromRemote(remoteUrl: string): boolean {
    const u = remoteUrl.toLowerCase();
    return u.includes("codeberg.org") || u.includes("gitea") || u.includes("forgejo");
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  getCurrentUser(cwd: string): Promise<string> {
    return giteaCurrentUser(cwd);
  }

  listReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
    return giteaReviewerCandidates(cwd);
  }

  listBranches(cwd: string): Promise<string[]> {
    return giteaBranches(cwd);
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  listPRs(cwd: string, opts?: ListPRsOptions): Promise<PullRequest[]> {
    return giteaListPrs(cwd, opts?.state ?? "open", opts?.limit ?? 10, opts?.offset ?? 0);
  }

  listIssues(cwd: string, opts?: ListIssuesOptions): Promise<Issue[]> {
    return giteaListIssues(cwd, opts?.limit ?? 30);
  }

  getPRCount(cwd: string, state = "open"): Promise<number> {
    return giteaPrCount(cwd, state);
  }

  getPRFiles(cwd: string, prNumber: number): Promise<string[]> {
    return giteaPrFiles(cwd, prNumber);
  }

  // ── Detail ────────────────────────────────────────────────────────────────

  getPR(cwd: string, number: number): Promise<PullRequestDetail> {
    return giteaGetPr(cwd, number);
  }

  getPRDiff(cwd: string, number: number): Promise<string> {
    return giteaPrDiff(cwd, number);
  }

  getCIChecks(cwd: string, number: number): Promise<CICheck[]> {
    return giteaPrStatus(cwd, number);
  }

  /** Gitea has no check-annotation concept GitWand can read. Empty, not an error. */
  async getCheckAnnotations(_cwd: string, _number: number): Promise<CIAnnotation[]> {
    return [];
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  createPR(cwd: string, input: CreatePRInput): Promise<PullRequest> {
    // sourceBranch is left empty: the Rust side resolves it from HEAD. base,
    // when omitted, is resolved by the Rust side to the repo's real default
    // branch rather than a guessed constant like "main".
    return giteaCreatePr(cwd, input.title, input.body, "", input.base ?? "");
  }

  mergePR(cwd: string, number: number, method?: "merge" | "squash" | "rebase"): Promise<void> {
    return giteaMergePr(cwd, number, method ?? "merge");
  }

  async enableAutoMerge(
    _cwd: string,
    _number: number,
    _method?: "merge" | "squash" | "rebase",
  ): Promise<void> {
    throw new ForgeNotImplementedError("gitea", "enableAutoMerge");
  }

  async disableAutoMerge(_cwd: string, _number: number): Promise<void> {
    throw new ForgeNotImplementedError("gitea", "disableAutoMerge");
  }

  checkoutPR(cwd: string, number: number): Promise<void> {
    return giteaCheckoutPr(cwd, number);
  }

  convertDraftToReady(cwd: string, number: number): Promise<void> {
    return giteaConvertDraftToReady(cwd, number);
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return giteaPrComments(cwd, prNumber);
  }

  listIssueComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return giteaPrComments(cwd, prNumber);
  }

  createComment(
    cwd: string,
    prNumber: number,
    params: CreatePrCommentParams,
  ): Promise<PrReviewComment> {
    // Gitea's only comment endpoint is issue-style, with no diff-line anchor,
    // so params' line-anchoring fields (path, line, side, …) are silently
    // dropped here. Only body survives.
    return giteaCreateComment(cwd, prNumber, params.body);
  }

  updateComment(cwd: string, commentId: number, body: string): Promise<void> {
    return giteaUpdateComment(cwd, commentId, body);
  }

  deleteComment(cwd: string, commentId: number): Promise<void> {
    return giteaDeleteComment(cwd, commentId);
  }

  // ── Reviews ───────────────────────────────────────────────────────────────

  listReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
    return giteaListReviews(cwd, prNumber);
  }

  async submitReview(
    _cwd: string,
    _prNumber: number,
    _opts: SubmitReviewOptions,
  ): Promise<PrReview> {
    throw new ForgeNotImplementedError("gitea", "submitReview");
  }

  // `dismissReview` and `requestReviewers` are intentionally absent, not
  // defined-and-throwing: `usePrPanel` capability-checks with
  // `typeof forge.dismissReview === "function"` to hide the action.

  // ── Intelligence (local git, forge-agnostic) ──────────────────────────────

  getConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview> {
    return ghPrConflictPreview(cwd, prNumber);
  }

  getHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]> {
    return ghPrHotspots(cwd, paths);
  }

  /** No cheap Gitea source for per-file review history. Empty beats invented. */
  async getFileHistory(
    _cwd: string,
    _paths: string[],
  ): Promise<Record<string, PrFileHistory>> {
    return {};
  }
}

export const giteaProvider = new GiteaProvider();
