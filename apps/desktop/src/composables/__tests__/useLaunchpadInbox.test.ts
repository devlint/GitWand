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

  it("classifies a review requested of me as { tier:'now', case:'review', action:'review' }", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: [ME] }), ME)).toEqual({
      tier: "now",
      case: "review",
      action: "review",
    });
  });

  it("ignores a review request on a draft PR", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: [ME], draft: true }), ME)).toBeNull();
  });

  it("ignores a PR where my review is not requested", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: ["bob"] }), ME)).toBeNull();
  });

  it("classifies my PR with changes requested as { tier:'now', case:'changes', action:'reply' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "CHANGES_REQUESTED" }), ME)).toEqual({
      tier: "now",
      case: "changes",
      action: "reply",
    });
  });

  it("classifies my PR with failing CI as { tier:'now', case:'ci', action:'seeFailure' }", () => {
    expect(classifyInboxPr(pr({ author: ME, checksRollup: "FAILURE" }), ME)).toEqual({
      tier: "now",
      case: "ci",
      action: "seeFailure",
    });
  });

  it("classifies my approved PR (CLEAN) as { tier:'now', case:'merge', action:'merge' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), ME)).toEqual({
      tier: "now",
      case: "merge",
      action: "merge",
    });
  });

  it("classifies my approved PR (DIRTY) as { tier:'now', case:'conflicts', action:'resolve' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "DIRTY" }), ME)).toEqual({
      tier: "now",
      case: "conflicts",
      action: "resolve",
    });
  });

  it("classifies my approved PR (BLOCKED) as { tier:'waiting', case:'blocked', action:'follow' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" }), ME)).toEqual({
      tier: "waiting",
      case: "blocked",
      action: "follow",
    });
  });

  it("classifies my PR with pending CI as { tier:'waiting', case:'ciRunning', action:'follow' }", () => {
    expect(classifyInboxPr(pr({ author: ME, checksRollup: "PENDING" }), ME)).toEqual({
      tier: "waiting",
      case: "ciRunning",
      action: "follow",
    });
  });

  it("classifies my PR awaiting others review as { tier:'waiting', case:'waiting', action:'follow' } (was null)", () => {
    // Previously this was null (no action). Now it goes into the waiting tier so
    // the user can see it's pending someone else's review. Intentional change.
    expect(
      classifyInboxPr(pr({ author: ME, reviewDecision: "REVIEW_REQUIRED", checksRollup: "SUCCESS" }), ME)
    ).toEqual({ tier: "waiting", case: "waiting", action: "follow" });
  });

  it("prioritises changes-requested over conflicts (DIRTY) on my own PR", () => {
    // CHANGES_REQUESTED wins over mergeStateStatus=DIRTY (same as the old
    // priority: changes > ci > merge ordering is preserved).
    const result = classifyInboxPr(
      pr({ author: ME, reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "DIRTY" }),
      ME
    );
    expect(result?.case).toBe("changes");
  });

  it("prioritises changes-requested over failing CI on my own PR", () => {
    const result = classifyInboxPr(
      pr({ author: ME, reviewDecision: "CHANGES_REQUESTED", checksRollup: "FAILURE" }),
      ME
    );
    expect(result?.case).toBe("changes");
  });

  it("classifies dependabot PR as { tier:'later', action:'autoMerge' }", () => {
    expect(
      classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", labels: ["dependencies"] }), ME)
    ).toEqual({ tier: "later", case: "merge", action: "autoMerge" });
  });

  it("classifies renovate[bot] author PR as { tier:'later', action:'autoMerge' }", () => {
    // Renovate bot PRs on my repos (author matches the bot heuristic)
    // are demoted to the later tier.
    expect(
      classifyInboxPr(pr({ author: "renovate[bot]", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), "renovate[bot]")
    ).toEqual({ tier: "later", case: "merge", action: "autoMerge" });
  });

  it("returns null for my PR that has nothing actionable (no review decision, no CI signal)", () => {
    // No reviewDecision, no checksRollup failure, not approved — nothing to do.
    expect(classifyInboxPr(pr({ author: ME }), ME)).toBeNull();
  });
});

describe("useLaunchpadInbox", () => {
  beforeEach(() => mockCurrentUser.mockReset());

  it("returns empty tiers before the user is loaded", () => {
    const prs = ref<PrWithRepo[]>([pr({ author: "alice", reviewRequested: ["laurent"] })]);
    const { tiers, totalCount } = useLaunchpadInbox(prs);
    expect(tiers.value).toEqual([]);
    expect(totalCount.value).toBe(0);
  });

  it("groups PRs into ordered tiers after loadUser", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"] }),          // now/review
      pr({ number: 2, author: "laurent", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), // now/merge
      pr({ number: 3, author: "laurent", reviewDecision: "CHANGES_REQUESTED" }), // now/changes
      pr({ number: 4, author: "bob", reviewRequested: ["carol"] }),              // not for me
      pr({ number: 5, author: "laurent", checksRollup: "PENDING" }),             // waiting/ciRunning
    ]);

    const { tiers, totalCount, nowCount, loadUser } = useLaunchpadInbox(prs);
    await loadUser();

    expect(totalCount.value).toBe(4);
    expect(nowCount.value).toBe(3);

    // Order: now, waiting (later is absent because no dep-bump PRs)
    expect(tiers.value.map((g) => g.tier)).toEqual(["now", "waiting"]);

    // Within "now", items follow allPrs ordering (review:1, changes:3, merge:2)
    const nowItems = tiers.value[0].items;
    // sorted by priority: review(1), changes(3), merge(2)
    const nowCases = nowItems.map((i) => i.classification.case);
    expect(nowCases).toContain("review");
    expect(nowCases).toContain("changes");
    expect(nowCases).toContain("merge");

    // Waiting tier has the pending-CI PR
    const waitingItems = tiers.value[1].items;
    expect(waitingItems[0].pr.number).toBe(5);
    expect(waitingItems[0].classification.case).toBe("ciRunning");
  });

  it("yields an empty inbox when no forge identity can be resolved", async () => {
    mockCurrentUser.mockResolvedValue("");
    const prs = ref<PrWithRepo[]>([pr({ author: "laurent", reviewDecision: "APPROVED" })]);
    const { tiers, loadUser, currentUser } = useLaunchpadInbox(prs);
    await loadUser();
    expect(currentUser.value).toBe("");
    expect(tiers.value).toEqual([]);
  });

  it("nowCount reports only 'now' tier items", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "laurent", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), // now/merge
      pr({ number: 2, author: "laurent", checksRollup: "PENDING" }),                               // waiting
    ]);
    const { nowCount, loadUser } = useLaunchpadInbox(prs);
    await loadUser();
    expect(nowCount.value).toBe(1);
  });

  it("conflicts case appears in the now tier with action resolve", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 7, author: "laurent", mergeStateStatus: "DIRTY" }),
    ]);
    const { tiers, loadUser } = useLaunchpadInbox(prs);
    await loadUser();
    expect(tiers.value[0]?.tier).toBe("now");
    expect(tiers.value[0]?.items[0].classification.case).toBe("conflicts");
    expect(tiers.value[0]?.items[0].classification.action).toBe("resolve");
  });
});
