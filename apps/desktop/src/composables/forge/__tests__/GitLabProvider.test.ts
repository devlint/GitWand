/**
 * GitLabProvider — B4 (v3.6.0): `dismissReview` is an honest unsupported
 * error (GitLab has no direct equivalent), `requestReviewers` is real.
 * F1 (v3.6.0): real inline batch review, `listReviews`, type-clean
 * `createComment`, and a real `getFileHistory` heuristic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const glRequestReviewers = vi.fn();
const glMrDiffRefs = vi.fn();
const glMrCreateDiscussion = vi.fn();
const glMrCreateNote = vi.fn();
const glApproveMr = vi.fn();
const glListReviews = vi.fn();
const glMrNotes = vi.fn();
const glGetMr = vi.fn();

vi.mock("../../../utils/backend", () => ({
  glRequestReviewers: (...a: unknown[]) => glRequestReviewers(...a),
  glMrDiffRefs: (...a: unknown[]) => glMrDiffRefs(...a),
  glMrCreateDiscussion: (...a: unknown[]) => glMrCreateDiscussion(...a),
  glMrCreateNote: (...a: unknown[]) => glMrCreateNote(...a),
  glApproveMr: (...a: unknown[]) => glApproveMr(...a),
  glListReviews: (...a: unknown[]) => glListReviews(...a),
  glMrNotes: (...a: unknown[]) => glMrNotes(...a),
  glGetMr: (...a: unknown[]) => glGetMr(...a),
}));

import { GitLabProvider } from "../GitLabProvider";
import { ForgeNotImplementedError } from "../types";

const REFS = { baseSha: "base1", startSha: "start1", headSha: "head1" };

function note(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 1, body: "hi", author: "alice", created_at: "2026-01-01", updated_at: "", path: "", line: null, original_line: null, side: "RIGHT", start_line: null, start_side: null, in_reply_to_id: null, diff_hunk: "", url: "", ...overrides };
}

describe("GitLabProvider — review admin (B4)", () => {
  beforeEach(() => {
    glRequestReviewers.mockReset().mockResolvedValue(undefined);
  });

  it("dismissReview throws a typed ForgeNotImplementedError", () => {
    const provider = new GitLabProvider();
    expect(() => provider.dismissReview()).toThrow(ForgeNotImplementedError);
  });

  it("requestReviewers delegates to glRequestReviewers", async () => {
    const provider = new GitLabProvider();
    await provider.requestReviewers("/repo", 5, ["alice", "bob"]);
    expect(glRequestReviewers).toHaveBeenCalledWith("/repo", 5, ["alice", "bob"]);
  });
});

describe("GitLabProvider — real review completion (F1)", () => {
  beforeEach(() => {
    glMrDiffRefs.mockReset().mockResolvedValue(REFS);
    glMrCreateDiscussion.mockReset().mockResolvedValue({ id: 1 });
    glMrCreateNote.mockReset().mockResolvedValue({ id: 2 });
    glApproveMr.mockReset().mockResolvedValue(undefined);
    glListReviews.mockReset().mockResolvedValue([]);
    glMrNotes.mockReset().mockResolvedValue([]);
    glGetMr.mockReset().mockResolvedValue({});
  });

  it("createComment fetches diff refs and anchors on the RIGHT side by default", async () => {
    const provider = new GitLabProvider();
    await provider.createComment("/repo", 5, { body: "nit", path: "a.ts", line: 3 });
    expect(glMrDiffRefs).toHaveBeenCalledWith("/repo", 5);
    expect(glMrCreateDiscussion).toHaveBeenCalledWith("/repo", 5, "nit", {
      baseSha: "base1", startSha: "start1", headSha: "head1", oldLine: null, newLine: 3, path: "a.ts",
    });
  });

  it("createComment anchors on the LEFT side when side is LEFT", async () => {
    const provider = new GitLabProvider();
    await provider.createComment("/repo", 5, { body: "nit", path: "a.ts", line: 3, side: "LEFT" });
    expect(glMrCreateDiscussion).toHaveBeenCalledWith("/repo", 5, "nit", expect.objectContaining({ oldLine: 3, newLine: null }));
  });

  it("submitReview with comments fetches refs once and posts each as a discussion", async () => {
    const provider = new GitLabProvider();
    await provider.submitReview("/repo", 5, {
      event: "COMMENT",
      body: "",
      comments: [
        { path: "a.ts", line: 1, side: "RIGHT", body: "c1" },
        { path: "b.ts", line: 2, side: "LEFT", body: "c2" },
      ],
    });
    expect(glMrDiffRefs).toHaveBeenCalledTimes(1);
    expect(glMrCreateDiscussion).toHaveBeenCalledTimes(2);
    expect(glMrCreateDiscussion).toHaveBeenCalledWith("/repo", 5, "c1", expect.objectContaining({ newLine: 1, oldLine: null }));
    expect(glMrCreateDiscussion).toHaveBeenCalledWith("/repo", 5, "c2", expect.objectContaining({ newLine: null, oldLine: 2 }));
  });

  it("submitReview REQUEST_CHANGES writes a marked note listReviews can derive from", async () => {
    const provider = new GitLabProvider();
    const review = await provider.submitReview("/repo", 5, { event: "REQUEST_CHANGES", body: "please fix", comments: [] });
    expect(review.state).toBe("CHANGES_REQUESTED");
    expect(glMrCreateNote).toHaveBeenCalledWith("/repo", 5, expect.stringContaining("please fix"));
  });

  it("listReviews merges approvals with a note-derived CHANGES_REQUESTED verdict", async () => {
    glListReviews.mockResolvedValue([{ id: 0, state: "APPROVED", body: "", user: { login: "bob", avatar_url: "" }, submitted_at: "", html_url: "" }]);
    glMrNotes.mockResolvedValue([note({ id: 10, body: "**Changes requested:**\n\nfix it", author: "carol" })]);
    const provider = new GitLabProvider();
    const reviews = await provider.listReviews("/repo", 5);
    expect(reviews).toHaveLength(2);
    expect(reviews.some((r) => r.state === "APPROVED")).toBe(true);
    const derived = reviews.find((r) => r.state === "CHANGES_REQUESTED");
    expect(derived?.body).toBe("fix it");
    expect(derived?.user.login).toBe("carol");
  });

  it("getFileHistory counts notes per path after a PR has been loaded via getPR", async () => {
    glGetMr.mockResolvedValue({ number: 5 });
    glMrNotes.mockResolvedValue([
      note({ id: 1, path: "a.ts", author: "alice", body: "note1" }),
      note({ id: 2, path: "a.ts", author: "bob", body: "note2" }),
      note({ id: 3, path: "b.ts", author: "carol", body: "note3" }),
    ]);
    const provider = new GitLabProvider();
    await provider.getPR("/repo", 5); // sets _lastIid
    const history = await provider.getFileHistory("/repo", ["a.ts", "b.ts", "c.ts"]);
    expect(history["a.ts"].reviewCommentCount).toBe(2);
    expect(history["a.ts"].reviewers.sort()).toEqual(["alice", "bob"]);
    expect(history["b.ts"].reviewCommentCount).toBe(1);
    expect(history["c.ts"].reviewCommentCount).toBe(0);
  });

  it("getFileHistory returns empty placeholders before any PR has loaded", async () => {
    const provider = new GitLabProvider();
    const history = await provider.getFileHistory("/repo", ["a.ts"]);
    expect(history["a.ts"]).toEqual({ reviewCommentCount: 0, reviewers: [], lastComment: null });
    expect(glMrNotes).not.toHaveBeenCalled();
  });
});
