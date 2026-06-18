import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import type { IssueDetail, IssueComment } from "../../utils/backend";

vi.mock("../../utils/backend", () => ({
  ghIssueDetail: vi.fn(),
  ghIssueComments: vi.fn(),
  ghIssueAddComment: vi.fn(),
  ghIssueSetState: vi.fn(),
}));

import {
  ghIssueDetail,
  ghIssueComments,
  ghIssueAddComment,
  ghIssueSetState,
} from "../../utils/backend";
import { useIssuePanel } from "../useIssuePanel";

const mDetail = vi.mocked(ghIssueDetail);
const mComments = vi.mocked(ghIssueComments);
const mAdd = vi.mocked(ghIssueAddComment);
const mState = vi.mocked(ghIssueSetState);

function detail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: 7,
    title: "Title",
    body: "Body",
    state: "open",
    author: "alice",
    assignees: [],
    labels: [],
    url: "https://github.com/org/repo/issues/7",
    createdAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-01T10:00:00Z",
    milestone: "",
    comments: 0,
    ...overrides,
  };
}

function comment(id: number): IssueComment {
  return { id, body: "c", author: "x", created_at: "", updated_at: "", url: "" };
}

describe("useIssuePanel", () => {
  beforeEach(() => {
    mDetail.mockReset();
    mComments.mockReset();
    mAdd.mockReset();
    mState.mockReset();
  });

  it("selectIssue loads detail + comments for the repo cwd", async () => {
    mDetail.mockResolvedValue(detail());
    mComments.mockResolvedValue([comment(1)]);
    const cwd = ref("/repo");
    const p = useIssuePanel(cwd);

    await p.selectIssue(7);

    expect(mDetail).toHaveBeenCalledWith("/repo", 7);
    expect(mComments).toHaveBeenCalledWith("/repo", 7);
    expect(p.detail.value?.number).toBe(7);
    expect(p.comments.value).toHaveLength(1);
    expect(p.isOpen.value).toBe(true);
    expect(p.loading.value).toBe(false);
  });

  it("isOpen is case-insensitive (gh CLI returns OPEN/CLOSED)", async () => {
    mDetail.mockResolvedValue(detail({ state: "CLOSED" }));
    mComments.mockResolvedValue([]);
    const p = useIssuePanel(ref("/repo"));
    await p.selectIssue(7);
    expect(p.isOpen.value).toBe(false);
  });

  it("addComment posts, appends optimistically and bumps the count", async () => {
    mDetail.mockResolvedValue(detail({ comments: 0 }));
    mComments.mockResolvedValue([]);
    mAdd.mockResolvedValue(comment(9));
    const p = useIssuePanel(ref("/repo"));
    await p.selectIssue(7);

    p.newComment.value = "hello";
    await p.addComment();

    expect(mAdd).toHaveBeenCalledWith("/repo", 7, "hello");
    expect(p.comments.value).toHaveLength(1);
    expect(p.detail.value?.comments).toBe(1);
    expect(p.newComment.value).toBe("");
  });

  it("addComment ignores an empty/whitespace body", async () => {
    mDetail.mockResolvedValue(detail());
    mComments.mockResolvedValue([]);
    const p = useIssuePanel(ref("/repo"));
    await p.selectIssue(7);

    p.newComment.value = "   ";
    await p.addComment();

    expect(mAdd).not.toHaveBeenCalled();
  });

  it("toggleState closes an open issue and flips state locally", async () => {
    mDetail.mockResolvedValue(detail({ state: "open" }));
    mComments.mockResolvedValue([]);
    mState.mockResolvedValue(undefined);
    const p = useIssuePanel(ref("/repo"));
    await p.selectIssue(7);

    await p.toggleState();

    expect(mState).toHaveBeenCalledWith("/repo", 7, "closed");
    expect(p.isOpen.value).toBe(false);
  });

  it("toggleState reopens a closed issue", async () => {
    mDetail.mockResolvedValue(detail({ state: "closed" }));
    mComments.mockResolvedValue([]);
    mState.mockResolvedValue(undefined);
    const p = useIssuePanel(ref("/repo"));
    await p.selectIssue(7);

    await p.toggleState();

    expect(mState).toHaveBeenCalledWith("/repo", 7, "open");
    expect(p.isOpen.value).toBe(true);
  });

  it("keeps the issue visible if comments fail to load", async () => {
    mDetail.mockResolvedValue(detail());
    mComments.mockRejectedValue(new Error("comments offline"));
    const p = useIssuePanel(ref("/repo"));
    await p.selectIssue(7);
    expect(p.detail.value?.number).toBe(7);
    expect(p.comments.value).toEqual([]);
    expect(p.error.value).toBeNull();
  });
});
