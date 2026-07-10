/**
 * Task B3 (v3.6.0) — pending review draft persists across detail close/
 * reopen and PR switches, and clears on successful submit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const ghPrListReviews = vi.fn();
const ghPrSubmitReview = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
    ghPrSubmitReview: (...a: unknown[]) => ghPrSubmitReview(...a),
  };
});

import { usePrPanel } from "../usePrPanel";
import { usePrCache, detailKey, _resetPrCacheForTesting } from "../usePrCache";

function fakeDetail(n: number) {
  return {
    number: n, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "sha1",
  };
}

describe("usePrPanel — pending review draft (B3)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    ghPrDetail.mockReset().mockImplementation(async (_cwd: string, n: number) => fakeDetail(n));
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghPrSubmitReview.mockReset().mockResolvedValue({});
  });

  it("handleAddToReview persists the draft to the cache", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    p.handleAddToReview({ path: "a.ts", line: 1, side: "RIGHT", body: "nit" });
    expect(p.draftCount.value).toBe(1);
    expect(usePrCache().getDraft(detailKey("/repo", 1))?.length).toBe(1);
  });

  it("selectPr restores the draft for the same PR from the cache", async () => {
    usePrCache().setDraft(detailKey("/repo", 1), [{ path: "a.ts", line: 1, side: "RIGHT", body: "nit" }]);
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    expect(p.draftReviewComments.value.length).toBe(1);
  });

  it("handleSubmitReview clears the draft on success", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    p.handleAddToReview({ path: "a.ts", line: 1, side: "RIGHT", body: "nit" });
    await p.handleSubmitReview({ event: "COMMENT", body: "", comments: p.draftReviewComments.value });
    expect(p.draftCount.value).toBe(0);
    expect(usePrCache().getDraft(detailKey("/repo", 1))).toBeNull();
  });

  it("switching PRs isolates drafts by key", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    p.handleAddToReview({ path: "a.ts", line: 1, side: "RIGHT", body: "nit" });

    await p.selectPr({ number: 2 } as any);
    expect(p.draftCount.value).toBe(0); // PR 2 has no draft

    await p.selectPr({ number: 1 } as any);
    expect(p.draftCount.value).toBe(1); // PR 1's draft survived the round trip
  });
});
