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
  ghPrDetail,
  ghPrDiff,
  ghPrChecks,
  ghCheckAnnotations,
  ghCreatePr,
  ghMergePr,
  ghCheckoutPr,
  ghPrComments,
  ghPrIssueComments,
  ghPrCreateComment,
  ghPrUpdateComment,
  ghPrDeleteComment,
  ghPrListReviews,
  ghPrSubmitReview,
  ghPrConflictPreview,
  ghPrHotspots,
  ghPrFileHistory,
  ghPrReady,
  ghListIssues,
} from "../../utils/backend";

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

  checkoutPR(cwd: string, number: number): Promise<void> {
    return ghCheckoutPr(cwd, number);
  }

  convertDraftToReady(cwd: string, number: number): Promise<void> {
    return ghPrReady(cwd, number);
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return ghPrComments(cwd, prNumber);
  }

  listIssueComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return ghPrIssueComments(cwd, prNumber);
  }

  createComment(cwd: string, prNumber: number, params: CreatePrCommentParams): Promise<PrReviewComment> {
    return ghPrCreateComment(cwd, prNumber, params);
  }

  updateComment(cwd: string, commentId: number, body: string, _prNumber?: number): Promise<void> {
    // _prNumber is ignored on GitHub — the comment_id is globally unique.
    return ghPrUpdateComment(cwd, commentId, body);
  }

  deleteComment(cwd: string, commentId: number, _prNumber?: number): Promise<void> {
    // _prNumber is ignored on GitHub — the comment_id is globally unique.
    return ghPrDeleteComment(cwd, commentId);
  }

  // ── Reviews ───────────────────────────────────────────────────────────────

  listReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
    return ghPrListReviews(cwd, prNumber);
  }

  submitReview(cwd: string, prNumber: number, opts: SubmitReviewOptions): Promise<PrReview> {
    return ghPrSubmitReview(cwd, prNumber, opts);
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
