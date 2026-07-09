/**
 * Task C4 (v3.6.0) — merged annotation stream (CI + AI) per file, and
 * dismissing a finding removes it from the stream and the filtered list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrComments = vi.fn();
const ghPrListReviews = vi.fn();
const ghCheckAnnotations = vi.fn();

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
    ghCheckAnnotations: (...a: unknown[]) => ghCheckAnnotations(...a),
  };
});

const settingsRef = ref<Record<string, unknown>>({
  reviewAiPreReview: false, reviewAiConfidenceThreshold: 0, reviewAiMaxFindings: 15,
});
vi.mock("../useSettings", () => ({ useSettings: () => ({ settings: settingsRef }) }));
vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({ isAvailable: ref(true), rawPrompt: vi.fn(async () => "[]") }),
}));

import { usePrPanel } from "../usePrPanel";
import { usePrCache, detailKey, _resetPrCacheForTesting } from "../usePrCache";

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 1, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "sha1",
  };
}

describe("usePrPanel — merged findings render (C4)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    // AI findings only ever render when pre-review is opted in — a cache
    // hit still respects that gate (see `maybeRunPreReview`).
    settingsRef.value = { reviewAiPreReview: true, reviewAiConfidenceThreshold: 0, reviewAiMaxFindings: 15 };
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghCheckAnnotations.mockReset().mockResolvedValue([
      { checkName: "lint", path: "a.ts", startLine: 2, endLine: 2, level: "warning", title: "ci finding", message: "" },
    ]);
  });

  it("merges CI annotations and cached AI findings for a file, distinct by source", async () => {
    usePrCache().setFindings(`${detailKey("/repo", 1)}@sha1`, [
      { id: "1", path: "a.ts", line: 3, side: "RIGHT", severity: "risk", confidence: 90, title: "ai finding", detail: "" },
    ]);
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await p.loadAnnotations();
    await new Promise((r) => setTimeout(r, 5)); // let the headSha watcher paint the cache hit

    const merged = p.mergedAnnotationsByFile.value["a.ts"];
    expect(merged.map((a) => a.source).sort()).toEqual(["ai", "ci"]);
  });

  it("dismissing a finding removes it from preReviewFindings", async () => {
    usePrCache().setFindings(`${detailKey("/repo", 1)}@sha1`, [
      { id: "1", path: "a.ts", line: 3, side: "RIGHT", severity: "risk", confidence: 90, title: "dismiss me", detail: "" },
    ]);
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await new Promise((r) => setTimeout(r, 5));
    expect(p.preReviewFindings.value).toHaveLength(1);

    p.dismissFinding("1");
    expect(p.preReviewFindings.value).toHaveLength(0);
  });
});
