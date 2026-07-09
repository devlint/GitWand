/**
 * Task B4 (v3.6.0) — dismiss review + request reviewers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const ghPrListReviews = vi.fn();
const ghDismissReview = vi.fn();
const ghRequestReviewers = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
    ghDismissReview: (...a: unknown[]) => ghDismissReview(...a),
    ghRequestReviewers: (...a: unknown[]) => ghRequestReviewers(...a),
  };
});

import { usePrPanel } from "../usePrPanel";
import { ForgeNotImplementedError } from "../forge/types";

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "sha1",
  };
}

describe("usePrPanel — dismiss review / request reviewers (B4)", () => {
  beforeEach(() => {
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghDismissReview.mockReset().mockResolvedValue(undefined);
    ghRequestReviewers.mockReset().mockResolvedValue(undefined);
  });

  it("forgeSupportsDismissReview / forgeSupportsRequestReviewers are true on GitHub", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    expect(p.forgeSupportsDismissReview.value).toBe(true);
    expect(p.forgeSupportsRequestReviewers.value).toBe(true);
  });

  it("handleRequestReviewers calls the forge and refreshes the detail", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    ghPrDetail.mockResolvedValue({ ...fakeDetail(), reviewers: ["alice"] });
    await p.handleRequestReviewers(["alice"]);
    expect(ghRequestReviewers).toHaveBeenCalledWith("/repo", 1, ["alice"]);
    expect(p.prDetail.value?.reviewers).toEqual(["alice"]);
  });

  it("handleRequestReviewers is a no-op with an empty login list", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await p.handleRequestReviewers([]);
    expect(ghRequestReviewers).not.toHaveBeenCalled();
  });

  it("handleDismissReview calls the forge and refreshes reviews", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    ghPrListReviews.mockResolvedValue([{ id: 1, state: "DISMISSED" }]);
    await p.handleDismissReview(7);
    expect(ghDismissReview).toHaveBeenCalledWith("/repo", 1, 7, undefined);
    expect(p.prReviews.value).toEqual([{ id: 1, state: "DISMISSED" }]);
  });

  it("a ForgeNotImplementedError from dismissReview does not set `error`", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    ghDismissReview.mockRejectedValue(new ForgeNotImplementedError("gitlab", "dismissReview"));
    await p.handleDismissReview(7);
    expect(p.error.value).toBeNull();
  });
});
