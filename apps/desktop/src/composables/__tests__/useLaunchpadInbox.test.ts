import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import type { PrWithRepo } from "../useLaunchpadPrs";
import type { IssueWithRepo } from "../useLaunchpadIssues";

vi.mock("../../utils/backend", () => ({
  ghCurrentUser: vi.fn(),
}));

import { ghCurrentUser } from "../../utils/backend";
import {
  useLaunchpadInbox,
  classifyInboxPr,
  classifyIssue,
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

/** Minimal issue factory. */
function issue(overrides: Partial<IssueWithRepo>): IssueWithRepo {
  return {
    number: 100,
    title: "Issue",
    state: "OPEN",
    author: "someone",
    assignees: [],
    labels: [],
    url: "https://github.com/org/repo/issues/100",
    createdAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-01T10:00:00Z",
    milestone: "",
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

  it("classifies a review requested of me as { tier:'now', case:'review', action:'review', kind:'pr' }", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: [ME] }), ME)).toEqual({
      tier: "now",
      case: "review",
      action: "review",
      kind: "pr",
    });
  });

  it("ignores a review request on a draft PR", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: [ME], draft: true }), ME)).toBeNull();
  });

  it("ignores a PR where my review is not requested", () => {
    expect(classifyInboxPr(pr({ author: "alice", reviewRequested: ["bob"] }), ME)).toBeNull();
  });

  it("classifies my PR with changes requested as { tier:'now', case:'changes', action:'reply', kind:'pr' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "CHANGES_REQUESTED" }), ME)).toEqual({
      tier: "now",
      case: "changes",
      action: "reply",
      kind: "pr",
    });
  });

  it("classifies my PR with failing CI as { tier:'now', case:'ci', action:'seeFailure', kind:'pr' }", () => {
    expect(classifyInboxPr(pr({ author: ME, checksRollup: "FAILURE" }), ME)).toEqual({
      tier: "now",
      case: "ci",
      action: "seeFailure",
      kind: "pr",
    });
  });

  it("classifies my approved PR (CLEAN) as { tier:'now', case:'merge', action:'merge', kind:'pr' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), ME)).toEqual({
      tier: "now",
      case: "merge",
      action: "merge",
      kind: "pr",
    });
  });

  it("classifies my approved PR (DIRTY) as { tier:'now', case:'conflicts', action:'resolve', kind:'pr' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "DIRTY" }), ME)).toEqual({
      tier: "now",
      case: "conflicts",
      action: "resolve",
      kind: "pr",
    });
  });

  it("classifies DIRTY PR (no reviewDecision) as conflicts", () => {
    // mergeStateStatus DIRTY wins even without an explicit reviewDecision
    expect(classifyInboxPr(pr({ author: ME, mergeStateStatus: "DIRTY" }), ME)).toEqual({
      tier: "now",
      case: "conflicts",
      action: "resolve",
      kind: "pr",
    });
  });

  it("classifies my approved PR (BLOCKED) as { tier:'waiting', case:'blocked', action:'follow', kind:'pr' }", () => {
    expect(classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" }), ME)).toEqual({
      tier: "waiting",
      case: "blocked",
      action: "follow",
      kind: "pr",
    });
  });

  it("classifies my PR with pending CI as { tier:'waiting', case:'ciRunning', action:'follow', kind:'pr' }", () => {
    expect(classifyInboxPr(pr({ author: ME, checksRollup: "PENDING" }), ME)).toEqual({
      tier: "waiting",
      case: "ciRunning",
      action: "follow",
      kind: "pr",
    });
  });

  it("classifies my PR awaiting others review as { tier:'waiting', case:'waiting', action:'follow', kind:'pr' } (was null)", () => {
    // Previously this was null (no action). Now it goes into the waiting tier so
    // the user can see it's pending someone else's review. Intentional change.
    expect(
      classifyInboxPr(pr({ author: ME, reviewDecision: "REVIEW_REQUIRED", checksRollup: "SUCCESS" }), ME)
    ).toEqual({ tier: "waiting", case: "waiting", action: "follow", kind: "pr" });
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

  it("classifies dependabot-labelled PR as { tier:'later', kind:'dep', action:'autoMerge' }", () => {
    expect(
      classifyInboxPr(pr({ author: ME, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", labels: ["dependencies"] }), ME)
    ).toEqual({ tier: "later", case: "merge", action: "autoMerge", kind: "dep" });
  });

  it("classifies renovate[bot] author PR (review requested of me) as { tier:'later', kind:'dep', action:'autoMerge' }", () => {
    // Renovate bot PRs where my review is requested are classified as dep bumps
    // regardless of author — the dep check fires before the isMine gate.
    expect(
      classifyInboxPr(pr({ author: "renovate[bot]", reviewRequested: [ME], reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), ME)
    ).toEqual({ tier: "later", case: "merge", action: "autoMerge", kind: "dep" });
  });

  it("returns null for a bot dep-bump PR where neither I'm the author nor my review is requested", () => {
    // A renovate PR on someone else's repo that has nothing to do with me stays out of inbox.
    expect(
      classifyInboxPr(pr({ author: "renovate[bot]", reviewRequested: ["alice"], labels: ["dependencies"] }), ME)
    ).toBeNull();
  });

  it("returns null for my PR that has nothing actionable (no review decision, no CI signal)", () => {
    // No reviewDecision, no checksRollup failure, not approved — nothing to do.
    expect(classifyInboxPr(pr({ author: ME }), ME)).toBeNull();
  });
});

describe("classifyIssue", () => {
  it("classifies any issue as { tier:'now', case:'issue', action:'view', kind:'issue' }", () => {
    expect(classifyIssue(issue({ repoName: "repo" }))).toEqual({
      tier: "now",
      case: "issue",
      action: "view",
      kind: "issue",
    });
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
    expect(waitingItems[0].pr?.number).toBe(5);
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

  // ─── Phase 2: filter chip counts ─────────────────────────────────────────

  it("filterCounts returns correct per-filter counts from a mixed PR set", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      // review — someone else's PR, my review requested
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"] }),
      // mine (approved, clean)
      pr({ number: 2, author: "laurent", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }),
      // dep (dependabot label on my PR)
      pr({ number: 3, author: "laurent", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", labels: ["dependencies"] }),
    ]);
    const issues = ref<IssueWithRepo[]>([
      issue({ number: 10 }),
    ]);

    const { filterCounts, loadUser } = useLaunchpadInbox(prs, issues);
    await loadUser();

    expect(filterCounts.value.all).toBe(4);   // 1 review + 1 mine + 1 dep + 1 issue
    expect(filterCounts.value.review).toBe(1); // only the review-requested one
    expect(filterCounts.value.mine).toBe(1);   // approved clean PR (dep excluded from mine)
    expect(filterCounts.value.deps).toBe(1);   // the dependabot PR
    expect(filterCounts.value.issues).toBe(1); // the issue
  });

  // ─── Phase 2: groupedItems ────────────────────────────────────────────────

  it("groupedItems('priority', 'all') yields priority-tier groups", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"] }),         // now
      pr({ number: 2, author: "laurent", checksRollup: "PENDING" }),             // waiting
    ]);
    const { groupedItems, loadUser } = useLaunchpadInbox(prs);
    await loadUser();

    const groups = groupedItems("priority", "all");
    expect(groups.map((g) => g.key)).toEqual(["tier:now", "tier:waiting"]);
    expect(groups[0].count).toBe(1);
    expect(groups[1].count).toBe(1);
  });

  it("groupedItems('repo', 'all') groups items by repoName", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"], repoName: "alpha", repoPath: "/alpha" }),
      pr({ number: 2, author: "alice", reviewRequested: ["laurent"], repoName: "beta", repoPath: "/beta" }),
      pr({ number: 3, author: "alice", reviewRequested: ["laurent"], repoName: "alpha", repoPath: "/alpha" }),
    ]);
    const { groupedItems, loadUser } = useLaunchpadInbox(prs);
    await loadUser();

    const groups = groupedItems("repo", "all");
    const alphaGroup = groups.find((g) => g.key === "repo:alpha");
    const betaGroup = groups.find((g) => g.key === "repo:beta");
    expect(alphaGroup?.count).toBe(2);
    expect(betaGroup?.count).toBe(1);
  });

  it("groupedItems('type', 'all') yields pr / issue / dep type groups", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"] }),          // kind:pr
      pr({ number: 2, author: "laurent", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", labels: ["dependencies"] }), // kind:dep
    ]);
    const issues = ref<IssueWithRepo[]>([
      issue({ number: 10 }),
    ]);
    const { groupedItems, loadUser } = useLaunchpadInbox(prs, issues);
    await loadUser();

    const groups = groupedItems("type", "all");
    const prGroup = groups.find((g) => g.key === "type:pr");
    const issueGroup = groups.find((g) => g.key === "type:issue");
    const depGroup = groups.find((g) => g.key === "type:dep");
    expect(prGroup?.count).toBe(1);
    expect(issueGroup?.count).toBe(1);
    expect(depGroup?.count).toBe(1);
  });

  it("groupedItems('priority', 'review') filters to review-only items", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"] }),          // case:review
      pr({ number: 2, author: "laurent", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), // case:merge
    ]);
    const { groupedItems, loadUser } = useLaunchpadInbox(prs);
    await loadUser();

    const groups = groupedItems("priority", "review");
    const totalItems = groups.reduce((n, g) => n + g.count, 0);
    expect(totalItems).toBe(1);
    expect(groups[0].items[0].classification.case).toBe("review");
  });

  it("issues count is 0 when no allIssues ref is provided", async () => {
    mockCurrentUser.mockResolvedValue("laurent");
    const prs = ref<PrWithRepo[]>([
      pr({ number: 1, author: "alice", reviewRequested: ["laurent"] }),
    ]);
    const { filterCounts, loadUser } = useLaunchpadInbox(prs);
    await loadUser();
    expect(filterCounts.value.issues).toBe(0);
  });
});
