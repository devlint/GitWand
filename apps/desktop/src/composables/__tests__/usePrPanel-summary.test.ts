/**
 * Task D1 (v3.6.0) — `usePrPanel` orchestration of the PR summary: opt-in,
 * cache-first, regenerate bypasses the cache.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const ghPrListReviews = vi.fn();
const ghPrDiff = vi.fn();
const gitExecMock = vi.fn();
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
    gitExec: (...a: unknown[]) => gitExecMock(...a),
  };
});

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({ isAvailable: isAvailableRef, rawPrompt: (...a: unknown[]) => rawPromptMock(...a) }),
}));

const settingsRef = ref<Record<string, unknown>>({ reviewAiSummary: false, reviewAiPreReview: false });
vi.mock("../useSettings", () => ({ useSettings: () => ({ settings: settingsRef }) }));

import { usePrPanel } from "../usePrPanel";
import { usePrCache, detailKey, _resetPrCacheForTesting } from "../usePrCache";

const RAW_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,1 +1,1 @@",
  "+x",
].join("\n");

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "feat", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 1, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "sha1",
  };
}

describe("usePrPanel — PR summary orchestration (D1)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    settingsRef.value = { reviewAiSummary: false, reviewAiPreReview: false };
    isAvailableRef.value = true;
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghPrDiff.mockReset().mockResolvedValue(RAW_DIFF);
    gitExecMock.mockReset().mockResolvedValue({ stdout: "fix: bug", stderr: "", exitCode: 0 });
    rawPromptMock.mockReset().mockResolvedValue("What: x. Why: y. Affected areas: a.ts.");
  });

  it("disabled: no call, prSummary stays empty", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 5));
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(p.prSummary.value).toBe("");
  });

  it("enabled + cache hit: no call, instant paint", async () => {
    settingsRef.value.reviewAiSummary = true;
    usePrCache().setSummary(`${detailKey("/repo", 1)}@sha1`, "cached summary");
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 5));
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(p.prSummary.value).toBe("cached summary");
  });

  it("enabled + miss: generates and writes through to the cache", async () => {
    settingsRef.value.reviewAiSummary = true;
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 10));
    expect(rawPromptMock).toHaveBeenCalledTimes(1);
    expect(p.prSummary.value).toContain("What: x.");
    expect(usePrCache().getSummary(`${detailKey("/repo", 1)}@sha1`)).toContain("What: x.");
  });

  it("regenerateSummary bypasses the cache and rewrites it", async () => {
    settingsRef.value.reviewAiSummary = true;
    usePrCache().setSummary(`${detailKey("/repo", 1)}@sha1`, "stale summary");
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 5));
    expect(p.prSummary.value).toBe("stale summary");
    expect(rawPromptMock).not.toHaveBeenCalled();

    await p.regenerateSummary();
    expect(rawPromptMock).toHaveBeenCalledTimes(1);
    expect(p.prSummary.value).toContain("What: x.");
    expect(usePrCache().getSummary(`${detailKey("/repo", 1)}@sha1`)).toContain("What: x.");
  });
});
