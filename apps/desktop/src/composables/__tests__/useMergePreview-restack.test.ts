import { describe, it, expect, vi, beforeEach } from "vitest";

const previewRestack = vi.fn(async (..._a: unknown[]) => [
  { file_path: "a.ts", conflict_content: "", has_conflicts: false, is_add_delete: false },
]);

vi.mock("../../utils/backend", () => ({
  previewMerge: vi.fn(),
  previewRebase: vi.fn(),
  previewCherryPick: vi.fn(),
  previewRestack: (...a: unknown[]) => previewRestack(...a),
  readGitwandrc: async () => "",
  gitRepoState: async () => ({ state: "clean", targetBranch: null }),
}));

import { useMergePreview } from "../useMergePreview";

beforeEach(() => previewRestack.mockClear());

describe("useMergePreview — computeRestackPreview", () => {
  it("passes onto/upstream/branch and labels the summary", async () => {
    const p = useMergePreview(() => "/repo");
    await p.computeRestackPreview({ onto: "o", upstream: "u", branch: "step-3", label: "step-2…step-3 → step-1" });
    expect(previewRestack).toHaveBeenCalledWith("/repo", "o", "u", "step-3");
    expect(p.summary.value?.sourceBranch).toBe("step-2…step-3 → step-1");
    expect(p.summary.value?.cleanFiles).toBe(1);
  });

  it("surfaces a backend failure as error and no summary", async () => {
    previewRestack.mockRejectedValueOnce(new Error("boom"));
    const p = useMergePreview(() => "/repo");
    await p.computeRestackPreview({ onto: "o", upstream: "u", branch: "b", label: "l" });
    expect(p.error.value).toBe("boom");
    expect(p.summary.value).toBeNull();
  });
});
