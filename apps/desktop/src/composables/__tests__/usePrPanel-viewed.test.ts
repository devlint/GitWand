/**
 * Task B2 (v3.6.0) — `usePrPanel` wiring for client-side viewed-file state:
 * seeding from the SWR cache on `selectPr`, toggling + persisting, forwarding
 * to `submitReview`, and resetting on a re-push (headSha change).
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

function fakeDetail(headSha: string) {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha,
  };
}

describe("usePrPanel — viewed-file state (B2)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail("sha1"));
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghPrSubmitReview.mockReset().mockResolvedValue({});
  });

  it("selecting a PR seeds viewedPaths from the cache at the current headSha", async () => {
    usePrCache().setViewed(detailKey("/repo", 1), "sha1", ["a.ts"]);
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    expect([...p.viewedPaths.value]).toEqual(["a.ts"]);
  });

  it("toggleViewed updates the count and persists to the cache", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    p.toggleViewed("a.ts");
    expect(p.viewedCount.value).toBe(1);
    expect(usePrCache().getViewed(detailKey("/repo", 1))?.paths).toEqual(["a.ts"]);
  });

  it("handleSubmitReview forwards viewedFiles to the forge", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    p.toggleViewed("a.ts");
    await p.handleSubmitReview({ event: "COMMENT", body: "", comments: [] });
    expect(ghPrSubmitReview).toHaveBeenCalledWith(
      "/repo", 1, expect.objectContaining({ viewedFiles: ["a.ts"] }),
    );
  });

  it("changing prDetail.headSha (re-push) resets viewed on next toggle", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    p.toggleViewed("a.ts");
    expect(p.viewedCount.value).toBe(1);

    // Simulate a re-push landing (revalidation picks up a new head SHA).
    ghPrDetail.mockResolvedValue(fakeDetail("sha2"));
    await p.revalidateOpenDetail();
    expect(p.viewedCount.value).toBe(0); // stale-headSha entry reads as empty

    p.toggleViewed("b.ts");
    expect([...p.viewedPaths.value]).toEqual(["b.ts"]);
  });
});
