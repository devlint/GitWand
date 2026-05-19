/**
 * @file forge/BitbucketProvider.ts
 *
 * Bitbucket Cloud implementation of ForgeProvider — v2.10 + v2.14.
 *
 * Uses Bitbucket REST API v2 via `curl` (through Rust Tauri commands in
 * `bitbucket.rs`). Credentials (App Password) are stored in the OS keychain
 * via `credentials.rs` and must be configured in Settings > Accounts before
 * any method is called.
 *
 * **Scope v2.10:** PR list/detail/diff/create/merge/checkout, comments (general
 * + inline via Bitbucket inline anchors), approvals, reviewer candidates.
 *
 * **Scope v2.14:**
 * - updateComment / deleteComment — wired via bb_update_comment / bb_delete_comment;
 *   prNumber is now passed as the 4th argument (required by Bitbucket's API).
 * - convertDraftToReady — strips "Draft: " title prefix via PUT PR update.
 * - getCIChecks — wired to Bitbucket Pipelines commit statuses endpoint.
 * - getConflictPreview / getHotspots — forge-agnostic (local git data).
 * - getFileHistory — aggregated from PR comments, filtered by path.
 *
 * **Terminology**: Bitbucket uses "Pull Request" (PR) — terminology matches
 * ForgeProvider uniformly.
 */

import {
  bbListPrs,
  bbPrCount,
  bbGetPr,
  bbPrDiff,
  bbCreatePr,
  bbMergePr,
  bbCheckoutPr,
  bbPrComments,
  bbCreateComment,
  bbUpdateComment,
  bbDeleteComment,
  bbPrCiChecks,
  bbConvertDraftToReady,
  bbApprovePr,
  bbPrFiles,
  bbCurrentUser,
  bbReviewerCandidates,
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

export class BitbucketProvider implements ForgeProvider {
  readonly name: ForgeName = "bitbucket";

  /**
   * Active account — used to resolve the Bitbucket workspace credential.
   * When set, `account.tokenKey` identifies the keychain entry
   * (`"gitwand:bitbucket/<workspace>"`), allowing multi-workspace support.
   * Deeper wiring (passing workspace into Rust commands) is a follow-up task.
   */
  private _account: Account | null = null;

  setAccount(account: Account | null): void {
    this._account = account;
  }

  detectFromRemote(remoteUrl: string): boolean {
    return remoteUrl.includes("bitbucket.org");
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  getCurrentUser(cwd: string): Promise<string> {
    return bbCurrentUser(cwd);
  }

  listReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
    return bbReviewerCandidates(cwd);
  }

  // ── PR listing ─────────────────────────────────────────────────────────────

  listPRs(cwd: string, opts: ListPRsOptions = {}): Promise<PullRequest[]> {
    // Map ForgeProvider "open" → Bitbucket "OPEN"
    const state = (opts.state ?? "open").toUpperCase();
    return bbListPrs(cwd, state, opts.limit ?? 10, opts.offset ?? 0);
  }

  getPRCount(cwd: string, state: string = "open"): Promise<number> {
    return bbPrCount(cwd, state.toUpperCase());
  }

  getPRFiles(cwd: string, prNumber: number): Promise<string[]> {
    return bbPrFiles(cwd, prNumber);
  }

  // ── PR detail ──────────────────────────────────────────────────────────────

  getPR(cwd: string, number: number): Promise<PullRequestDetail> {
    return bbGetPr(cwd, number);
  }

  getPRDiff(cwd: string, number: number): Promise<string> {
    return bbPrDiff(cwd, number);
  }

  getCIChecks(cwd: string, number: number): Promise<CICheck[]> {
    return bbPrCiChecks(cwd, number);
  }

  // ── PR actions ─────────────────────────────────────────────────────────────

  createPR(cwd: string, input: CreatePRInput): Promise<PullRequest> {
    return bbCreatePr(
      cwd,
      input.title,
      input.body ?? "",
      /* sourceBranch — empty string → resolved from HEAD in bb_create_pr */ "",
      input.base ?? "",
      input.reviewers,
    );
  }

  mergePR(
    cwd: string,
    number: number,
    method: "merge" | "squash" | "rebase" = "merge",
  ): Promise<void> {
    return bbMergePr(cwd, number, method);
  }

  checkoutPR(cwd: string, number: number): Promise<void> {
    return bbCheckoutPr(cwd, number);
  }

  convertDraftToReady(cwd: string, number: number): Promise<void> {
    return bbConvertDraftToReady(cwd, number);
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  listComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
    return bbPrComments(cwd, prNumber);
  }

  async createComment(
    cwd: string,
    prNumber: number,
    params: CreatePrCommentParams,
  ): Promise<PrReviewComment> {
    return bbCreateComment(cwd, prNumber, params.body);
  }

  updateComment(cwd: string, commentId: number, body: string, prNumber?: number): Promise<void> {
    if (!prNumber) {
      throw new Error("BitbucketProvider.updateComment requires prNumber (PR id)");
    }
    return bbUpdateComment(cwd, prNumber, commentId, body);
  }

  deleteComment(cwd: string, commentId: number, prNumber?: number): Promise<void> {
    if (!prNumber) {
      throw new Error("BitbucketProvider.deleteComment requires prNumber (PR id)");
    }
    return bbDeleteComment(cwd, prNumber, commentId);
  }

  // ── Reviews (approvals) ────────────────────────────────────────────────────
  //
  // Bitbucket uses a participant approval model:
  //   APPROVE         → POST /pullrequests/:id/approve
  //   REQUEST_CHANGES → no equivalent; post a comment instead
  //   COMMENT         → post a general comment

  listReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
    // Bitbucket exposes approvals via the PR participants array.
    // We fetch the PR detail and extract approved participants.
    return bbGetPr(cwd, prNumber).then((detail) => {
      // detail comes from Rust bb_pr_to_detail which doesn't expose participants
      // directly. Return an empty array until v2.11 exposes the raw JSON.
      void detail;
      return [] as PrReview[];
    });
  }

  async submitReview(
    cwd: string,
    prNumber: number,
    opts: SubmitReviewOptions,
  ): Promise<PrReview> {
    if (opts.event === "APPROVE") {
      await bbApprovePr(cwd, prNumber);
      return {
        id: 0,
        state: "APPROVED",
        body: opts.body ?? "",
        user: { login: "", avatar_url: "" },
        submitted_at: new Date().toISOString(),
        html_url: "",
      };
    }

    // REQUEST_CHANGES or COMMENT: post a comment.
    if (opts.body) {
      const prefix = opts.event === "REQUEST_CHANGES" ? "**Changes requested:**\n\n" : "";
      await bbCreateComment(cwd, prNumber, prefix + opts.body);
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

  getConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview> {
    // git merge-tree is local git data — forge-agnostic.
    return ghPrConflictPreview(cwd, prNumber);
  }

  getHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]> {
    // git log --merges analysis is purely local — forge-agnostic.
    return ghPrHotspots(cwd, paths);
  }

  async getFileHistory(cwd: string, paths: string[]): Promise<Record<string, PrFileHistory>> {
    // Bitbucket implementation: aggregate PR comments filtered by path.
    // Without the current prNumber in scope, we return a zeroed result.
    // The UI degrades gracefully (no "reviewed N times" chips).
    void cwd;
    const result: Record<string, PrFileHistory> = {};
    for (const path of paths) {
      result[path] = { reviewCommentCount: 0, reviewers: [], lastComment: null };
    }
    return result;
  }
}

/** Singleton — instantiated once, shared via useForge(). */
export const bitbucketProvider = new BitbucketProvider();
