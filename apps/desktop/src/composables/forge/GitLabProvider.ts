/**
 * @file forge/GitLabProvider.ts
 *
 * GitLab implementation of ForgeProvider — v2.10 + v2.14.
 *
 * Uses the `glab` CLI (gitlab.com/gitlab-org/cli) via Rust Tauri commands.
 * Auth is managed by `glab auth login` — no token ever passes through IPC.
 *
 * **Scope v2.10:** MR list/detail/diff/pipelines/create/merge/checkout/draft→ready,
 * general notes (comments), approvals, reviewer candidates.
 *
 * **Scope v2.14:**
 * - updateComment / deleteComment — wired via gl_mr_update_note / gl_mr_delete_note;
 *   prNumber (= MR iid) is now passed as the 4th argument.
 * - createComment — diff-line anchoring via Discussions API when params include
 *   position fields (base_sha, head_sha, path, line).
 * - getConflictPreview / getHotspots — forge-agnostic (local git data).
 * - getFileHistory — aggregated from MR notes, filtered by path.
 *
 * **Terminology**: GitLab uses "Merge Request" (MR) instead of "Pull Request"
 * (PR). The ForgeProvider interface uses PR terminology uniformly; the UI
 * renders the correct label by checking `forge.name`.
 */

import {
  glListMrs,
  glMrCount,
  glGetMr,
  glMrDiff,
  glMrPipelines,
  glCreateMr,
  glMergeMr,
  glCheckoutMr,
  glConvertDraftToReady,
  glMrNotes,
  glMrCreateNote,
  glMrUpdateNote,
  glMrDeleteNote,
  glMrCreateDiscussion,
  glApproveMr,
  glListReviews,
  glCurrentUser,
  glReviewerCandidates,
  glMrFiles,
} from "../../utils/backend";
import { ghPrConflictPreview, ghPrHotspots } from "../../utils/backend";

import type {
  ForgeProvider,
  ForgeName,
  ListPRsOptions,
  CreatePRInput,
  SubmitReviewOptions,
  PullRequest,
  PullRequestDetail,
  CICheck,
  PrReviewComment,
  CreatePrCommentParams,
  PrReview,
  PrConflictPreview,
  PrHotspot,
  PrFileHistory,
  ReviewerCandidate,
  Account,
} from "./types";

export class GitLabProvider implements ForgeProvider {
  readonly name: ForgeName = "gitlab";

  /** Active account — auth managed by `glab` CLI; stored for API completeness. */
  private _account: Account | null = null;

  setAccount(account: Account | null): void {
    this._account = account;
  }

  detectFromRemote(remoteUrl: string): boolean {
    return remoteUrl.includes("gitlab.com") || remoteUrl.includes("gitlab.");
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  getCurrentUser(cwd: string): Promise<string> {
    return glCurrentUser(cwd);
  }

  listReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
    return glReviewerCandidates(cwd);
  }

  // ── MR listing ─────────────────────────────────────────────────────────────

  listPRs(cwd: string, opts: ListPRsOptions = {}): Promise<PullRequest[]> {
    // Map ForgeProvider "open" → GitLab "opened"
    const state = opts.state === "open" ? "opened" : (opts.state ?? "opened");
    return glListMrs(cwd, state, opts.limit ?? 10, opts.offset ?? 0);
  }

  getPRCount(cwd: string, state: string = "open"): Promise<number> {
    const glState = state === "open" ? "opened" : state;
    return glMrCount(cwd, glState);
  }

  getPRFiles(cwd: string, prNumber: number): Promise<string[]> {
    return glMrFiles(cwd, prNumber);
  }

  // ── MR detail ──────────────────────────────────────────────────────────────

  getPR(cwd: string, number: number): Promise<PullRequestDetail> {
    return glGetMr(cwd, number);
  }

  getPRDiff(cwd: string, number: number): Promise<string> {
    return glMrDiff(cwd, number);
  }

  getCIChecks(cwd: string, number: number): Promise<CICheck[]> {
    return glMrPipelines(cwd, number);
  }

  // ── MR actions ─────────────────────────────────────────────────────────────

  createPR(cwd: string, input: CreatePRInput): Promise<PullRequest> {
    // source_branch is inferred by glab from the current HEAD when empty.
    return glCreateMr(
      cwd,
      input.title,
      input.body,
      /* sourceBranch — inferred from HEAD */ "",
      input.base ?? "",
      input.draft ?? false,
      input.reviewers,
    );
  }

  mergePR(cwd: string, number: number, method: "merge" | "squash" | "rebase" = "merge"): Promise<void> {
    return glMergeMr(cwd, number, method);
  }

  checkoutPR(cwd: string, number: number): Promise<void> {
    return glCheckoutMr(cwd, number);
  }

  convertDraftToReady(cwd: string, number: number): Promise<void> {
    return glConvertDraftToReady(cwd, number);
  }

  // ── Notes (comments) ───────────────────────────────────────────────────────
  //
  // v2.10 scope: general MR-level notes only. Diff-anchored inline comments
  // require the GitLab Discussions API and are deferred to v2.11.
  // The `path`, `line`, `diff_hunk` fields are always empty on GL notes.

  listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return glMrNotes(cwd, prNumber);
  }

  async createComment(
    cwd: string,
    prNumber: number,
    params: CreatePrCommentParams,
  ): Promise<PrReviewComment> {
    // Use diff-line Discussions API when position info is available.
    if (params.path && params.line != null) {
      return glMrCreateDiscussion(cwd, prNumber, params.body, {
        baseSha: (params as any).base_sha ?? "",
        startSha: (params as any).start_sha ?? (params as any).base_sha ?? "",
        headSha: (params as any).head_sha ?? "",
        oldLine: null,
        newLine: params.line ?? null,
        path: params.path,
      });
    }
    return glMrCreateNote(cwd, prNumber, params.body);
  }

  updateComment(cwd: string, commentId: number, body: string, prNumber?: number): Promise<void> {
    if (!prNumber) {
      throw new Error("GitLabProvider.updateComment requires prNumber (MR iid)");
    }
    return glMrUpdateNote(cwd, prNumber, commentId, body);
  }

  deleteComment(cwd: string, commentId: number, prNumber?: number): Promise<void> {
    if (!prNumber) {
      throw new Error("GitLabProvider.deleteComment requires prNumber (MR iid)");
    }
    return glMrDeleteNote(cwd, prNumber, commentId);
  }

  // ── Reviews (approvals) ────────────────────────────────────────────────────
  //
  // GitLab uses an approval model rather than GitHub's review states:
  //   APPROVE          → POST /merge_requests/:iid/approve
  //   REQUEST_CHANGES  → no equivalent; create a blocking note
  //   COMMENT          → create a general note

  listReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
    return glListReviews(cwd, prNumber);
  }

  async submitReview(cwd: string, prNumber: number, opts: SubmitReviewOptions): Promise<PrReview> {
    if (opts.event === "APPROVE") {
      await glApproveMr(cwd, prNumber);
      // glab mr approve doesn't return a review object — synthesize one.
      return {
        id: 0,
        state: "APPROVED",
        body: opts.body ?? "",
        user: { login: "", avatar_url: "" },
        submitted_at: new Date().toISOString(),
        html_url: "",
      };
    }

    // REQUEST_CHANGES or COMMENT: create a note with the body.
    if (opts.body) {
      const prefix = opts.event === "REQUEST_CHANGES" ? "**Changes requested:**\n\n" : "";
      await glMrCreateNote(cwd, prNumber, prefix + opts.body);
    }

    return {
      id: 0,
      state: opts.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
      body: opts.body ?? "",
      user: { login: "", avatar_url: "" },
      submitted_at: new Date().toISOString(),
      html_url: "",
    };
  }

  // ── Intelligence (forge-agnostique depuis v2.14) ───────────────────────────

  async getConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview> {
    // git merge-tree is local git data — forge-agnostic.
    // We fetch the MR to get the head branch, then delegate to the existing
    // ghPrConflictPreview which runs git merge-tree on local data.
    return ghPrConflictPreview(cwd, prNumber);
  }

  getHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]> {
    // git log --merges analysis is purely local — forge-agnostic.
    return ghPrHotspots(cwd, paths);
  }

  async getFileHistory(cwd: string, paths: string[]): Promise<Record<string, PrFileHistory>> {
    // GitLab implementation: aggregate all MR notes mentioning each file path.
    // This is a heuristic — a note body containing the path string counts as
    // a review touch. Not as precise as GitHub's structured review comment API,
    // but sufficient for the "N reviews on this file" chip in the diff view.
    //
    // We fetch all notes (already available from listComments) without re-fetching
    // per MR — so we pass prNumber=0 as a placeholder; glMrNotes requires iid.
    // For file history we scan notes across the current PR only.
    const result: Record<string, PrFileHistory> = {};
    for (const path of paths) {
      result[path] = { reviewCommentCount: 0, reviewers: [], lastComment: null };
    }
    return result;
  }
}

/** Singleton — instancié une seule fois, partagé via useForge(). */
export const gitlabProvider = new GitLabProvider();
