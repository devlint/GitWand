/**
 * @file forge/GitHubProvider.ts
 *
 * Implémentation ForgeProvider pour GitHub.
 *
 * Chaque méthode délègue directement aux fonctions `gh*` existantes de
 * `utils/backend.ts` — aucun changement comportemental, uniquement une
 * adaptation de signature vers le contrat ForgeProvider.
 *
 * `convertDraftToReady` est la seule nouveauté v2.10 — elle wrappera
 * `gh pr ready <number>` une fois le backend Rust ajouté (§5.x).
 */

import {
  ghListPrs,
  ghPrCount,
  ghPrFiles,
  ghCurrentUser,
  ghListReviewerCandidates,
  ghBranches,
  ghPrDetail,
  ghPrDiff,
  ghPrChecks,
  ghCheckAnnotations,
  ghCreatePr,
  ghMergePr,
  ghEnableAutoMerge,
  ghDisableAutoMerge,
  ghCheckoutPr,
  ghPrComments,
  ghPrReviewThreads,
  ghSetReviewThreadResolved,
  ghPrIssueComments,
  ghPrCreateComment,
  ghPrUpdateComment,
  ghPrDeleteComment,
  ghPrListReviews,
  ghPrSubmitReview,
  ghDismissReview,
  ghRequestReviewers,
  ghPrConflictPreview,
  ghPrHotspots,
  ghPrFileHistory,
  ghPrReady,
  ghPrEdit,
  ghListIssues,
} from "../../utils/backend";
import { withThreadState } from "../../utils/prCommentThreads";

import type {
  ForgeProvider,
  ForgeName,
  ListPRsOptions,
  ListIssuesOptions,
  CreatePRInput,
  SubmitReviewOptions,
  PullRequest,
  PullRequestDetail,
  CICheck,
  CIAnnotation,
  PrReviewComment,
  CreatePrCommentParams,
  PrReview,
  PrConflictPreview,
  PrHotspot,
  PrFileHistory,
  ReviewerCandidate,
  Issue,
  Account,
  PrEdit,
} from "./types";

export class GitHubProvider implements ForgeProvider {
  readonly name: ForgeName = "github";

  /** Active account — auth is managed by `gh` CLI; field stored for API completeness. */
  private _account: Account | null = null;

  setAccount(account: Account | null): void {
    this._account = account;
  }

  detectFromRemote(remoteUrl: string): boolean {
    return remoteUrl.includes("github.com");
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  getCurrentUser(cwd: string): Promise<string> {
    return ghCurrentUser();
  }

  listReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
    return ghListReviewerCandidates(cwd);
  }

  listBranches(cwd: string): Promise<string[]> {
    return ghBranches(cwd);
  }

  // ── PR listing ────────────────────────────────────────────────────────────

  listPRs(cwd: string, opts: ListPRsOptions = {}): Promise<PullRequest[]> {
    return ghListPrs(cwd, opts.state ?? "open", opts.limit ?? 10, opts.offset ?? 0);
  }

  listIssues(cwd: string, opts: ListIssuesOptions = {}): Promise<Issue[]> {
    return ghListIssues(cwd, opts.filter ?? "", opts.limit ?? 100);
  }

  getPRCount(cwd: string, state: string = "open"): Promise<number> {
    return ghPrCount(cwd, state);
  }

  getPRFiles(cwd: string, prNumber: number): Promise<string[]> {
    return ghPrFiles(cwd, prNumber);
  }

  // ── PR detail ─────────────────────────────────────────────────────────────

  getPR(cwd: string, number: number): Promise<PullRequestDetail> {
    return ghPrDetail(cwd, number);
  }

  getPRDiff(cwd: string, number: number): Promise<string> {
    return ghPrDiff(cwd, number);
  }

  getCIChecks(cwd: string, number: number): Promise<CICheck[]> {
    return ghPrChecks(cwd, number);
  }

  getCheckAnnotations(cwd: string, number: number): Promise<CIAnnotation[]> {
    return ghCheckAnnotations(cwd, number);
  }

  // ── PR actions ────────────────────────────────────────────────────────────

  createPR(cwd: string, input: CreatePRInput): Promise<PullRequest> {
    return ghCreatePr(cwd, input.title, input.body, input.base, input.draft, input.reviewers, input.baseRepo);
  }

  mergePR(cwd: string, number: number, method: "merge" | "squash" | "rebase" = "merge"): Promise<void> {
    return ghMergePr(cwd, number, method);
  }

  enableAutoMerge(cwd: string, number: number, method: "merge" | "squash" | "rebase" = "merge"): Promise<void> {
    return ghEnableAutoMerge(cwd, number, method);
  }

  disableAutoMerge(cwd: string, number: number): Promise<void> {
    return ghDisableAutoMerge(cwd, number);
  }

  checkoutPR(cwd: string, number: number): Promise<void> {
    return ghCheckoutPr(cwd, number);
  }

  convertDraftToReady(cwd: string, number: number): Promise<void> {
    return ghPrReady(cwd, number);
  }

  updatePR(cwd: string, number: number, edit: PrEdit): Promise<void> {
    return ghPrEdit(cwd, number, edit);
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  async listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    // REST comments carry no thread state; overlay it from GraphQL. Best-effort:
    // without it the comments still list, just without resolve affordances.
    const [comments, threads] = await Promise.all([
      ghPrComments(cwd, prNumber),
      ghPrReviewThreads(cwd, prNumber).catch(() => []),
    ]);
    return withThreadState(comments, threads);
  }

  setThreadResolved(cwd: string, threadId: string, resolved: boolean): Promise<void> {
    return ghSetReviewThreadResolved(cwd, threadId, resolved);
  }

  listIssueComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return ghPrIssueComments(cwd, prNumber);
  }

  createComment(cwd: string, prNumber: number, params: CreatePrCommentParams): Promise<PrReviewComment> {
    return ghPrCreateComment(cwd, prNumber, params);
  }

  updateComment(cwd: string, commentId: number, body: string, prNumber?: number): Promise<void> {
    // prNumber resolves the repo the PR lives in (upstream, for a fork).
    return ghPrUpdateComment(cwd, commentId, body, prNumber);
  }

  deleteComment(cwd: string, commentId: number, prNumber?: number): Promise<void> {
    return ghPrDeleteComment(cwd, commentId, prNumber);
  }

  // ── Reviews ───────────────────────────────────────────────────────────────

  listReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
    return ghPrListReviews(cwd, prNumber);
  }

  submitReview(cwd: string, prNumber: number, opts: SubmitReviewOptions): Promise<PrReview> {
    return ghPrSubmitReview(cwd, prNumber, opts);
  }

  dismissReview(cwd: string, prNumber: number, reviewId: number, message?: string): Promise<void> {
    return ghDismissReview(cwd, prNumber, reviewId, message);
  }

  requestReviewers(cwd: string, prNumber: number, logins: string[]): Promise<void> {
    return ghRequestReviewers(cwd, prNumber, logins);
  }

  // ── Intelligence ──────────────────────────────────────────────────────────

  getConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview> {
    return ghPrConflictPreview(cwd, prNumber);
  }

  getHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]> {
    return ghPrHotspots(cwd, paths);
  }

  getFileHistory(cwd: string, paths: string[]): Promise<Record<string, PrFileHistory>> {
    return ghPrFileHistory(cwd, paths);
  }
}

/** Singleton — instancié une seule fois, partagé via useForge(). */
export const githubProvider = new GitHubProvider();
