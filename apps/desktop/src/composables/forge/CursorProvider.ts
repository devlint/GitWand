/**
 * @file forge/CursorProvider.ts
 *
 * Cursor Origin — detection-only ForgeProvider (Phase 0).
 *
 * Origin is Cursor's git forge (`origin.cursor.com`, early beta). Its git
 * transport is plain git, so clone / fetch / push / pull, merges and the whole
 * conflict-resolution engine already work on an Origin repo with zero code —
 * they never go through a ForgeProvider.
 *
 * What does NOT work yet is the PR integration. Origin's REST API documents
 * only the "Origin App" auth model (Ed25519 keypair → app JWT → 15-minute
 * installation token), which is a poor fit for a desktop client and cannot
 * even read repos mirrored inbound from GitHub. The pragmatic path — shelling
 * out to the `origin` CLI, the way `gh.rs` does for GitHub — is deferred until
 * Origin leaves beta and its API stops moving.
 *
 * **Why this file exists at all:** without it, `getProviderByUrl()` falls
 * through to `githubProvider`, so an Origin repo fired `gh` CLI calls at
 * `origin.cursor.com` and surfaced a bewildering GitHub auth error. Every
 * method here throws a *typed* `ForgeNotImplementedError` instead, which
 * `usePrPanel` turns into an honest "not supported yet" banner with a link to
 * the repo on the web.
 *
 * Optional contract methods (`listIssues` — Origin has no issue tracker at all
 * —, `listBranches`, `dismissReview`, `requestReviewers`) are deliberately
 * *omitted* rather than stubbed, which is the contract's signal for "hide the
 * affordance".
 */

import {
  ForgeNotImplementedError,
  type ForgeProvider,
  type ForgeName,
  type ListPRsOptions,
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
  type Account,
} from "./types";
export { CURSOR_WEB_BASE } from "./types";

/**
 * Origin's git host. Deliberately NOT a bare `cursor.com`: that is the web UI
 * (`cursor.com/codebase/{owner}/{repo}`) and the docs site, so matching it
 * would misread unrelated URLs as forge remotes.
 *
 * Kept in sync with `detect_provider()` in
 * `src-tauri/src/git/parse.rs` and its mirror in `dev-server.mjs`.
 */
const ORIGIN_GIT_HOST = "origin.cursor.com";

export class CursorProvider implements ForgeProvider {
  readonly name: ForgeName = "cursor";

  detectFromRemote(remoteUrl: string): boolean {
    return remoteUrl.includes(ORIGIN_GIT_HOST);
  }

  /**
   * No-op. Called unconditionally by the account-aware resolution path, so
   * throwing here would break repo switching rather than just the PR panel.
   */
  setAccount(_account: Account | null): void {
    // Intentionally empty — there is no Origin credential to bind yet.
  }

  /** Single throw site so every method reports the same typed error. */
  private unsupported(method: string): never {
    throw new ForgeNotImplementedError("cursor", method);
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  getCurrentUser(_cwd: string): Promise<string> {
    this.unsupported("getCurrentUser");
  }

  listReviewerCandidates(_cwd: string): Promise<ReviewerCandidate[]> {
    this.unsupported("listReviewerCandidates");
  }

  // ── PR listing ────────────────────────────────────────────────────────────

  listPRs(_cwd: string, _opts?: ListPRsOptions): Promise<PullRequest[]> {
    this.unsupported("listPRs");
  }

  getPRCount(_cwd: string, _state?: string): Promise<number> {
    this.unsupported("getPRCount");
  }

  getPRFiles(_cwd: string, _prNumber: number): Promise<string[]> {
    this.unsupported("getPRFiles");
  }

  // ── PR detail ─────────────────────────────────────────────────────────────

  getPR(_cwd: string, _number: number): Promise<PullRequestDetail> {
    this.unsupported("getPR");
  }

  getPRDiff(_cwd: string, _number: number): Promise<string> {
    this.unsupported("getPRDiff");
  }

  getCIChecks(_cwd: string, _number: number): Promise<CICheck[]> {
    this.unsupported("getCIChecks");
  }

  getCheckAnnotations(_cwd: string, _number: number): Promise<CIAnnotation[]> {
    this.unsupported("getCheckAnnotations");
  }

  // ── PR actions ────────────────────────────────────────────────────────────

  createPR(_cwd: string, _input: CreatePRInput): Promise<PullRequest> {
    this.unsupported("createPR");
  }

  mergePR(_cwd: string, _number: number, _method?: "merge" | "squash" | "rebase"): Promise<void> {
    this.unsupported("mergePR");
  }

  checkoutPR(_cwd: string, _number: number): Promise<void> {
    this.unsupported("checkoutPR");
  }

  convertDraftToReady(_cwd: string, _number: number): Promise<void> {
    this.unsupported("convertDraftToReady");
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  listComments(_cwd: string, _prNumber: number): Promise<PrReviewComment[]> {
    this.unsupported("listComments");
  }

  createComment(
    _cwd: string,
    _prNumber: number,
    _params: CreatePrCommentParams
  ): Promise<PrReviewComment> {
    this.unsupported("createComment");
  }

  updateComment(
    _cwd: string,
    _commentId: number,
    _body: string,
    _prNumber?: number
  ): Promise<void> {
    this.unsupported("updateComment");
  }

  deleteComment(_cwd: string, _commentId: number, _prNumber?: number): Promise<void> {
    this.unsupported("deleteComment");
  }

  // ── Reviews ───────────────────────────────────────────────────────────────

  listReviews(_cwd: string, _prNumber: number): Promise<PrReview[]> {
    this.unsupported("listReviews");
  }

  submitReview(
    _cwd: string,
    _prNumber: number,
    _opts: SubmitReviewOptions
  ): Promise<PrReview> {
    this.unsupported("submitReview");
  }

  // ── Intelligence ──────────────────────────────────────────────────────────
  //
  // getConflictPreview/getHotspots are forge-agnostic (local git) and would
  // technically run, but they are only ever reached from a PR that this
  // provider cannot list. Throwing keeps the "no PR integration" story
  // consistent rather than half-answering.

  getConflictPreview(_cwd: string, _prNumber: number): Promise<PrConflictPreview> {
    this.unsupported("getConflictPreview");
  }

  getHotspots(_cwd: string, _paths: string[]): Promise<PrHotspot[]> {
    this.unsupported("getHotspots");
  }

  getFileHistory(_cwd: string, _paths: string[]): Promise<Record<string, PrFileHistory>> {
    this.unsupported("getFileHistory");
  }
}

export const cursorProvider = new CursorProvider();
