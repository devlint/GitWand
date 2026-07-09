/**
 * Task E1 (v3.6.0) — `lineAnnotationsByFile` converts CI annotations onto
 * the shared `LineAnnotation` model at the `usePrPanel` boundary, without
 * changing `annotationsByFile`'s existing CIAnnotation[] shape (still used
 * for the file-sidebar badge count).
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

import { usePrPanel } from "../usePrPanel";

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "sha1",
  };
}

describe("usePrPanel — lineAnnotationsByFile (E1)", () => {
  beforeEach(() => {
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    ghCheckAnnotations.mockReset().mockResolvedValue([
      { checkName: "lint", path: "a.ts", startLine: 3, endLine: 3, level: "warning", title: "unused", message: "" },
    ]);
  });

  it("converts CI annotations to LineAnnotation[] keyed by path", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await p.loadAnnotations();
    expect(p.lineAnnotationsByFile.value["a.ts"]).toEqual([
      { source: "ci", path: "a.ts", line: 3, side: "RIGHT", endLine: 3, severity: "warning", title: "unused", message: "", checkName: "lint" },
    ]);
    // The original CIAnnotation[]-shaped map is untouched (still used for badges).
    expect(p.annotationsByFile.value["a.ts"]).toEqual([
      { checkName: "lint", path: "a.ts", startLine: 3, endLine: 3, level: "warning", title: "unused", message: "" },
    ]);
  });
});
