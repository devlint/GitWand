/**
 * Task C3 (v3.6.0) — `usePrPanel` orchestration of the pre-review pass:
 * opt-in, cache-first, cancellable on PR switch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const ghPrListReviews = vi.fn();
const ghPrDiff = vi.fn();
const getGitBlame = vi.fn();
const rawPromptMock = vi.fn();
const isAvailableRef = { value: true };

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
    ghPrDiff: (...a: unknown[]) => ghPrDiff(...a),
    getGitBlame: (...a: unknown[]) => getGitBlame(...a),
  };
});

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: isAvailableRef,
    rawPrompt: (...a: unknown[]) => rawPromptMock(...a),
  }),
}));

// Isolate settings from the real localStorage-backed singleton so each test
// controls `reviewAiPreReview` independently.
const settingsRef = ref<Record<string, unknown>>({
  reviewAiPreReview: false,
  reviewAiConfidenceThreshold: 60,
  reviewAiMaxFindings: 15,
});
vi.mock("../useSettings", () => ({
  useSettings: () => ({ settings: settingsRef }),
}));

import { usePrPanel } from "../usePrPanel";
import { usePrCache, detailKey, _resetPrCacheForTesting } from "../usePrCache";

const RAW_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,1 +1,2 @@",
  " context",
  "+new line",
].join("\n");

function fakeDetail(headSha: string) {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 1, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha,
  };
}

describe("usePrPanel — pre-review orchestration (C3)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    settingsRef.value = { reviewAiPreReview: false, reviewAiConfidenceThreshold: 60, reviewAiMaxFindings: 15 };
    isAvailableRef.value = true;
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail("sha1"));
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghPrDiff.mockReset().mockResolvedValue(RAW_DIFF);
    getGitBlame.mockReset().mockResolvedValue([]);
    rawPromptMock.mockReset().mockResolvedValue('[{"line": 1, "title": "f", "confidence": 90}]');
  });

  it("disabled setting: zero rawPrompt calls", async () => {
    settingsRef.value.reviewAiPreReview = false;
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 5));
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(p.preReviewFindings.value).toEqual([]);
  });

  it("enabled + cache hit: zero compute, findings painted instantly", async () => {
    settingsRef.value.reviewAiPreReview = true;
    usePrCache().setFindings(`${detailKey("/repo", 1)}@sha1`, [
      { id: "1", path: "a.ts", line: 1, side: "RIGHT", severity: "risk", confidence: 95, title: "cached", detail: "" },
    ]);
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 5));
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(p.preReviewFindings.value.map((f) => f.title)).toEqual(["cached"]);
  });

  it("enabled + miss: runs and populates findings", async () => {
    settingsRef.value.reviewAiPreReview = true;
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(rawPromptMock).toHaveBeenCalledTimes(1);
    expect(p.preReviewFindings.value.map((f) => f.title)).toEqual(["f"]);
    // Now cached for next time.
    expect(usePrCache().getFindings(`${detailKey("/repo", 1)}@sha1`)?.length).toBe(1);
  });

  it("PR switch aborts the in-flight run", async () => {
    settingsRef.value.reviewAiPreReview = true;
    let resolveRawPrompt: (v: string) => void = () => {};
    rawPromptMock.mockImplementation(() => new Promise((resolve) => { resolveRawPrompt = resolve; }));
    ghPrDetail.mockImplementation(async (_cwd: string, n: number) => fakeDetail(n === 1 ? "sha1" : "sha2"));

    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 5)); // let the queue start, blocked on rawPrompt

    await p.selectPr({ number: 2 } as any);
    resolveRawPrompt('[{"line": 1, "title": "stale", "confidence": 90}]');
    await new Promise((r) => setTimeout(r, 10));

    // The stale finding from PR 1's aborted run must never reach PR 2's state.
    expect(p.preReviewFindings.value.map((f) => f.title)).not.toContain("stale");
    expect(usePrCache().getFindings(`${detailKey("/repo", 1)}@sha1`)).toBeNull();
  });
});
