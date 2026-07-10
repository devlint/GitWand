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
  glMrAnnotations,
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
  glBranches,
  glMrFiles,
  glListIssues,
  glRequestReviewers,
  glMrDiffRefs,
} from "../../utils/backend";
import { ghPrConflictPreview, ghPrHotspots } from "../../utils/backend";

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
import type { PendingReviewComment } from "../../utils/backend";

/** Note-body markers `submitReview` writes so `listReviews` can later
 *  derive a verdict from plain MR notes (GitLab has no review resource). */
const CHANGES_REQUESTED_MARKER = "**Changes requested:**";
const COMMENT_REVIEW_MARKER = "**Review:**";

export class GitLabProvider implements ForgeProvider {
  readonly name: ForgeName = "gitlab";

  /** Active account — auth managed by `glab` CLI; stored for API completeness. */
  private _account: Account | null = null;

  /**
   * Last MR iid resolved via `getPR` (F1, v3.6.0). `getFileHistory`'s
   * `ForgeProvider` signature carries no `prNumber` (it's shared across all
   * forges, and GitHub's implementation is repo-wide), but a real GitLab
   * heuristic needs *some* MR to fetch notes from — the most recently
   * opened one is the only sane default. Stays `null` (empty file history,
   * matching the old placeholder) until a PR detail has actually loaded.
   */
  private _lastIid: number | null = null;

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

  listBranches(cwd: string): Promise<string[]> {
    return glBranches(cwd);
  }

  // ── MR listing ─────────────────────────────────────────────────────────────

  listPRs(cwd: string, opts: ListPRsOptions = {}): Promise<PullRequest[]> {
    // Map ForgeProvider "open" → GitLab "opened"
    const state = opts.state === "open" ? "opened" : (opts.state ?? "opened");
    return glListMrs(cwd, state, opts.limit ?? 10, opts.offset ?? 0);
  }

  listIssues(cwd: string, opts: ListIssuesOptions = {}): Promise<Issue[]> {
    return glListIssues(cwd, opts.filter ?? "", opts.limit ?? 100);
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
    this._lastIid = number;
    return glGetMr(cwd, number);
  }

  getPRDiff(cwd: string, number: number): Promise<string> {
    return glMrDiff(cwd, number);
  }

  getCIChecks(cwd: string, number: number): Promise<CICheck[]> {
    return glMrPipelines(cwd, number);
  }

  getCheckAnnotations(cwd: string, number: number): Promise<CIAnnotation[]> {
    return glMrAnnotations(cwd, number);
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
      const refs = await glMrDiffRefs(cwd, prNumber);
      const side = params.side ?? "RIGHT";
      return glMrCreateDiscussion(cwd, prNumber, params.body, {
        baseSha: refs.baseSha,
        startSha: refs.startSha,
        headSha: refs.headSha,
        oldLine: side === "LEFT" ? params.line : null,
        newLine: side === "RIGHT" ? params.line : null,
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

  // ── Reviews (approvals + note-derived verdicts, F1 v3.6.0) ─────────────────
  //
  // GitLab uses an approval model rather than GitHub's review states:
  //   APPROVE          → POST /merge_requests/:iid/approve
  //   REQUEST_CHANGES  → no equivalent; create a note prefixed with a marker
  //   COMMENT          → create a note prefixed with a (different) marker
  // `listReviews` scans notes for those markers to surface
  // CHANGES_REQUESTED/COMMENTED verdicts alongside real approvals — GitLab
  // has no structured "review" resource to query directly.

  /** Post each pending inline comment as a real Discussions-API discussion,
   *  fetching diff refs once and reusing them (F1). No-op when empty. */
  private async postBatchComments(
    cwd: string,
    prNumber: number,
    comments?: PendingReviewComment[],
  ): Promise<void> {
    if (!comments?.length) return;
    const refs = await glMrDiffRefs(cwd, prNumber);
    for (const c of comments) {
      await glMrCreateDiscussion(cwd, prNumber, c.body, {
        baseSha: refs.baseSha,
        startSha: refs.startSha,
        headSha: refs.headSha,
        oldLine: c.side === "LEFT" ? c.line : null,
        newLine: c.side === "RIGHT" ? c.line : null,
        path: c.path,
      });
    }
  }

  async listReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
    const [approvals, notes] = await Promise.all([
      glListReviews(cwd, prNumber),
      glMrNotes(cwd, prNumber).catch(() => [] as PrReviewComment[]),
    ]);
    const derived: PrReview[] = [];
    for (const note of notes) {
      let state: "CHANGES_REQUESTED" | "COMMENTED" | null = null;
      let marker = "";
      if (note.body.startsWith(CHANGES_REQUESTED_MARKER)) {
        state = "CHANGES_REQUESTED";
        marker = CHANGES_REQUESTED_MARKER;
      } else if (note.body.startsWith(COMMENT_REVIEW_MARKER)) {
        state = "COMMENTED";
        marker = COMMENT_REVIEW_MARKER;
      }
      if (!state) continue;
      derived.push({
        id: note.id,
        state,
        body: note.body.slice(marker.length).trim(),
        user: { login: note.author, avatar_url: "" },
        submitted_at: note.created_at,
        html_url: "",
      });
    }
    return [...approvals, ...derived];
  }

  async submitReview(cwd: string, prNumber: number, opts: SubmitReviewOptions): Promise<PrReview> {
    if (opts.event === "APPROVE") {
      await glApproveMr(cwd, prNumber);
      await this.postBatchComments(cwd, prNumber, opts.comments);
      // glab mr approve doesn't return a review object — synthesize a
      // representative one reflecting what actually happened.
      return {
        id: 0,
        state: "APPROVED",
        body: opts.body ?? "",
        user: { login: "", avatar_url: "" },
        submitted_at: new Date().toISOString(),
        html_url: "",
      };
    }

    // REQUEST_CHANGES or COMMENT: create a marked note with the body (so
    // `listReviews` can later derive the verdict from it), then batch-post
    // any staged inline comments as real Discussions-API discussions.
    const marker = opts.event === "REQUEST_CHANGES" ? CHANGES_REQUESTED_MARKER : COMMENT_REVIEW_MARKER;
    if (opts.body) {
      await glMrCreateNote(cwd, prNumber, `${marker}\n\n${opts.body}`);
    }
    await this.postBatchComments(cwd, prNumber, opts.comments);

    return {
      id: 0,
      state: opts.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
      body: opts.body ?? "",
      user: { login: "", avatar_url: "" },
      submitted_at: new Date().toISOString(),
      html_url: "",
    };
  }

  // `dismissReview` is intentionally omitted — GitLab has no direct "dismiss
  // a review" equivalent (approvals/notes aren't a dismissible review object
  // like GitHub's). Leaving the method undefined (rather than defined-but-
  // throwing) is what lets `usePrPanel`'s `forgeSupportsDismissReview`
  // capability check (`typeof forge.dismissReview === "function"`) hide the
  // action instead of showing a button that's a silent no-op (B4, v3.6.0).

  requestReviewers(cwd: string, prNumber: number, logins: string[]): Promise<void> {
    return glRequestReviewers(cwd, prNumber, logins);
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
    // Real heuristic (F1, v3.6.0): fetch the current MR's notes once, count
    // how many mention each path (anchored discussion note, or a general
    // note whose body happens to reference the path), collect reviewers,
    // and keep the most recent as `lastComment`.
    //
    // `ForgeProvider.getFileHistory` carries no `prNumber` (shared across
    // forges; GitHub's own implementation is repo-wide) — GitLab has no
    // cheap repo-wide "notes across all MRs" query, so this uses the most
    // recently opened MR (`_lastIid`, set by `getPR`) as the scope. Empty
    // history (matching the old placeholder) until a PR detail has loaded.
    const result: Record<string, PrFileHistory> = {};
    for (const path of paths) {
      result[path] = { reviewCommentCount: 0, reviewers: [], lastComment: null };
    }
    if (this._lastIid == null) return result;

    const notes = await glMrNotes(cwd, this._lastIid).catch(() => [] as PrReviewComment[]);
    for (const path of paths) {
      const matching = notes.filter((n) => n.path === path || n.body.includes(path));
      if (!matching.length) continue;
      const reviewers = [...new Set(matching.map((n) => n.author).filter(Boolean))];
      const last = matching[matching.length - 1];
      result[path] = {
        reviewCommentCount: matching.length,
        reviewers,
        lastComment: { author: last.author, body: last.body, pr_number: String(this._lastIid) },
      };
    }
    return result;
  }
}

/** Singleton — instancié une seule fois, partagé via useForge(). */
export const gitlabProvider = new GitLabProvider();
