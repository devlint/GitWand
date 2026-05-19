// backend-gitlab.ts — GitLab / glab CLI wrappers (§2.x Forge integrations).
// Extracted from backend.ts as part of the v2.11 backend split to keep module size manageable.
// Consumers should import directly from this file instead of backend.ts for these symbols.

import { isTauri, tauriInvoke } from "./backend-core";
import {
  PullRequest,
  PullRequestDetail,
  CICheck,
  PrReviewComment,
  PrReview,
  ReviewerCandidate,
} from "./backend-pr";

// ─── GitLab / glab CLI wrappers (§2.x Forge integrations) ──────────────────
//
// These mirror the gh* functions above but call the `glab` CLI via Rust.
// All functions are Tauri-only for now — no dev-server fallback needed
// since GitLab repos are only accessible in the native Tauri app context.
//
// Auth: managed by `glab auth login` — no token is ever passed via IPC.

/** Detect if `glab` CLI is installed in the context of a given repo. */
export async function detectGlab(cwd: string): Promise<boolean> {
  if (isTauri()) {
    return tauriInvoke<boolean>("detect_glab", { cwd });
  }
  return false;
}

/** List merge requests using `glab`. */
export async function glListMrs(
  cwd: string,
  state: string = "opened",
  limit: number = 10,
  offset: number = 0,
): Promise<PullRequest[]> {
  if (!isTauri()) throw new Error("glListMrs requires Tauri");
  return tauriInvoke<PullRequest[]>("gl_list_mrs", { cwd, state, limit, offset });
}

/** Count MRs via `glab`. Returns 0 on non-fatal errors. */
export async function glMrCount(cwd: string, state: string = "opened"): Promise<number> {
  if (!isTauri()) return 0;
  return tauriInvoke<number>("gl_mr_count", { cwd, state });
}

/** Get detailed MR info. */
export async function glGetMr(cwd: string, iid: number): Promise<PullRequestDetail> {
  if (!isTauri()) throw new Error("glGetMr requires Tauri");
  const raw = await tauriInvoke<{
    number: number; title: string; body: string; state: string; author: string;
    branch: string; base: string; draft: boolean; created_at: string; updated_at: string;
    merged_at: string; url: string; additions: number; deletions: number;
    changed_files: number; comments: number; review_comments: number;
    labels: string[]; reviewers: string[]; mergeable: string; checks_status: string;
  }>("gl_get_mr", { cwd, iid });
  return {
    number: raw.number, title: raw.title, body: raw.body, state: raw.state,
    author: raw.author, branch: raw.branch, base: raw.base, draft: raw.draft,
    createdAt: raw.created_at, updatedAt: raw.updated_at, mergedAt: raw.merged_at,
    url: raw.url, additions: raw.additions, deletions: raw.deletions,
    changedFiles: raw.changed_files, comments: raw.comments,
    reviewComments: raw.review_comments, labels: raw.labels, reviewers: raw.reviewers,
    mergeable: raw.mergeable, checksStatus: raw.checks_status,
  } as unknown as PullRequestDetail;
}

/** Get the unified diff of a MR. */
export async function glMrDiff(cwd: string, iid: number): Promise<string> {
  if (!isTauri()) throw new Error("glMrDiff requires Tauri");
  return tauriInvoke<string>("gl_mr_diff", { cwd, iid });
}

/** Get CI pipeline status for a MR. */
export async function glMrPipelines(cwd: string, iid: number): Promise<CICheck[]> {
  if (!isTauri()) return [];
  return tauriInvoke<CICheck[]>("gl_mr_pipelines", { cwd, iid });
}

/** Create a MR. */
export async function glCreateMr(
  cwd: string,
  title: string,
  body: string,
  sourceBranch: string,
  targetBranch: string,
  draft: boolean,
  reviewers?: string[],
): Promise<PullRequest> {
  if (!isTauri()) throw new Error("glCreateMr requires Tauri");
  return tauriInvoke<PullRequest>("gl_create_mr", {
    cwd, title, body,
    sourceBranch, targetBranch, draft,
    reviewers: reviewers ?? [],
  });
}

/** Merge a MR. */
export async function glMergeMr(
  cwd: string,
  iid: number,
  method: string = "merge",
): Promise<void> {
  if (!isTauri()) throw new Error("glMergeMr requires Tauri");
  return tauriInvoke<void>("gl_merge_mr", { cwd, iid, method });
}

/** Checkout a MR branch locally. */
export async function glCheckoutMr(cwd: string, iid: number): Promise<void> {
  if (!isTauri()) throw new Error("glCheckoutMr requires Tauri");
  return tauriInvoke<void>("gl_checkout_mr", { cwd, iid });
}

/** Convert a draft MR to ready-for-review. */
export async function glConvertDraftToReady(cwd: string, iid: number): Promise<void> {
  if (!isTauri()) throw new Error("glConvertDraftToReady requires Tauri");
  return tauriInvoke<void>("gl_convert_draft_to_ready", { cwd, iid });
}

/**
 * Helper — map a raw GitLab note JSON object to a PrReviewComment.
 * GitLab notes are simpler than GitHub review comments: no diff-line
 * anchoring in v2.10 (that requires the Discussions API).
 */
function glNoteToComment(note: Record<string, unknown>): PrReviewComment {
  const author = note.author as Record<string, unknown> | null | undefined;
  return {
    id: (note.id as number) ?? 0,
    body: (note.body as string) ?? "",
    author: (author?.username as string) ?? "",
    created_at: (note.created_at as string) ?? "",
    updated_at: (note.updated_at as string) ?? "",
    path: "",
    line: null,
    original_line: null,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    in_reply_to_id: null,
    diff_hunk: "",
    url: "",
  };
}

/** List notes (comments) for a MR. */
export async function glMrNotes(cwd: string, iid: number): Promise<PrReviewComment[]> {
  if (!isTauri()) return [];
  const raw = await tauriInvoke<unknown[]>("gl_mr_notes", { cwd, iid });
  return (raw as Record<string, unknown>[]).map(glNoteToComment);
}

/** Create a note (comment) on a MR. */
export async function glMrCreateNote(
  cwd: string,
  iid: number,
  body: string,
): Promise<PrReviewComment> {
  if (!isTauri()) throw new Error("glMrCreateNote requires Tauri");
  const raw = await tauriInvoke<Record<string, unknown>>("gl_mr_create_note", { cwd, iid, body });
  return glNoteToComment(raw);
}

/** Update a note on a MR. */
export async function glMrUpdateNote(
  cwd: string,
  iid: number,
  noteId: number,
  body: string,
): Promise<void> {
  if (!isTauri()) throw new Error("glMrUpdateNote requires Tauri");
  return tauriInvoke<void>("gl_mr_update_note", { cwd, iid, noteId, body });
}

/** Delete a note on a MR. */
export async function glMrDeleteNote(
  cwd: string,
  iid: number,
  noteId: number,
): Promise<void> {
  if (!isTauri()) throw new Error("glMrDeleteNote requires Tauri");
  return tauriInvoke<void>("gl_mr_delete_note", { cwd, iid, noteId });
}

/** Approve a MR. */
export async function glApproveMr(cwd: string, iid: number): Promise<void> {
  if (!isTauri()) throw new Error("glApproveMr requires Tauri");
  return tauriInvoke<void>("gl_approve_mr", { cwd, iid });
}

/** List approvals (reviews) for a MR. Returns PrReview[] mapped from GitLab approval data. */
export async function glListReviews(cwd: string, iid: number): Promise<PrReview[]> {
  if (!isTauri()) return [];
  const raw = await tauriInvoke<Record<string, unknown>>("gl_list_reviews", { cwd, iid });
  // GitLab approvals endpoint returns { approved_by: [{user:{...}}], ... }
  const approvedBy = (raw.approved_by as Array<{ user: Record<string, unknown> }>) ?? [];
  return approvedBy.map((entry, idx) => ({
    id: idx,
    state: "APPROVED",
    body: "",
    user: {
      login: (entry.user?.username as string) ?? "",
      avatar_url: (entry.user?.avatar_url as string) ?? "",
    },
    submitted_at: "",
    html_url: "",
  } satisfies PrReview));
}

/** Get the current GitLab user's username. */
export async function glCurrentUser(cwd: string): Promise<string> {
  if (!isTauri()) throw new Error("glCurrentUser requires Tauri");
  return tauriInvoke<string>("gl_current_user", { cwd });
}

/** List reviewer candidates (project members). */
export async function glReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
  if (!isTauri()) return [];
  return tauriInvoke<ReviewerCandidate[]>("gl_reviewer_candidates", { cwd });
}

/**
 * Create a diff-line anchored discussion on a MR via the GitLab Discussions API.
 *
 * When `path`, `headSha`, and `baseSha` are all provided, the discussion is
 * anchored to the specific diff line (parité with GitHub inline review comments).
 * Falls back to a general MR note if position fields are empty.
 */
export async function glMrCreateDiscussion(
  cwd: string,
  iid: number,
  body: string,
  opts: {
    baseSha?: string;
    startSha?: string;
    headSha?: string;
    oldLine?: number | null;
    newLine?: number | null;
    path?: string;
  } = {},
): Promise<PrReviewComment> {
  if (!isTauri()) throw new Error("glMrCreateDiscussion requires Tauri");
  const raw = await tauriInvoke<Record<string, unknown>>("gl_mr_create_discussion", {
    cwd,
    iid,
    body,
    baseSha: opts.baseSha ?? "",
    startSha: opts.startSha ?? opts.baseSha ?? "",
    headSha: opts.headSha ?? "",
    oldLine: opts.oldLine ?? null,
    newLine: opts.newLine ?? null,
    path: opts.path ?? "",
  });
  // The Discussions API returns { id, notes: [{...}], ...}. Extract the first note.
  const notes = (raw.notes as Record<string, unknown>[] | undefined) ?? [];
  const note = notes[0] ?? raw;
  return glNoteToComment(note as Record<string, unknown>);
}

/** List file paths changed in a MR. */
export async function glMrFiles(cwd: string, iid: number): Promise<string[]> {
  if (!isTauri()) return [];
  return tauriInvoke<string[]>("gl_mr_files", { cwd, iid });
}
