/**
 * Task A3 (v3.6.0) — slim detail revalidation to the 3 hot-path calls
 * (`getPR` + `listComments` + `listReviews`). `getCIChecks` defers to the
 * Checks/Diff tab, `gitFileCount` to the Intelligence tab, `listIssueComments`
 * to the Info tab.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const ghPrDetail = vi.fn();
const ghPrChecks = vi.fn();
const ghPrComments = vi.fn();
const ghPrIssueComments = vi.fn();
const ghPrListReviews = vi.fn();
const gitFileCount = vi.fn();
const ghPrDiff = vi.fn(async (..._args: unknown[]) => "");

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDetail: (...a: unknown[]) => ghPrDetail(...a),
    ghPrChecks: (...a: unknown[]) => ghPrChecks(...a),
    ghPrComments: (...a: unknown[]) => ghPrComments(...a),
    ghPrIssueComments: (...a: unknown[]) => ghPrIssueComments(...a),
    ghPrListReviews: (...a: unknown[]) => ghPrListReviews(...a),
    gitFileCount: (...a: unknown[]) => gitFileCount(...a),
    ghPrDiff: (...a: unknown[]) => ghPrDiff(...a),
  };
});

import { usePrPanel } from "../usePrPanel";

function fakeDetail() {
  return {
    number: 1, title: "t", body: "", state: "open", author: "a", branch: "b", base: "main",
    draft: false, createdAt: "", updatedAt: "", mergedAt: "", url: "", additions: 0, deletions: 0,
    changedFiles: 0, comments: 0, reviewComments: 0, labels: [], reviewers: [], mergeable: "MERGEABLE",
    checksStatus: "success", canMerge: true, headSha: "abc",
  };
}

describe("usePrPanel — slim detail revalidation (A3)", () => {
  beforeEach(() => {
    ghPrDetail.mockReset().mockResolvedValue(fakeDetail());
    ghPrChecks.mockReset().mockResolvedValue([]);
    ghPrComments.mockReset().mockResolvedValue([]);
    ghPrIssueComments.mockReset().mockResolvedValue([]);
    ghPrListReviews.mockReset().mockResolvedValue([]);
    gitFileCount.mockReset().mockResolvedValue(0);
  });

  it("selectPr issues the 3 hot-path calls, not checks/fileCount", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);

    expect(ghPrDetail).toHaveBeenCalledTimes(1);
    expect(ghPrComments).toHaveBeenCalledTimes(1);
    expect(ghPrListReviews).toHaveBeenCalledTimes(1);
    expect(ghPrChecks).not.toHaveBeenCalled();
    expect(gitFileCount).not.toHaveBeenCalled();
  });

  it("selecting a PR on the info tab loads its issue comments", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await Promise.resolve();
    expect(p.detailTab.value).toBe("info");
    expect(ghPrIssueComments).toHaveBeenCalledTimes(1);

    // Switching PR while still on "info": the tab never changes, the PR does.
    await p.selectPr({ number: 2 } as any);
    await Promise.resolve();
    expect(ghPrIssueComments).toHaveBeenCalledTimes(2);
  });

  it("a stale issue-comments response never lands on the next PR", async () => {
    let resolveA!: (v: unknown) => void;
    ghPrIssueComments.mockImplementation((_cwd: unknown, n: unknown) =>
      n === 1
        ? new Promise((r) => { resolveA = r; })
        : Promise.resolve([{ id: 2, body: "from B" }]),
    );
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);
    await Promise.resolve();
    expect(ghPrIssueComments).toHaveBeenCalledTimes(1); // A in flight

    await p.selectPr({ number: 2 } as any);
    await Promise.resolve();
    expect(ghPrIssueComments).toHaveBeenCalledTimes(2); // B not blocked by A's flight

    resolveA([{ id: 1, body: "from A" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.prIssueComments.value).toEqual([{ id: 2, body: "from B" }]);
  });

  it("switching to the checks tab loads CI checks exactly once", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);

    p.detailTab.value = "checks";
    await Promise.resolve();
    await Promise.resolve();
    expect(ghPrChecks).toHaveBeenCalledTimes(1);

    p.detailTab.value = "info";
    await Promise.resolve();
    p.detailTab.value = "checks";
    await Promise.resolve();
    await Promise.resolve();
    expect(ghPrChecks).toHaveBeenCalledTimes(1); // still once — cached
  });

  it("switching to the info tab loads issue comments exactly once", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);

    p.detailTab.value = "diff";
    await Promise.resolve();
    p.detailTab.value = "info";
    await Promise.resolve();
    await Promise.resolve();
    expect(ghPrIssueComments).toHaveBeenCalledTimes(1);

    p.detailTab.value = "diff";
    await Promise.resolve();
    p.detailTab.value = "info";
    await Promise.resolve();
    await Promise.resolve();
    expect(ghPrIssueComments).toHaveBeenCalledTimes(1);
  });

  it("switching to the intelligence tab loads the repo file count exactly once", async () => {
    const p = usePrPanel(ref("/repo"));
    await p.selectPr({ number: 1 } as any);

    p.detailTab.value = "intelligence";
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(gitFileCount).toHaveBeenCalledTimes(1);
    expect(p.totalRepoFiles.value).toBe(0);
  });
});
