import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import type { PrWithRepo } from "../useLaunchpadPrs";

vi.mock("../../utils/backend", () => ({
  ghCurrentUser: vi.fn(),
}));

import { ghCurrentUser } from "../../utils/backend";
import {
  useLaunchpadInbox,
  classifyInboxPr,
} from "../useLaunchpadInbox";

const mockCurrentUser = vi.mocked(ghCurrentUser);

/** Minimal PR factory — only the fields the inbox classifier reads matter. */
function pr(overrides: Partial<PrWithRepo>): PrWithRepo {
  return {
    number: 1,
    title: "PR",
    state: "OPEN",
    author: "someone",
    branch: "feat/x",
    base: "main",
    draft: false,
    createdAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-01T10:00:00Z",
    url: "https://github.com/org/repo/pull/1",
    additions: 0,
    deletions: 0,
    labels: [],
    assignees: [],
    reviewRequested: [],
    reviewDecision: "",
    mergeStateStatus: "CLEAN",
    checksRollup: "",
    commentCount: 0,
    repoName: "repo",
    repoPath: "/repo",
    ...overrides,
  };
}

describe("classifyInboxPr", () => {
  const ME = "laurent";

  it("returns null when the current user is unknown", () => {
    expect(classifyInboxPr(pr({ reviewRequested: [ME] }), "")).toBeNull();
  });

  it("classifies a review requested of me as 'review'", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: [ME] }), ME)).toBe("review");
  });

  it("ignores a review request on a draft PR", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: [ME], draft: true }), ME)).toBeNull();
  });

  it("ignores a PR where my review is not requested", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: ["bob"] }), ME)).toBeNull();
  });

  it("classifies my PR with changes requested as 'changes'", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "CHANGES_REQUESTED" }), ME)).toBe("changes");
  });

  it("classifies my PR with failing CI as 'ci'", () => {
    expect(classifyInboxPr(pr({ author: ME, checksRollup: "FAILURE" }), ME)).toBe("ci");
  });

  it("classifies my approved PR as 'merge'", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED" }), ME)).toBe("merge");
  });

  it("prioritises changes-requested over failing CI on my own PR", () => {
    expect(
      classifyInboxPr(pr({ author: ME, reviewDecision: "CHANGES_REQUESTED", checksRollup: "FAILURE" }), ME)
    ).toBe("changes");
  });

  it("returns null for my PR that needs nothing", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "REVIEW_REQUIRED", checksRollup: "SUCCESS" }), ME)).toBeNull();
  });
});

describe("useLaunchpadInbox", () => {
  beforeEach(() => mockCurrentUser.mockReset());

  it("returns no buckets before the user is loaded", () => {
    const prs = ref<PrWithRepo[]>([pr({ author: "alice", reviewRequested: ["laurent"] })]);
    const { buckets, totalCount } = useLaunchpadInbox(prs);
    expect(buckets.value).toEqual([]);
    expect(totalCount.value).toBe(0);
  });

  it("groups PRs into ordered, non-empty buckets after loadUser", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"] }),
      pr({ number: 2, author: "laurent", reviewDecision: "APPROVED" }),
      pr({ number: 3, author: "laurent", reviewDecision: "CHANGES_REQUESTED" }),
      pr({ number: 4, author: "bob", reviewRequested: ["carol"] }), // not mine, not for me
    ]);

    const { buckets, totalCount, loadUser } = useLaunchpadInbox(prs);
    await loadUser();

    expect(totalCount.value).toBe(3);
    // Order follows INBOX_BUCKET_ORDER: review, changes, (ci), merge
    expect(buckets.value.map((b) => b.key)).toEqual(["review", "changes", "merge"]);
    expect(buckets.value[0].prs[0].number).toBe(1);
    expect(buckets.value[1].prs[0].number).toBe(3);
    expect(buckets.value[2].prs[0].number).toBe(2);
  });

  it("yields an empty inbox when no forge identity can be resolved", async () => {
    // gh not authenticated / offline → ghCurrentUser resolves empty; the inbox
    // must stay empty rather than mis-classifying PRs against a blank user.
    mockCurrentUser.mockResolvedValue("");
    const prs = ref<PrWithRepo[]>([pr({ author: "laurent", reviewDecision: "APPROVED" })]);
    const { buckets, loadUser, currentUser } = useLaunchpadInbox(prs);
    await loadUser();
    expect(currentUser.value).toBe("");
    expect(buckets.value).toEqual([]);
  });
});
